import type { ReconcileDecisionPayload, RecoveryReportPayload } from '@rbo/protocol';
import { createLogger, generateId, processIdentityFromPid } from '@rbo/shared';
import type { WebSocket } from 'ws';
import { getAgentLastBootId } from '../agents/registry.js';
import { clearArtifactExpectations } from '../http/data-plane.js';
import {
  ATTEMPT_OUTCOME_LOST,
  ATTEMPT_STATE_ORPHANED,
  type AttemptRow,
  getAttempt,
  getJob,
  getJobRequest,
  recordArtifactCollectionInterruption,
  recordRemoteProcessExit,
  runLifecycleTransaction,
  transitionAttemptState,
  transitionJobState,
  updateAttempt,
} from '../jobs/lifecycle.js';
import type { ControllerDatabase } from '../storage/database.js';
import { nowIso } from '../storage/database.js';
import type { ConnectedAgent } from '../websocket/server.js';

const logger = createLogger('controller.recovery');

export const DEFAULT_DISCONNECT_GRACE_SECONDS = 60;
export const DEFAULT_ORPHAN_TIMEOUT_SECONDS = 300;
export const DEFAULT_RECONCILE_DEADLINE_SECONDS = 120;

function hasExitedForArtifactCollection(attempt: Pick<AttemptRow, 'state' | 'outcome'>): boolean {
  return (
    attempt.outcome !== null &&
    ['collecting_artifacts', ATTEMPT_STATE_ORPHANED].includes(attempt.state)
  );
}

function canRecoverUnrecordedExit(attempt: AttemptRow): boolean {
  return (
    attempt.outcome === null &&
    (attempt.state === 'running' || attempt.state === ATTEMPT_STATE_ORPHANED)
  );
}

/** An interrupted transfer cannot replace the already recorded process result. */
export function finalizeInterruptedArtifactCollection(
  db: ControllerDatabase,
  attempt: Pick<AttemptRow, 'id' | 'job_id' | 'state' | 'outcome'>,
): boolean {
  if (!attempt.outcome || !hasExitedForArtifactCollection(attempt)) {
    return false;
  }
  const outcome = attempt.outcome;
  const finished = nowIso();
  runLifecycleTransaction(db, () => {
    const exitCode = getJob(db, attempt.job_id)?.exit_code ?? null;
    if (getJobRequest(db, attempt.job_id)?.artifacts?.length) {
      recordArtifactCollectionInterruption(db, attempt.id);
    }
    transitionAttemptState(db, attempt.id, 'completed', { outcome, finished_at: finished });
    transitionJobState(db, attempt.job_id, 'completed', {
      outcome,
      finished_at: finished,
      result_json: JSON.stringify({ outcome, exit_code: exitCode }),
    });
  });
  clearArtifactExpectations(attempt.id);
  logger.warn('artifact collection ended before recovery completed', { attemptId: attempt.id });
  return true;
}

export interface RecoveryCoordinatorOptions {
  db: ControllerDatabase;
  connectedAgents: Map<string, ConnectedAgent>;
  disconnectGraceSeconds?: number;
  orphanTimeoutSeconds?: number;
  reconcileDeadlineSeconds?: number;
  /** Injectable timers for tests. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

/**
 * Owns disconnect grace → orphan → adopt / terminate_stale / lost decisions.
 * WebSocket handlers must call into this coordinator rather than failing attempts inline.
 */
export class RecoveryCoordinator {
  private readonly db: ControllerDatabase;
  private readonly connectedAgents: Map<string, ConnectedAgent>;
  private readonly graceSeconds: number;
  private readonly orphanSeconds: number;
  private readonly reconcileSeconds: number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly orphanTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly reconcileTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly restartExitDeadlines = new Map<string, number>();

  constructor(options: RecoveryCoordinatorOptions) {
    this.db = options.db;
    this.connectedAgents = options.connectedAgents;
    this.graceSeconds = options.disconnectGraceSeconds ?? DEFAULT_DISCONNECT_GRACE_SECONDS;
    this.orphanSeconds = options.orphanTimeoutSeconds ?? DEFAULT_ORPHAN_TIMEOUT_SECONDS;
    this.reconcileSeconds = options.reconcileDeadlineSeconds ?? DEFAULT_RECONCILE_DEADLINE_SECONDS;
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  }

  dispose(): void {
    for (const t of this.graceTimers.values()) {
      this.clearTimeoutFn(t);
    }
    for (const t of this.orphanTimers.values()) {
      this.clearTimeoutFn(t);
    }
    for (const t of this.reconcileTimers.values()) {
      this.clearTimeoutFn(t);
    }
    this.graceTimers.clear();
    this.orphanTimers.clear();
    this.reconcileTimers.clear();
    this.restartExitDeadlines.clear();
  }

  /**
   * After Controller process start: wait for Agent recovery_report per non-terminal attempt.
   * Missing report by deadline → outcome=lost.
   */
  onControllerStartup(): void {
    const updated = this.db
      .prepare("UPDATE agents SET state = 'offline' WHERE state NOT IN ('offline', 'revoked')")
      .run();
    if (updated.changes > 0) {
      logger.info('reset stale agent states to offline on startup', { count: updated.changes });
    }

    this.finishJobsWithCompletedAttempts();
    const rows = this.db
      .prepare(
        `SELECT id, state, outcome, lease_deadline FROM job_attempts WHERE state <> 'completed'`,
      )
      .all() as Array<Pick<AttemptRow, 'id' | 'state' | 'outcome' | 'lease_deadline'>>;

    const reconcileDeadline = new Date(Date.now() + this.reconcileSeconds * 1000).toISOString();
    for (const row of rows) {
      // Startup reconciliation may outlast the previous Controller's lease.
      // Extending a recorded exit can only restore artifact transfer authority.
      if (
        hasExitedForArtifactCollection(row) &&
        (row.lease_deadline === null || row.lease_deadline < reconcileDeadline)
      ) {
        updateAttempt(this.db, row.id, { lease_deadline: reconcileDeadline });
      }
      this.armReconcileDeadline(row.id);
    }
    logger.info('recovery coordinator armed reconcile deadlines', { count: rows.length });
  }

  private finishJobsWithCompletedAttempts(): void {
    // Older Controllers could stop after persisting the attempt but before finalizing its job.
    const rows = this.db
      .prepare(
        `SELECT jobs.id, jobs.state, jobs.exit_code, jobs.failure_category, jobs.failure_message,
                attempts.outcome, attempts.finished_at
         FROM jobs JOIN job_attempts AS attempts ON attempts.id = (
           SELECT id FROM job_attempts WHERE job_id = jobs.id ORDER BY ordinal DESC LIMIT 1
         )
         WHERE jobs.state IN ('leasing', 'leased', 'preparing_source', 'transferring_source',
                              'materializing', 'starting', 'running', 'orphaned',
                              'collecting_artifacts', 'cleaning')
           AND attempts.agent_id IS NOT NULL AND attempts.state = 'completed'
           AND attempts.outcome IS NOT NULL`,
      )
      .all() as Array<{
      id: string;
      state: string;
      exit_code: number | null;
      failure_category: string | null;
      failure_message: string | null;
      outcome: string;
      finished_at: string | null;
    }>;
    for (const {
      id,
      state,
      exit_code,
      failure_category,
      failure_message,
      outcome,
      finished_at,
    } of rows) {
      const hadProcessResult = state === 'collecting_artifacts' || state === 'cleaning';
      transitionJobState(this.db, id, 'completed', {
        outcome,
        finished_at: finished_at ?? nowIso(),
        result_json: JSON.stringify({ outcome, exit_code }),
        failure_category: hadProcessResult
          ? failure_category
          : (failure_category ?? 'agent_disconnected'),
        failure_message: hadProcessResult
          ? failure_message
          : (failure_message ?? 'Remote attempt ended before the Controller finalized its job'),
      });
    }
  }

  /**
   * Agent WS closed. Pre-job_started attempts fail immediately (no auto-retry).
   * Post-start attempts (running / collecting_artifacts / known process) enter grace.
   * Missing process_identity alone is not enough for pre-start fail — avoid races
   * where job_started has moved state to running before process_identity is persisted.
   */
  onAgentDisconnect(agentId: string): void {
    const attempts = this.db
      .prepare(
        `SELECT id, job_id, state, process_identity, lease_deadline FROM job_attempts
         WHERE agent_id = ? AND state NOT IN ('completed')`,
      )
      .all(agentId) as Array<{
      id: string;
      job_id: string;
      state: string;
      process_identity: string | null;
      lease_deadline: string | null;
    }>;

    for (const att of attempts) {
      if (isPreStartDisconnect(att.state, att.process_identity)) {
        // Pre-script-start: mark lost/failed; never spawn a replacement attempt.
        this.markPreStartLost(att.id, att.job_id);
        continue;
      }

      // Keep a valid lease alive through grace/orphan windows. A disconnect
      // cannot reopen an already expired lease.
      const extendMs = (this.graceSeconds + this.orphanSeconds + 30) * 1000;
      const now = Date.now();
      const leaseDeadline = Date.parse(att.lease_deadline ?? '');
      if (leaseDeadline > now && leaseDeadline < now + extendMs) {
        updateAttempt(this.db, att.id, { lease_deadline: new Date(now + extendMs).toISOString() });
      }

      this.clearTimer(this.graceTimers, att.id);
      const timer = this.setTimeoutFn(() => {
        this.graceTimers.delete(att.id);
        this.onGraceElapsed(att.id);
      }, this.graceSeconds * 1000);
      this.graceTimers.set(att.id, timer);
      logger.info('disconnect grace armed', {
        attemptId: att.id,
        agentId,
        graceSeconds: this.graceSeconds,
      });
    }
  }

  /**
   * Agent (re)connected and reported a `boot_id` (process marker). When it differs from the last
   * known value the Agent process restarted. Attempts that were still executing are lost;
   * completed processes can recover artifact transfers from persisted staging.
   * A declared pending exit reserves a bounded window for its artifact-only report.
   * A matching or absent boot_id leaves attempts untouched.
   *
   * `updateAgentCapabilities` (called by the WS layer right after this) persists the new boot_id.
   */
  onAgentConnect(
    agentId: string,
    bootId: string | undefined,
    pendingProcessExitAttemptIds: string[] = [],
  ): void {
    if (bootId === undefined) {
      // Older Agent without boot_id: no restart detection (grace/orphan timers remain as fallback).
      return;
    }
    const lastBootId = getAgentLastBootId(this.db, agentId);
    if (lastBootId === bootId) {
      // Same process — network reconnect with a live executor. Attempts stay untouched.
      return;
    }

    const attempts = this.db
      .prepare(
        `SELECT id, job_id, state FROM job_attempts
         WHERE agent_id = ? AND state NOT IN ('completed')`,
      )
      .all(agentId) as Array<{ id: string; job_id: string; state: string }>;

    const pendingExits = new Set(pendingProcessExitAttemptIds);
    let swept = 0;
    for (const att of attempts) {
      const attempt = getAttempt(this.db, att.id);
      if (attempt && attempt.state !== 'completed') {
        if (
          hasExitedForArtifactCollection(attempt) &&
          Date.parse(attempt.lease_deadline ?? '') > Date.now()
        ) {
          this.clearAllTimersFor(attempt.id);
          this.armReconcileDeadline(attempt.id);
          continue;
        }
        const leaseDeadline = Date.parse(attempt.lease_deadline ?? '');
        if (
          pendingExits.has(attempt.id) &&
          canRecoverUnrecordedExit(attempt) &&
          leaseDeadline > Date.now()
        ) {
          const deadline = Math.min(
            leaseDeadline,
            Date.now() + this.reconcileSeconds * 1000,
            this.restartExitDeadlines.get(attempt.id) ?? Number.POSITIVE_INFINITY,
          );
          this.clearAllTimersFor(attempt.id);
          this.restartExitDeadlines.set(attempt.id, deadline);
          this.armReconcileDeadline(attempt.id, deadline - Date.now());
          continue;
        }
        this.markLost(attempt);
        swept++;
      }
    }

    logger.info('agent restart detected, swept leaked attempts', {
      agentId,
      swept,
      bootId,
      lastBootId,
    });
  }

  onGraceElapsed(attemptId: string): void {
    const attempt = getAttempt(this.db, attemptId);
    if (!attempt || attempt.state === 'completed') {
      return;
    }
    const orphanedAt = nowIso();
    updateAttempt(this.db, attemptId, {
      state: ATTEMPT_STATE_ORPHANED,
      orphaned_at: orphanedAt,
    });
    logger.info('attempt orphaned after grace', { attemptId, orphanedAt });

    this.clearTimer(this.orphanTimers, attemptId);
    const timer = this.setTimeoutFn(() => {
      this.orphanTimers.delete(attemptId);
      this.onOrphanTimeout(attemptId);
    }, this.orphanSeconds * 1000);
    this.orphanTimers.set(attemptId, timer);
  }

  onOrphanTimeout(attemptId: string): void {
    const attempt = getAttempt(this.db, attemptId);
    if (!attempt || attempt.state === 'completed') {
      return;
    }
    if (attempt.state !== ATTEMPT_STATE_ORPHANED) {
      return;
    }
    this.markLost(attempt);
  }

  /**
   * Authenticated Agent recovery_report. Returns the decision payload (also sent on WS).
   */
  onRecoveryReport(agentId: string, payload: RecoveryReportPayload): ReconcileDecisionPayload {
    const attempt = getAttempt(this.db, payload.attempt_id);
    const restartDeadline = this.restartExitDeadlines.get(payload.attempt_id);
    const ownsLease =
      attempt?.agent_id === agentId &&
      attempt.lease_id === payload.lease_id &&
      attempt.lease_epoch === payload.lease_epoch;
    const leaseIsLive = Date.parse(attempt?.lease_deadline ?? '') > Date.now();

    // Live recovery still requires job_started to have persisted a process identity.
    if (
      attempt &&
      ownsLease &&
      leaseIsLive &&
      attempt.state !== 'completed' &&
      !attempt.process_identity &&
      payload.status !== 'completed_awaiting_upload' &&
      !hasExitedForArtifactCollection(attempt) &&
      restartDeadline === undefined
    ) {
      this.clearAllTimersFor(attempt.id);
      updateAttempt(this.db, attempt.id, { last_reconcile_at: nowIso() });
      this.rearmOrphanWatchdog(attempt.id);
      logger.info('recovery_report deferred pending process_identity', {
        attemptId: attempt.id,
        agentId,
      });
      return {
        attempt_id: payload.attempt_id,
        lease_id: payload.lease_id,
        lease_epoch: payload.lease_epoch,
        action: 'terminate_stale',
        reason: 'process_identity_pending',
      };
    }

    const decision = this.decide(agentId, attempt, payload, restartDeadline);

    if (decision.action === 'adopt' && attempt) {
      const artifactOnly = payload.status === 'completed_awaiting_upload';
      if (artifactOnly && payload.process_exit) {
        recordRemoteProcessExit(this.db, attempt, payload.process_exit);
      }
      updateAttempt(this.db, attempt.id, {
        state: artifactOnly ? 'collecting_artifacts' : 'running',
        orphaned_at: null,
        last_reconcile_at: nowIso(),
        ...(artifactOnly ? {} : { process_identity: payload.process_identity }),
      });
      this.clearAllTimersFor(attempt.id);
      logger.info('attempt adopted', {
        attemptId: attempt.id,
        agentId,
        resume_from_sequence: decision.resume_from_sequence,
      });
    } else if (decision.action === 'terminate_stale') {
      logger.info('terminate_stale issued', {
        attemptId: payload.attempt_id,
        agentId,
        reason: decision.reason,
      });
      if (
        attempt &&
        attempt.state !== 'completed' &&
        ownsLease &&
        leaseIsLive &&
        decision.reason !== 'lease_expired'
      ) {
        this.markTerminateStaleFailed(attempt, decision.reason);
      }
    }

    this.sendReconcileDecision(agentId, decision);
    return decision;
  }

  private decide(
    agentId: string,
    attempt: AttemptRow | null,
    payload: RecoveryReportPayload,
    restartDeadline: number | undefined,
  ): ReconcileDecisionPayload {
    if (!attempt || attempt.state === 'completed') {
      return {
        attempt_id: payload.attempt_id,
        lease_id: payload.lease_id,
        lease_epoch: payload.lease_epoch,
        action: 'terminate_stale',
        reason: 'attempt_terminal_or_unknown',
      };
    }

    if (attempt.agent_id !== agentId) {
      return {
        attempt_id: payload.attempt_id,
        lease_id: payload.lease_id,
        lease_epoch: payload.lease_epoch,
        action: 'terminate_stale',
        reason: 'agent_mismatch',
      };
    }

    if (attempt.lease_id !== payload.lease_id || attempt.lease_epoch !== payload.lease_epoch) {
      return {
        attempt_id: payload.attempt_id,
        lease_id: payload.lease_id,
        lease_epoch: payload.lease_epoch,
        action: 'terminate_stale',
        reason: attempt.lease_epoch !== payload.lease_epoch ? 'newer_epoch' : 'lease_mismatch',
      };
    }

    const artifactOnly = payload.status === 'completed_awaiting_upload';
    const exited = hasExitedForArtifactCollection(attempt);
    let reason: string | undefined;
    if (artifactOnly) {
      const deadline = Math.min(
        Date.parse(attempt.lease_deadline ?? ''),
        restartDeadline ?? Number.POSITIVE_INFINITY,
      );
      if (
        !exited &&
        (!payload.process_exit ||
          !payload.artifact_upload_pending ||
          !canRecoverUnrecordedExit(attempt) ||
          getJob(this.db, attempt.job_id)?.state !== 'running')
      ) {
        reason = 'process_exit_not_recorded';
      } else if (!(deadline > Date.now())) {
        reason = 'lease_expired';
      } else if (
        !exited &&
        attempt.process_identity &&
        attempt.process_identity !== payload.process_identity
      ) {
        reason = 'process_identity_mismatch';
      }
    } else if (restartDeadline !== undefined) {
      reason = 'agent_restarted';
    } else if (exited) {
      reason = 'process_already_exited';
    } else if (!(Date.parse(attempt.lease_deadline ?? '') > Date.now())) {
      reason = 'lease_expired';
    } else if (attempt.process_identity !== payload.process_identity) {
      reason = 'process_identity_mismatch';
    }
    if (reason) {
      return {
        attempt_id: attempt.id,
        lease_id: attempt.lease_id,
        lease_epoch: attempt.lease_epoch,
        action: 'terminate_stale',
        reason,
      };
    }

    return {
      attempt_id: attempt.id,
      lease_id: attempt.lease_id,
      lease_epoch: attempt.lease_epoch,
      action: 'adopt',
      resume_from_sequence: attempt.log_acked_sequence,
    };
  }

  private armReconcileDeadline(attemptId: string, delayMs = this.reconcileSeconds * 1000): void {
    this.clearTimer(this.reconcileTimers, attemptId);
    const timer = this.setTimeoutFn(() => {
      this.reconcileTimers.delete(attemptId);
      const attempt = getAttempt(this.db, attemptId);
      if (!attempt || attempt.state === 'completed') {
        return;
      }
      this.markLost(attempt);
    }, delayMs);
    this.reconcileTimers.set(attemptId, timer);
  }

  private markPreStartLost(attemptId: string, jobId: string): void {
    const finished = nowIso();
    // Phase 3 forbade auto-retry: fail without requeue / new attempt.
    runLifecycleTransaction(this.db, () => {
      transitionAttemptState(this.db, attemptId, 'completed', {
        outcome: 'failed',
        finished_at: finished,
      });
      transitionJobState(this.db, jobId, 'completed', {
        outcome: 'failed',
        finished_at: finished,
        failure_category: 'agent_disconnected',
        failure_message: 'Agent disconnected before script start',
      });
    });
    this.clearAllTimersFor(attemptId);
    logger.info('pre-start disconnect marked failed', { attemptId, jobId });
  }

  /**
   * End the current lease when its owner's recovery report cannot be accepted.
   */
  private markTerminateStaleFailed(attempt: AttemptRow, reason: string | undefined): void {
    if (finalizeInterruptedArtifactCollection(this.db, attempt)) {
      this.clearAllTimersFor(attempt.id);
      return;
    }
    const finished = nowIso();
    const failureCategory = 'agent_lost';
    const failureMessage = `Stale recovery_report rejected (${reason ?? 'terminate_stale'})`;
    runLifecycleTransaction(this.db, () => {
      transitionAttemptState(this.db, attempt.id, 'completed', {
        outcome: 'failed',
        finished_at: finished,
      });
      updateAttempt(this.db, attempt.id, {
        orphaned_at: null,
        last_reconcile_at: finished,
      });
      transitionJobState(this.db, attempt.job_id, 'completed', {
        outcome: 'failed',
        finished_at: finished,
        failure_category: failureCategory,
        failure_message: failureMessage,
      });
    });
    this.clearAllTimersFor(attempt.id);
    logger.info('terminate_stale marked attempt failed', {
      attemptId: attempt.id,
      reason,
      failureCategory,
    });
  }

  /** Re-arm orphan timeout after a non-owning terminate_stale cleared timers. */
  private rearmOrphanWatchdog(attemptId: string): void {
    const attempt = getAttempt(this.db, attemptId);
    if (!attempt || attempt.state === 'completed') {
      return;
    }
    if (attempt.state === ATTEMPT_STATE_ORPHANED) {
      this.clearTimer(this.orphanTimers, attemptId);
      const timer = this.setTimeoutFn(() => {
        this.orphanTimers.delete(attemptId);
        this.onOrphanTimeout(attemptId);
      }, this.orphanSeconds * 1000);
      this.orphanTimers.set(attemptId, timer);
      return;
    }
    // Still in grace window — re-arm grace.
    this.clearTimer(this.graceTimers, attemptId);
    const timer = this.setTimeoutFn(() => {
      this.graceTimers.delete(attemptId);
      this.onGraceElapsed(attemptId);
    }, this.graceSeconds * 1000);
    this.graceTimers.set(attemptId, timer);
  }

  private markLost(attempt: AttemptRow): void {
    if (finalizeInterruptedArtifactCollection(this.db, attempt)) {
      this.clearAllTimersFor(attempt.id);
      return;
    }
    const finished = nowIso();
    runLifecycleTransaction(this.db, () => {
      transitionAttemptState(this.db, attempt.id, 'completed', {
        outcome: ATTEMPT_OUTCOME_LOST,
        finished_at: finished,
      });
      transitionJobState(this.db, attempt.job_id, 'completed', {
        outcome: ATTEMPT_OUTCOME_LOST,
        finished_at: finished,
        failure_category: 'agent_disconnected',
        failure_message: 'Attempt lost during disconnect / restart reconciliation',
      });
    });
    this.clearAllTimersFor(attempt.id);
    logger.info('attempt marked lost', { attemptId: attempt.id });
  }

  private clearAllTimersFor(attemptId: string): void {
    this.restartExitDeadlines.delete(attemptId);
    this.clearTimer(this.graceTimers, attemptId);
    this.clearTimer(this.orphanTimers, attemptId);
    this.clearTimer(this.reconcileTimers, attemptId);
  }

  private clearTimer(map: Map<string, ReturnType<typeof setTimeout>>, attemptId: string): void {
    const existing = map.get(attemptId);
    if (existing) {
      this.clearTimeoutFn(existing);
      map.delete(attemptId);
    }
  }

  private sendReconcileDecision(agentId: string, decision: ReconcileDecisionPayload): void {
    const conn = this.connectedAgents.get(agentId);
    if (!conn || conn.socket.readyState !== conn.socket.OPEN) {
      return;
    }
    sendWsFrame(
      conn.socket,
      'reconcile_decision',
      decision.attempt_id,
      decision.lease_id,
      decision.lease_epoch,
      decision as unknown as Record<string, unknown>,
    );
  }
}

function sendWsFrame(
  socket: WebSocket,
  type: string,
  attemptId: string,
  leaseId: string,
  leaseEpoch: number,
  payload: Record<string, unknown>,
): void {
  if (socket.readyState !== socket.OPEN) {
    return;
  }
  socket.send(
    JSON.stringify({
      protocol: 1,
      type,
      message_id: generateId('msg'),
      sent_at: new Date().toISOString(),
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: leaseEpoch,
      payload,
    }),
  );
}

export { processIdentityFromPid } from '@rbo/shared';

/** True when job risk_level is destructive or hardware (Agent self-terminates at lease expiry). */
export function isDestructiveOrHardwareRisk(db: ControllerDatabase, jobId: string): boolean {
  const request = getJobRequest(db, jobId);
  const risk = request?.risk_level ?? 'normal';
  return risk === 'destructive' || risk === 'hardware';
}

const PRE_START_ATTEMPT_STATES = new Set([
  'leasing',
  'preparing_source',
  'transferring_source',
  'materializing',
  'starting',
]);

const POST_START_ATTEMPT_STATES = new Set([
  'running',
  'collecting_artifacts',
  ATTEMPT_STATE_ORPHANED,
]);

/**
 * Pre-start fail only when both process_identity is missing AND state is still
 * in a pre-script-start phase. running/collecting_artifacts without identity
 * is treated as post-start (job_started race).
 */
export function isPreStartDisconnect(
  state: string,
  processIdentity: string | null | undefined,
): boolean {
  if (POST_START_ATTEMPT_STATES.has(state)) {
    return false;
  }
  return !processIdentity && PRE_START_ATTEMPT_STATES.has(state);
}
