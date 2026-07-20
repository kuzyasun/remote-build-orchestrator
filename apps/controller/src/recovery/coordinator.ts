import type { ReconcileDecisionPayload, RecoveryReportPayload } from '@rbo/protocol';
import { createLogger, generateId } from '@rbo/shared';
import type { WebSocket } from 'ws';
import {
  ATTEMPT_OUTCOME_LOST,
  ATTEMPT_STATE_ORPHANED,
  type AttemptRow,
  getAttempt,
  getJobRequest,
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
  }

  /**
   * After Controller process start: wait for Agent recovery_report per non-terminal attempt.
   * Missing report by deadline → outcome=lost.
   */
  onControllerStartup(): void {
    const rows = this.db
      .prepare(`SELECT id FROM job_attempts WHERE state NOT IN ('completed')`)
      .all() as Array<{ id: string }>;

    for (const row of rows) {
      this.armReconcileDeadline(row.id);
    }
    logger.info('recovery coordinator armed reconcile deadlines', { count: rows.length });
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
        `SELECT id, job_id, state, process_identity FROM job_attempts
         WHERE agent_id = ? AND state NOT IN ('completed')`,
      )
      .all(agentId) as Array<{
      id: string;
      job_id: string;
      state: string;
      process_identity: string | null;
    }>;

    for (const att of attempts) {
      if (isPreStartDisconnect(att.state, att.process_identity)) {
        // Pre-script-start: mark lost/failed; never spawn a replacement attempt.
        this.markPreStartLost(att.id, att.job_id);
        continue;
      }

      // Extend lease so expireStaleLeases does not race grace/orphan windows.
      const extendMs = (this.graceSeconds + this.orphanSeconds + 30) * 1000;
      const deadline = new Date(Date.now() + extendMs).toISOString();
      updateAttempt(this.db, att.id, { lease_deadline: deadline });

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
    this.clearTimer(this.reconcileTimers, payload.attempt_id);
    this.clearTimer(this.graceTimers, payload.attempt_id);
    this.clearTimer(this.orphanTimers, payload.attempt_id);

    const attempt = getAttempt(this.db, payload.attempt_id);
    const decision = this.decide(agentId, attempt, payload);
    this.sendReconcileDecision(agentId, decision);

    if (decision.action === 'adopt' && attempt) {
      const nextState =
        payload.status === 'completed_awaiting_upload' ? 'collecting_artifacts' : 'running';
      updateAttempt(this.db, attempt.id, {
        state: nextState,
        orphaned_at: null,
        last_reconcile_at: nowIso(),
        process_identity: payload.process_identity,
      });
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
      if (attempt && attempt.state !== 'completed') {
        if (decision.reason === 'agent_mismatch') {
          // Another agent owns this attempt — do not fail it; keep orphan watchdog.
          updateAttempt(this.db, attempt.id, { last_reconcile_at: nowIso() });
          this.rearmOrphanWatchdog(attempt.id);
        } else {
          this.markTerminateStaleFailed(attempt, decision.reason);
        }
      }
    }

    return decision;
  }

  private decide(
    agentId: string,
    attempt: AttemptRow | null,
    payload: RecoveryReportPayload,
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

    if (
      attempt.lease_id !== payload.lease_id ||
      attempt.lease_epoch !== payload.lease_epoch ||
      (attempt.process_identity != null && attempt.process_identity !== payload.process_identity)
    ) {
      return {
        attempt_id: payload.attempt_id,
        lease_id: payload.lease_id,
        lease_epoch: payload.lease_epoch,
        action: 'terminate_stale',
        reason:
          attempt.lease_epoch !== payload.lease_epoch
            ? 'newer_epoch'
            : attempt.lease_id !== payload.lease_id
              ? 'lease_mismatch'
              : 'process_identity_mismatch',
      };
    }

    // Controller missing process_identity (job_started race) but Agent reports one — adopt and fill.
    if (!attempt.process_identity && !payload.process_identity) {
      return {
        attempt_id: payload.attempt_id,
        lease_id: payload.lease_id,
        lease_epoch: payload.lease_epoch,
        action: 'terminate_stale',
        reason: 'process_identity_mismatch',
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

  private armReconcileDeadline(attemptId: string): void {
    this.clearTimer(this.reconcileTimers, attemptId);
    const timer = this.setTimeoutFn(() => {
      this.reconcileTimers.delete(attemptId);
      const attempt = getAttempt(this.db, attemptId);
      if (!attempt || attempt.state === 'completed') {
        return;
      }
      this.markLost(attempt);
    }, this.reconcileSeconds * 1000);
    this.reconcileTimers.set(attemptId, timer);
  }

  private markPreStartLost(attemptId: string, jobId: string): void {
    this.clearAllTimersFor(attemptId);
    const finished = nowIso();
    // Phase 3 forbade auto-retry: fail without requeue / new attempt.
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
    logger.info('pre-start disconnect marked failed', { attemptId, jobId });
  }

  /**
   * Fence mismatch / unknown claim → terminal failed so the attempt cannot sit
   * forever in orphaned after timers were cleared by onRecoveryReport.
   */
  private markTerminateStaleFailed(attempt: AttemptRow, reason: string | undefined): void {
    this.clearAllTimersFor(attempt.id);
    const finished = nowIso();
    const failureCategory = reason === 'newer_epoch' ? 'lease_expired' : 'agent_lost';
    const failureMessage =
      reason === 'newer_epoch'
        ? 'Stale recovery_report rejected (newer lease epoch)'
        : `Stale recovery_report rejected (${reason ?? 'terminate_stale'})`;
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
    this.clearAllTimersFor(attempt.id);
    const finished = nowIso();
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
    logger.info('attempt marked lost', { attemptId: attempt.id });
  }

  private clearAllTimersFor(attemptId: string): void {
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

/** True when job risk_level is destructive or hardware (Agent self-terminates at lease expiry). */
export function isDestructiveOrHardwareRisk(db: ControllerDatabase, jobId: string): boolean {
  const request = getJobRequest(db, jobId);
  const risk = request?.risk_level ?? 'normal';
  return risk === 'destructive' || risk === 'hardware';
}

/** Canonical process identity from a job_started pid. */
export function processIdentityFromPid(pid: number): string {
  return `pid:${pid}`;
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
