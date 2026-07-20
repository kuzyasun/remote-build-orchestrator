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

export interface AgentRecoveryHooks {
  /** Kill process tree for an attempt (if still held in-process). */
  terminateAttempt: (attemptId: string) => Promise<void>;
  /** Re-bind spool sender send fn after adopt (optional live attempt). */
  onAdopted?: (decision: ReconcileDecisionPayload, meta: AttemptMetadata) => Promise<void>;
  /** Re-send job_exit when local process already completed before reconnect. */
  resendJobExit?: (meta: AttemptMetadata) => void;
  /** Resume artifact_manifest + PUT from persisted staging (never re-collect). */
  resumeArtifactUpload?: (meta: AttemptMetadata) => Promise<void>;
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
  async reportAll(): Promise<void> {
    const all = await listAttemptMetadata(this.stateDir);
    for (const meta of all) {
      if (meta.status === 'terminal') {
        continue;
      }
      await this.emitRecoveryReport(meta);
    }
  }

  async emitRecoveryReport(meta: AttemptMetadata): Promise<void> {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) {
      return;
    }
    if (!meta.process_identity) {
      // Cannot fence without process identity — report as orphaned with placeholder.
      logger.warn('skipping recovery_report without process_identity', {
        attemptId: meta.attempt_id,
      });
      return;
    }

    let lastAcked = 0;
    let lastSent = 0;
    try {
      const spool = await openAttemptSpool(meta.spool_dir);
      lastAcked = await readAck(spool);
      lastSent = lastAcked;
      // Approximate last_sent from ack; live sender may know more.
      const live = this.liveSenders.get(meta.attempt_id);
      if (live) {
        lastAcked = Math.max(lastAcked, live.lastAckedSequence);
      }
    } catch {
      // Spool may not exist yet
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
      process_identity: meta.process_identity,
      last_sent_sequence: lastSent,
      last_acked_sequence: lastAcked,
      artifact_upload_pending: meta.status === 'completed_awaiting_upload',
    };

    this.sendJobScoped('recovery_report', meta, payload as unknown as Record<string, unknown>);
    logger.info('recovery_report sent', {
      attemptId: meta.attempt_id,
      status: payload.status,
    });
  }

  async handleReconcileDecision(decision: ReconcileDecisionPayload): Promise<void> {
    const meta = readAttemptMetadata(this.stateDir, decision.attempt_id);
    if (decision.action === 'terminate_stale') {
      this.rejectedAttempts.add(decision.attempt_id);
      await this.hooks.terminateAttempt(decision.attempt_id);
      if (meta) {
        writeAttemptMetadata(this.stateDir, { ...meta, status: 'terminal' });
      }
      await removeAttemptMetadata(this.stateDir, decision.attempt_id).catch(() => undefined);
      logger.info('terminate_stale applied', {
        attemptId: decision.attempt_id,
        reason: decision.reason,
      });
      return;
    }

    // adopt
    if (!meta) {
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

    if (wasCompletedAwaitingUpload) {
      this.hooks.resendJobExit?.(meta);
      // Fallback: emit job_exit from coordinator when no executor hook is wired.
      if (!this.hooks.resendJobExit && meta.last_exit) {
        this.sendJobScoped('job_exit', meta, {
          attempt_id: meta.attempt_id,
          lease_id: meta.lease_id,
          lease_epoch: meta.lease_epoch,
          exit_code: meta.last_exit.exit_code,
          outcome: meta.last_exit.outcome,
          ...(meta.last_exit.failure_category
            ? { failure_category: meta.last_exit.failure_category }
            : {}),
          ...(meta.last_exit.failure_message
            ? { failure_message: meta.last_exit.failure_message }
            : {}),
        });
      }
      if (this.hooks.resumeArtifactUpload) {
        await this.hooks.resumeArtifactUpload(meta);
      }
    }

    logger.info('attempt adopted; spool replay started', {
      attemptId: decision.attempt_id,
      resume_from_sequence: decision.resume_from_sequence,
      completed_awaiting_upload: wasCompletedAwaitingUpload,
    });
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
