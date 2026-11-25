import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { openAttemptSpool, readAck } from '@rbo/executor';
import type { ReconcileDecisionPayload, RecoveryReportPayload } from '@rbo/protocol';
import { createLogger, generateId } from '@rbo/shared';
import type { WebSocket } from 'ws';
import { SpoolSender } from '../logs/spool-sender.js';
import {
  type AttemptMetadata,
  listAttemptMetadata,
  readAttemptMetadata,
  removeAttemptMetadata,
  writeAttemptMetadata,
} from './attempt-metadata.js';

const logger = createLogger('agent.recovery');

function hasProcessIdentity(identity: string | null | undefined): identity is string {
  return typeof identity === 'string' && identity.trim().length > 0;
}

export interface AgentRecoveryHooks {
  /** Kill process tree for an attempt (if still held in-process). */
  terminateAttempt: (attemptId: string) => Promise<void>;
  /** Re-bind spool sender send fn after adopt (optional live attempt). */
  onAdopted?: (decision: ReconcileDecisionPayload, meta: AttemptMetadata) => Promise<void>;
  /** Re-send job_exit when local process already completed before reconnect. */
  resendJobExit?: (meta: AttemptMetadata) => void;
  /** Authorize a live attempt to transfer artifacts on the adopted connection. */
  authorizeArtifactUpload?: (attemptId: string, socket: WebSocket) => void;
  /** Resume artifact_manifest + PUT from persisted staging (never re-collect). */
  resumeArtifactUpload?: (meta: AttemptMetadata) => Promise<void>;
  /**
   * Label-scoped resource cleanup (e.g. Docker `rbo.attempt=<id>`) after
   * terminate_stale or verified orphan cleanup. Must be idempotent.
   */
  cleanupAttemptResources?: (attemptId: string) => Promise<void>;
}

export interface AgentRecoveryCoordinatorOptions {
  stateDir: string;
  hooks: AgentRecoveryHooks;
}

/**
 * Agent-side recovery: persist metadata, emit recovery_report on (re)connect,
 * honor reconcile_decision (adopt → spool replay; terminate_stale → kill/clean).
 */
export class AgentRecoveryCoordinator {
  private readonly stateDir: string;
  private readonly hooks: AgentRecoveryHooks;
  private socket: WebSocket | null = null;
  private reportingSocket: WebSocket | null = null;
  /** Attempts told to terminate_stale — reject further frames. */
  private readonly rejectedAttempts = new Set<string>();
  private readonly liveSenders = new Map<string, SpoolSender>();

  constructor(options: AgentRecoveryCoordinatorOptions) {
    this.stateDir = options.stateDir;
    this.hooks = options.hooks;
  }

  attachSocket(socket: WebSocket): void {
    this.socket = socket;
  }

  detachSocket(): void {
    this.socket = null;
    this.reportingSocket = null;
  }

  isRejected(attemptId: string): boolean {
    return this.rejectedAttempts.has(attemptId);
  }

  registerLiveSender(attemptId: string, sender: SpoolSender): void {
    this.liveSenders.set(attemptId, sender);
  }

  clearLiveSender(attemptId: string): void {
    this.liveSenders.delete(attemptId);
  }

  persist(meta: AttemptMetadata): void {
    writeAttemptMetadata(this.stateDir, meta);
  }

  getMetadata(attemptId: string): AttemptMetadata | null {
    return readAttemptMetadata(this.stateDir, attemptId);
  }

  /**
   * After authenticated session: scan disk metadata and emit recovery_report for
   * each non-terminal attempt. Replay happens only after adopt.
   */
  async reportAll(beforeReports?: (pendingProcessExitAttemptIds: string[]) => void): Promise<void> {
    const socket = this.socket;
    const all = await listAttemptMetadata(this.stateDir, { requireReadable: true });
    if (this.socket !== socket || !socket || socket.readyState !== socket.OPEN) {
      return;
    }
    beforeReports?.(
      all
        .filter((meta) => meta.status === 'completed_awaiting_upload' && meta.last_exit)
        .map((meta) => meta.attempt_id),
    );
    this.reportingSocket = socket;
    for (const meta of all) {
      if (this.socket !== socket || socket.readyState !== socket.OPEN) {
        return;
      }
      await this.emitRecoveryReport(meta, socket);
    }
  }

  async reportCompletedAttempt(attemptId: string): Promise<void> {
    const socket = this.reportingSocket;
    const meta = readAttemptMetadata(this.stateDir, attemptId);
    if (
      socket &&
      socket === this.socket &&
      socket.readyState === socket.OPEN &&
      meta?.status === 'completed_awaiting_upload'
    ) {
      await this.emitRecoveryReport(meta, socket);
    }
  }

  private async emitRecoveryReport(saved: AttemptMetadata, socket: WebSocket): Promise<void> {
    if (saved.status === 'terminal') {
      return;
    }
    let lastAcked = 0;
    let lastSent = 0;
    try {
      const spool = await openAttemptSpool(saved.spool_dir);
      lastAcked = await readAck(spool);
      lastSent = lastAcked;
      // Approximate last_sent from ack; live sender may know more.
      const live = this.liveSenders.get(saved.attempt_id);
      if (live) {
        lastAcked = Math.max(lastAcked, live.lastAckedSequence);
      }
    } catch {
      // Spool may not exist yet
    }

    // The job may have completed while the spool was being read.
    const meta = readAttemptMetadata(this.stateDir, saved.attempt_id);
    if (
      !meta ||
      meta.status === 'terminal' ||
      this.isRejected(saved.attempt_id) ||
      this.socket !== socket ||
      socket.readyState !== socket.OPEN
    ) {
      return;
    }
    const exit = meta.status === 'completed_awaiting_upload' ? meta.last_exit : undefined;
    const processIdentity = hasProcessIdentity(meta.process_identity)
      ? meta.process_identity
      : exit
        ? 'unavailable'
        : null;
    if (!processIdentity) {
      if (this.liveSenders.has(meta.attempt_id)) {
        // A live run without a process identity can still report its durable exit.
        return;
      }
      // Pre-spawn leftovers cannot be fenced for live recovery.
      await this.discardUnfencedLeftover(meta);
      return;
    }

    const status: RecoveryReportPayload['status'] =
      meta.status === 'completed_awaiting_upload'
        ? 'completed_awaiting_upload'
        : meta.status === 'orphaned'
          ? 'orphaned'
          : 'running';

    const payload: RecoveryReportPayload = {
      attempt_id: meta.attempt_id,
      lease_id: meta.lease_id,
      lease_epoch: meta.lease_epoch,
      status,
      process_identity: processIdentity,
      last_sent_sequence: lastSent,
      last_acked_sequence: lastAcked,
      artifact_upload_pending: meta.status === 'completed_awaiting_upload',
      ...(exit ? { process_exit: exit } : {}),
    };

    this.sendJobScoped('recovery_report', meta, payload as unknown as Record<string, unknown>);
    logger.info('recovery_report sent', {
      attemptId: meta.attempt_id,
      status: payload.status,
    });
  }

  async handleReconcileDecision(decision: ReconcileDecisionPayload): Promise<void> {
    const meta = readAttemptMetadata(this.stateDir, decision.attempt_id);
    const socket = this.socket;
    if (
      meta &&
      (meta.lease_id !== decision.lease_id || meta.lease_epoch !== decision.lease_epoch)
    ) {
      return;
    }
    if (decision.action === 'terminate_stale') {
      this.rejectedAttempts.add(decision.attempt_id);
      await this.hooks.terminateAttempt(decision.attempt_id);
      // Verified orphan / stale cleanup: label-scoped resources (Docker, etc.).
      await this.invokeCleanupAttemptResources(decision.attempt_id);
      if (meta) {
        writeAttemptMetadata(this.stateDir, { ...meta, status: 'terminal' });
        await rm(join(this.stateDir, 'artifacts', meta.attempt_id), {
          recursive: true,
          force: true,
        }).catch((error) => {
          logger.warn('failed to remove terminal artifact staging', {
            attemptId: meta.attempt_id,
            error: String(error),
          });
        });
      }
      await removeAttemptMetadata(this.stateDir, decision.attempt_id).catch(() => undefined);
      logger.info('terminate_stale applied', {
        attemptId: decision.attempt_id,
        reason: decision.reason,
      });
      return;
    }

    // adopt
    if (!meta || !socket || socket.readyState !== socket.OPEN) {
      logger.warn('adopt for unknown metadata', { attemptId: decision.attempt_id });
      return;
    }
    const wasCompletedAwaitingUpload = meta.status === 'completed_awaiting_upload';
    writeAttemptMetadata(this.stateDir, {
      ...meta,
      status: wasCompletedAwaitingUpload
        ? 'completed_awaiting_upload'
        : decision.resume_from_sequence !== undefined
          ? 'running'
          : meta.status,
      updated_at: new Date().toISOString(),
    });

    const live = this.liveSenders.get(decision.attempt_id);
    if (live) {
      if (typeof decision.resume_from_sequence === 'number') {
        live.setAcked(decision.resume_from_sequence);
      }
      await live.startReplay();
    } else if (this.hooks.onAdopted) {
      await this.hooks.onAdopted(decision, meta);
    } else {
      // Disk-only adopt: open spool and replay via a transient sender if socket is up.
      await this.replayFromDisk(meta, decision.resume_from_sequence ?? 0);
    }

    // A live process can finish during spool replay. Replay its exit before
    // authorizing artifact traffic on this connection.
    const current = readAttemptMetadata(this.stateDir, decision.attempt_id);
    if (
      this.socket !== socket ||
      socket.readyState !== socket.OPEN ||
      !current ||
      current.status === 'terminal' ||
      current.lease_id !== decision.lease_id ||
      current.lease_epoch !== decision.lease_epoch ||
      this.isRejected(decision.attempt_id)
    ) {
      return;
    }
    const completed = current.status === 'completed_awaiting_upload';
    if (completed) {
      this.hooks.resendJobExit?.(current);
      // Fallback: emit job_exit from coordinator when no executor hook is wired.
      if (!this.hooks.resendJobExit && current.last_exit) {
        this.sendJobScoped('job_exit', current, {
          attempt_id: current.attempt_id,
          lease_id: current.lease_id,
          lease_epoch: current.lease_epoch,
          ...current.last_exit,
        });
      }
    }
    this.hooks.authorizeArtifactUpload?.(current.attempt_id, socket);
    if (completed && this.hooks.resumeArtifactUpload) {
      await this.hooks.resumeArtifactUpload(current);
    }

    logger.info('attempt adopted; spool replay started', {
      attemptId: decision.attempt_id,
      resume_from_sequence: decision.resume_from_sequence,
      completed_awaiting_upload: completed,
    });
  }

  /**
   * Verified orphan cleanup path: invoke optional label-scoped resource cleanup.
   * Safe to call repeatedly (hook + Docker helpers are idempotent).
   */
  async cleanupVerifiedOrphan(attemptId: string): Promise<void> {
    await this.invokeCleanupAttemptResources(attemptId);
  }

  /**
   * Local-only cleanup for attempts that never got a process identity.
   * Mirrors terminate_stale disk hygiene without sending an invalid recovery_report.
   */
  private async discardUnfencedLeftover(meta: AttemptMetadata): Promise<void> {
    logger.info('discarding leftover attempt without process_identity', {
      attemptId: meta.attempt_id,
      status: meta.status,
    });
    this.rejectedAttempts.add(meta.attempt_id);
    await this.hooks.terminateAttempt(meta.attempt_id);
    await this.invokeCleanupAttemptResources(meta.attempt_id);
    writeAttemptMetadata(this.stateDir, {
      ...meta,
      status: 'terminal',
      updated_at: new Date().toISOString(),
    });
    await removeAttemptMetadata(this.stateDir, meta.attempt_id).catch(() => undefined);
  }

  private async invokeCleanupAttemptResources(attemptId: string): Promise<void> {
    if (!this.hooks.cleanupAttemptResources) {
      return;
    }
    try {
      await this.hooks.cleanupAttemptResources(attemptId);
    } catch (error) {
      logger.warn('cleanupAttemptResources failed', {
        attemptId,
        error: String(error),
      });
    }
  }

  /**
   * On WS disconnect: keep safe/normal (and destructive until lease expiry) alive.
   * Mark metadata orphaned after caller decides; do not kill here.
   */
  onDisconnectPark(attemptId: string | null): void {
    if (!attemptId) {
      return;
    }
    const meta = readAttemptMetadata(this.stateDir, attemptId);
    if (!meta || meta.status === 'terminal') {
      return;
    }
    if (meta.risk_level === 'destructive' || meta.risk_level === 'hardware') {
      // Lease-expiry self-termination is owned by AgentJobExecutor lease timer.
      writeAttemptMetadata(this.stateDir, {
        ...meta,
        status: meta.status === 'completed_awaiting_upload' ? meta.status : 'orphaned',
        updated_at: new Date().toISOString(),
      });
      return;
    }
    writeAttemptMetadata(this.stateDir, {
      ...meta,
      status: meta.status === 'completed_awaiting_upload' ? meta.status : 'orphaned',
      updated_at: new Date().toISOString(),
    });
  }

  private async replayFromDisk(meta: AttemptMetadata, resumeFrom: number): Promise<void> {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) {
      return;
    }
    const spool = await openAttemptSpool(meta.spool_dir);
    const sender = new SpoolSender({
      maxQueue: 64,
      getSpool: () => spool,
      send: (chunk) => {
        if (!this.socket || this.socket.readyState !== this.socket.OPEN) {
          return false;
        }
        this.sendJobScoped('log_chunk', meta, {
          attempt_id: meta.attempt_id,
          lease_id: meta.lease_id,
          lease_epoch: meta.lease_epoch,
          stream: chunk.stream,
          sequence: chunk.sequence,
          bytes: chunk.bytes,
        });
        return true;
      },
    });
    sender.setAcked(resumeFrom);
    this.liveSenders.set(meta.attempt_id, sender);
    await sender.startReplay();
  }

  private sendJobScoped(
    type: string,
    meta: Pick<AttemptMetadata, 'attempt_id' | 'lease_id' | 'lease_epoch'>,
    payload: Record<string, unknown>,
  ): void {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) {
      return;
    }
    this.socket.send(
      JSON.stringify({
        protocol: 1,
        type,
        message_id: generateId('msg'),
        sent_at: new Date().toISOString(),
        attempt_id: meta.attempt_id,
        lease_id: meta.lease_id,
        lease_epoch: meta.lease_epoch,
        payload,
      }),
    );
  }
}
