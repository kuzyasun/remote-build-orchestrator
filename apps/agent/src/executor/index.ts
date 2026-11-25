import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import {
  type AttemptSpool,
  appendChunk,
  appendEvent,
  collectArtifactFiles,
  nextEventSequence,
  openAttemptSpool,
  readAck,
  runCleanupScript,
  spawnJobScript,
  totalBytes,
  waitForCompletion,
  writeAck,
  writeJobScript,
} from '@rbo/executor';
import type {
  ArtifactCollectionSummary,
  ArtifactManifestPayload,
  ArtifactUploadGrantPayload,
  BuildCacheKind,
  BundleDownloadPayload,
  CancelJobPayload,
  CleanupCompletePayload,
  HeartbeatAckPayload,
  JobExitPayload,
  LeaseOfferPayload,
  LogAckPayload,
  PrepareSourceGitOverlayPayload,
  PrepareSourcePayload,
  RunJobPayload,
} from '@rbo/protocol';
import { createLogger, generateId, resolveContainedCwd, sha256File } from '@rbo/shared';
import type { GitUrlAllowlist } from '@rbo/shared';
import {
  applyGitOverlay,
  detectGitSourceRequirements,
  listGitlinkPins,
  materializeFullSnapshot,
} from '@rbo/snapshot';
import type { WebSocket } from 'ws';
import {
  type AcquireResult,
  type BuildCacheConfig,
  BuildCacheStore,
  DEFAULT_BUILD_CACHE_CONFIG,
  buildCacheEnvForKind,
  resolveBuildCacheInjection,
  resolveBuildCachesDir,
  stripUserBuildCacheEnv,
} from '../build-cache/index.js';
import {
  DEFAULT_LOG_SEND_QUEUE_MAX,
  DEFAULT_LOG_SPOOL_MAX_BYTES,
  resolveReposDir,
} from '../config.js';
import { cleanupDockerResourcesForAttempt } from '../docker/cleanup.js';
import { SpoolSender } from '../logs/spool-sender.js';
import {
  type AttemptArtifactManifestItem,
  type AttemptExitRecord,
  type AttemptMetadata,
  processIdentityFromPid,
  readAttemptMetadata,
  removeAttemptMetadata,
  writeAttemptMetadata,
} from '../recovery/attempt-metadata.js';
import type { AgentRecoveryCoordinator } from '../recovery/coordinator.js';
import { isAcceptingJobsUnderDiskPressure } from '../recovery/disk-pressure.js';
import { WorktreeCleanup } from '../recovery/worktree-cleanup.js';
import {
  applyControlledGitSource,
  checkoutOverlayGitlinkPins,
  hasControlledGitLfsTrackedFiles,
  isControlledGitLfsAvailable,
} from '../repos/controlled-git.js';
import { type RepoCacheConfig, RepoMirrorManager } from '../repos/mirror.js';
import { StreamRedactor } from './redactor.js';
import { streamDownloadWithLimits } from './stream-download-with-limits.js';
import { pinnedTlsRequestOptions } from './tls-pin.js';

const logger = createLogger('agent.executor');

export interface LeaseClock {
  epochMs: number;
  monotonicMs: number;
}

export function readLeaseClock(): LeaseClock {
  return { epochMs: Date.now(), monotonicMs: performance.now() };
}

function leaseRemainingMs(deadline: LeaseClock, now = readLeaseClock()): number {
  // The monotonic clock guards against wall-clock rollback. The wall clock also
  // guards against suspension on platforms where monotonic time pauses in sleep.
  return Math.min(deadline.epochMs - now.epochMs, deadline.monotonicMs - now.monotonicMs);
}
const ARTIFACT_TOKEN_TIMEOUT_MS = 60_000;
const ARTIFACT_UPLOAD_TIMEOUT_MS = 60_000;
const ARTIFACT_UPLOAD_ROUNDS = 3;
const BUNDLE_TOKEN_TIMEOUT_MS = 120_000;
const SOURCE_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const SOURCE_DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;

class PermanentArtifactUploadError extends Error {}

type ToolchainProfile = NonNullable<LeaseOfferPayload['selected_toolchain_profiles']>[number];
type RiskLevel = AttemptMetadata['risk_level'];

/** True when job risk requires Agent self-termination at lease expiry. */
export function isDestructiveOrHardwareRisk(risk: RiskLevel | undefined | null): boolean {
  return risk === 'destructive' || risk === 'hardware';
}

export interface AgentExecutorConfig {
  stateDir: string;
  /** Mirror cache root override (§2.8). */
  repoCacheDir?: string;
  /** Controller TLS certificate fingerprint (sha256:...), same pin as the WS session. */
  controllerFingerprint: string;
  /** Maps store ref name → environment variable that holds the secret value. */
  secretMap?: Record<string, string>;
  /** Current capability toolchain profiles for fingerprint recheck before spawn. */
  toolchainProfiles?: ToolchainProfile[];
  gitAllowlist: GitUrlAllowlist;
  repoCache: RepoCacheConfig;
  /** Named build-cache policy (Phase 7). */
  buildCache?: BuildCacheConfig;
  /** Max concurrent job slots; default 1. */
  maxJobs?: number;
  /** Max attempt spool bytes (stdout+stderr); default 512 MiB. */
  logSpoolMaxBytes?: number;
  /** Max in-memory log send queue; default 64. */
  logSendQueueMax?: number;
  /** Optional recovery coordinator for metadata + adopt replay. */
  recovery?: AgentRecoveryCoordinator;
  /** Minimum free disk bytes for admission; when set with freeBytes probe, reject leases. */
  diskMinFreeBytes?: number;
  /** Injectable free-disk bytes (tests / probe). */
  getFreeDiskBytes?: () => number | Promise<number>;
  /** Injectable spool-pressure flag. */
  getSpoolPressure?: () => boolean;
}

/** Per-attempt execution state (one slot in the multi-job map). */
interface AttemptRuntime {
  attemptId: string;
  jobId: string;
  offer: LeaseOfferPayload | null;
  prepare: PrepareSourcePayload | null;
  /** True after source_ready until attempt clear — cancel must emit terminal itself. */
  prepareReady: boolean;
  prepareTask?: Promise<void>;
  sourceAbort: AbortController;
  discardSource: boolean;
  /** True while handleRunJob owns the attempt (including pre-spawn). */
  runInProgress: boolean;
  materializedProjectPath: string | null;
  overlayRepoUrl: string | null;
  activeProcessKill?: (graceSeconds?: number) => Promise<void>;
  cancelSignal: { cancelled: boolean };
  /** User cleanup remains subject to the lease after the main outcome is final. */
  leaseCleanup?: { cancellation: AbortController; task?: Promise<unknown> };
  pendingArtifactUpload: {
    attemptId: string;
    leaseId: string;
    leaseEpoch: number;
    resolve: (grant: ArtifactUploadGrantPayload) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null;
  artifactTransfer?: { socket: WebSocket; completion: Promise<void> };
  artifactSocket: WebSocket;
  pendingBundleDownload: {
    attemptId: string;
    resolve: (grant: BundleDownloadPayload) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null;
  activeSpool: AttemptSpool | null;
  activeSpoolSender: SpoolSender | null;
  activeSpoolLease: {
    attemptId: string;
    leaseId: string;
    leaseEpoch: number;
  } | null;
  /** Serializes disk spool writes across concurrent stdout/stderr handlers. */
  spoolWriteChain: Promise<void>;
  spoolLimitBreached: boolean;
  /** Local lease deadline from an offer or confirmed renewal. */
  leaseDeadline: LeaseClock | null;
  leaseRisk: RiskLevel;
  leaseTimer: ReturnType<typeof setTimeout> | null;
  leaseExpired: boolean;
}

function createAttemptRuntime(attemptId: string, jobId: string, socket: WebSocket): AttemptRuntime {
  return {
    attemptId,
    jobId,
    offer: null,
    prepare: null,
    prepareReady: false,
    sourceAbort: new AbortController(),
    discardSource: false,
    runInProgress: false,
    materializedProjectPath: null,
    overlayRepoUrl: null,
    cancelSignal: { cancelled: false },
    pendingArtifactUpload: null,
    artifactSocket: socket,
    pendingBundleDownload: null,
    activeSpool: null,
    activeSpoolSender: null,
    activeSpoolLease: null,
    spoolWriteChain: Promise.resolve(),
    spoolLimitBreached: false,
    leaseDeadline: null,
    leaseRisk: 'normal',
    leaseTimer: null,
    leaseExpired: false,
  };
}

function agentOsFamily(): string {
  const p = process.platform;
  if (p === 'darwin') return 'macos';
  if (p === 'win32') return 'windows';
  return 'linux';
}

function resolveProjectIdentity(
  offer: LeaseOfferPayload,
  prepare: PrepareSourcePayload | null,
): string {
  if (prepare?.source_mode === 'git_overlay') {
    return prepare.repo.canonical_id;
  }
  return `local:${offer.snapshot_metadata.content_id}`;
}

export class AgentJobExecutor {
  private readonly mirrorManager: RepoMirrorManager;
  private readonly attempts = new Map<string, AttemptRuntime>();
  private readonly worktreeCleanup: WorktreeCleanup;
  private readonly maxJobs: number;

  constructor(
    private socket: WebSocket,
    private config: AgentExecutorConfig,
  ) {
    this.maxJobs = config.maxJobs ?? 1;
    this.mirrorManager = new RepoMirrorManager({
      reposDir: resolveReposDir(config),
      allowlist: config.gitAllowlist,
      repoCache: config.repoCache,
    });
    this.worktreeCleanup = new WorktreeCleanup(
      config.stateDir,
      config.gitAllowlist,
      this.mirrorManager,
    );
  }

  public isBusy(): boolean {
    return this.attempts.size > 0;
  }

  public evictInactiveRepos(inactiveThroughMs: number): Promise<string[]> {
    return this.mirrorManager.evictMirrors({ inactiveThroughMs });
  }

  public retryPendingWorktreeCleanup(): Promise<void> {
    return this.worktreeCleanup.retryPending((attemptId) => this.attempts.has(attemptId));
  }

  public shouldRetainWorkspace(attemptId: string): boolean {
    return this.attempts.has(attemptId) || this.worktreeCleanup.hasPending(attemptId);
  }

  public getActiveJobs(): Array<{ attempt_id: string; job_id: string }> {
    return [...this.attempts.values()].map((attempt) => ({
      attempt_id: attempt.attemptId,
      job_id: attempt.jobId,
    }));
  }

  /** True when any attempt's log send queue is saturated (disk carries backlog). */
  public isUnderSpoolPressure(): boolean {
    for (const attempt of this.attempts.values()) {
      if (attempt.activeSpoolSender?.isUnderPressure()) {
        return true;
      }
    }
    return false;
  }

  private sendFrame(
    type: string,
    attemptId: string,
    leaseId: string,
    leaseEpoch: number,
    payload: Record<string, unknown>,
  ): void {
    if (this.socket.readyState !== this.socket.OPEN) {
      return;
    }
    this.socket.send(
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

  private matchesReservedLease(
    attemptId: string,
    leaseId: string,
    leaseEpoch: number,
  ): AttemptRuntime | null {
    const attempt = this.attempts.get(attemptId);
    if (
      attempt &&
      attempt.offer?.attempt_id === attemptId &&
      attempt.offer.lease_id === leaseId &&
      attempt.offer.lease_epoch === leaseEpoch
    ) {
      return attempt;
    }
    return null;
  }

  private clearAttempt(attemptId: string): void {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) {
      return;
    }
    if (this.config.recovery) {
      this.config.recovery.clearLiveSender(attemptId);
    }
    this.clearLeaseTimer(attempt);
    if (attempt.pendingArtifactUpload) {
      clearTimeout(attempt.pendingArtifactUpload.timer);
      const pending = attempt.pendingArtifactUpload;
      attempt.pendingArtifactUpload = null;
      pending.reject(new Error('attempt cleared'));
    }
    this.cancelSourcePreparation(attempt, new Error('attempt cleared'));
    this.attempts.delete(attemptId);
  }

  private clearLeaseTimer(attempt: AttemptRuntime): void {
    if (attempt.leaseTimer) {
      clearTimeout(attempt.leaseTimer);
      attempt.leaseTimer = null;
    }
  }

  private scheduleLeaseTimer(attempt: AttemptRuntime): void {
    this.clearLeaseTimer(attempt);
    if (attempt.leaseDeadline === null) {
      return;
    }
    const delay = Math.max(0, Math.ceil(leaseRemainingMs(attempt.leaseDeadline)));
    const attemptId = attempt.attemptId;
    attempt.leaseTimer = setTimeout(() => {
      void this.onLeaseExpired(attemptId);
    }, delay);
    attempt.leaseTimer.unref?.();
  }

  /** Arm the initial local lease deadline from the offer TTL. */
  private armLeaseDeadline(attempt: AttemptRuntime, offer: LeaseOfferPayload): void {
    attempt.leaseRisk = offer.job_request.risk_level ?? 'normal';
    const now = readLeaseClock();
    const ttlMs = offer.lease_ttl_seconds * 1000;
    attempt.leaseDeadline = { epochMs: now.epochMs + ttlMs, monotonicMs: now.monotonicMs + ttlMs };
    attempt.leaseExpired = false;
    this.scheduleLeaseTimer(attempt);
  }

  public confirmLeaseRenewal(ack: HeartbeatAckPayload, heartbeatSentAt: LeaseClock): void {
    for (const renewed of ack.renewed_leases) {
      const attempt = this.attempts.get(renewed.attempt_id);
      // Recovery authorizes the lease on a new socket only after adoption.
      if (
        !attempt ||
        attempt.artifactSocket !== this.socket ||
        attempt.leaseDeadline === null ||
        attempt.leaseExpired ||
        this.config.recovery?.isRejected(renewed.attempt_id)
      ) {
        continue;
      }

      const existing = readAttemptMetadata(this.config.stateDir, renewed.attempt_id);
      const lease = attempt.offer ?? existing;
      if (
        !lease ||
        lease.lease_id !== renewed.lease_id ||
        lease.lease_epoch !== renewed.lease_epoch ||
        (existing &&
          (existing.lease_id !== renewed.lease_id ||
            existing.lease_epoch !== renewed.lease_epoch ||
            existing.status === 'terminal'))
      ) {
        continue;
      }

      // The Controller's renewal can only have started after we sent the heartbeat.
      const ttlMs =
        Math.min(ack.lease_ttl_seconds, attempt.offer?.lease_ttl_seconds ?? ack.lease_ttl_seconds) *
        1000;
      const deadline = {
        epochMs: heartbeatSentAt.epochMs + ttlMs,
        monotonicMs: heartbeatSentAt.monotonicMs + ttlMs,
      };
      const now = readLeaseClock();
      const remainingMs = leaseRemainingMs(attempt.leaseDeadline, now);
      if (remainingMs <= 0) {
        void this.onLeaseExpired(attempt.attemptId, now).catch((error) => {
          logger.warn('failed to finalize an expired lease', {
            attemptId: attempt.attemptId,
            error: String(error),
          });
        });
        continue;
      }
      // A wall-clock correction may move the UTC timestamp back. Compare both
      // remaining budgets on the same clocks and keep renewals in monotonic order.
      if (
        deadline.monotonicMs <= attempt.leaseDeadline.monotonicMs ||
        leaseRemainingMs(deadline, now) <= remainingMs
      ) {
        continue;
      }
      attempt.leaseDeadline = deadline;
      this.scheduleLeaseTimer(attempt);
      if (existing) {
        try {
          writeAttemptMetadata(this.config.stateDir, {
            ...existing,
            lease_deadline: new Date(deadline.epochMs).toISOString(),
            updated_at: new Date(now.epochMs).toISOString(),
          });
        } catch (error) {
          logger.warn('could not persist renewed lease deadline', {
            attemptId: attempt.attemptId,
            error: String(error),
          });
        }
      }
    }
  }

  private async onLeaseExpired(attemptId: string, observedAt = readLeaseClock()): Promise<void> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.leaseExpired || attempt.leaseDeadline === null) {
      return;
    }
    if (leaseRemainingMs(attempt.leaseDeadline, observedAt) > 0) {
      this.scheduleLeaseTimer(attempt);
      return;
    }
    // Once either clock observes expiry, the monotonic cutoff cannot reopen.
    attempt.leaseDeadline.monotonicMs = Math.min(
      attempt.leaseDeadline.monotonicMs,
      observedAt.monotonicMs,
    );
    this.clearLeaseTimer(attempt);
    if (!isDestructiveOrHardwareRisk(attempt.leaseRisk)) {
      // safe/normal: Controller owns lease expiry / orphan / lost.
      return;
    }
    if (
      attempt.leaseCleanup ||
      readAttemptMetadata(this.config.stateDir, attemptId)?.status === 'completed_awaiting_upload'
    ) {
      attempt.leaseExpired = true;
      attempt.leaseCleanup?.cancellation.abort(new Error('lease expired'));
      return;
    }
    attempt.leaseExpired = true;
    const offer = attempt.offer;
    logger.warn('lease expired — self-terminating destructive/hardware attempt', {
      attemptId,
      risk: attempt.leaseRisk,
    });
    attempt.cancelSignal.cancelled = true;
    this.cancelSourcePreparation(attempt, new Error('Lease expired during source preparation'));
    if (!attempt.runInProgress && offer) {
      if (attempt.prepareTask) {
        await attempt.prepareTask;
      } else {
        try {
          this.failTerminal(
            attemptId,
            offer.lease_id,
            offer.lease_epoch,
            'lease_expired',
            'Lease expired before process start',
          );
        } finally {
          await this.cleanupSourceWorkspace(attempt);
          this.clearAttempt(attemptId);
        }
      }
      return;
    }
    if (!attempt.activeProcessKill) {
      // run_job owns finalization while its pre-spawn setup is in progress.
      return;
    }
    try {
      await attempt.activeProcessKill(10);
    } catch (error) {
      logger.warn('failed to kill process on lease expiry', { error: String(error) });
    }
    if (offer) {
      const existing = readAttemptMetadata(this.config.stateDir, attemptId);
      writeAttemptMetadata(this.config.stateDir, {
        attempt_id: attemptId,
        job_id: offer.job_id,
        lease_id: offer.lease_id,
        lease_epoch: offer.lease_epoch,
        process_identity: existing?.process_identity ?? null,
        status: 'terminal',
        workspace_path:
          existing?.workspace_path ?? join(this.config.stateDir, 'workspaces', attemptId),
        spool_dir: existing?.spool_dir ?? join(this.config.stateDir, 'logs', attemptId),
        risk_level: attempt.leaseRisk,
        updated_at: new Date().toISOString(),
        lease_deadline: new Date(attempt.leaseDeadline.epochMs).toISOString(),
        last_exit: {
          exit_code: null,
          outcome: 'failed',
          failure_category: 'lease_expired',
          failure_message: 'Lease expired — Agent self-terminated destructive/hardware job',
        },
        ...(existing?.artifact_manifest ? { artifact_manifest: existing.artifact_manifest } : {}),
      });
    }
    // Terminal frames are emitted from handleRunJob after waitForCompletion observes the kill.
  }

  /**
   * Re-bind the WebSocket after reconnect so frames (including spool replay) use the new socket.
   */
  public attachSocket(socket: WebSocket): void {
    this.socket = socket;
  }

  public authorizeArtifactUpload(attemptId: string, socket: WebSocket): void {
    const attempt = this.attempts.get(attemptId);
    if (attempt && this.socket === socket) {
      attempt.artifactSocket = socket;
    }
  }

  /** First active attempt id (test helper); prefer {@link getActiveJobs}. */
  public getActiveAttemptId(): string | null {
    const first = this.attempts.keys().next();
    return first.done ? null : first.value;
  }

  /**
   * On WS disconnect: keep safe/normal (and destructive until lease expiry) process alive.
   * Persist orphaned metadata; do not kill or clear the attempt registry.
   * Frames are not sent — Controller enters grace/orphan reconciliation.
   */
  public async abandonOnDisconnect(): Promise<void> {
    const abandonedSources: Promise<void>[] = [];
    for (const attempt of this.attempts.values()) {
      if (attempt.offer && !attempt.runInProgress && !attempt.activeProcessKill) {
        abandonedSources.push(this.forceAbandonAttempt(attempt.attemptId));
        continue;
      }
      if (attempt.pendingArtifactUpload) {
        clearTimeout(attempt.pendingArtifactUpload.timer);
        attempt.pendingArtifactUpload.reject(
          new Error('Controller disconnected during artifact transfer'),
        );
        attempt.pendingArtifactUpload = null;
      }
      this.config.recovery?.onDisconnectPark(attempt.attemptId);
    }
    this.config.recovery?.detachSocket();
    // Running processes are parked for grace/adopt. Pre-start attempts have no process to adopt.
    await Promise.all(abandonedSources);
  }

  /** Operator shutdown / terminate_stale: kill all processes and free slots. */
  public async forceAbandon(): Promise<void> {
    const ids = [...this.attempts.keys()];
    for (const attemptId of ids) {
      await this.forceAbandonAttempt(attemptId);
    }
  }

  private async forceAbandonAttempt(attemptId: string): Promise<void> {
    const attempt = this.attempts.get(attemptId);
    if (!attempt) {
      return;
    }
    attempt.cancelSignal.cancelled = true;
    attempt.leaseCleanup?.cancellation.abort(new Error('attempt abandoned'));
    if (!attempt.runInProgress && !attempt.activeProcessKill && attempt.offer) {
      attempt.discardSource = true;
      this.cancelSourcePreparation(attempt, new Error('Source preparation abandoned'));
      if (attempt.prepareTask) {
        await attempt.prepareTask;
      } else {
        await this.cleanupSourceWorkspace(attempt);
        await removeAttemptMetadata(this.config.stateDir, attemptId);
        this.clearAttempt(attemptId);
      }
      return;
    }
    if (attempt.activeProcessKill) {
      try {
        await attempt.activeProcessKill(10);
      } catch (error) {
        logger.warn('failed to kill process on force abandon', { error: String(error) });
      }
    }
    await attempt.leaseCleanup?.task;
    this.clearAttempt(attemptId);
  }

  /** Recovery terminate_stale hook. */
  public async terminateAttemptForRecovery(attemptId: string): Promise<void> {
    await this.forceAbandonAttempt(attemptId);
  }

  /**
   * After adopt: if the process already exited, re-send job_exit so the Controller
   * can leave orphaned / resume collecting_artifacts.
   */
  public resendJobExitIfCompleted(meta: AttemptMetadata): void {
    const exit = meta.last_exit;
    if (!exit) {
      return;
    }
    const payload: JobExitPayload = {
      attempt_id: meta.attempt_id,
      lease_id: meta.lease_id,
      lease_epoch: meta.lease_epoch,
      exit_code: exit.exit_code,
      outcome: exit.outcome,
      ...(exit.failure_category ? { failure_category: exit.failure_category } : {}),
      ...(exit.failure_message ? { failure_message: exit.failure_message } : {}),
    };
    this.sendFrame(
      'job_exit',
      meta.attempt_id,
      meta.lease_id,
      meta.lease_epoch,
      payload as unknown as Record<string, unknown>,
    );
    logger.info('re-sent job_exit after adopt', { attemptId: meta.attempt_id });
  }

  /**
   * Resume artifact upload from persisted hash-verified staging only.
   * Never re-collects from a mutable workspace.
   */
  public async resumeArtifactUpload(saved: AttemptMetadata): Promise<void> {
    const socket = this.socket;
    let attempt = this.attempts.get(saved.attempt_id);
    if (attempt?.artifactTransfer) {
      const inFlight = attempt.artifactTransfer;
      await inFlight.completion;
      if (inFlight.socket === socket || this.socket !== socket) {
        return;
      }
      return this.resumeArtifactUpload(saved);
    }
    if (
      socket.readyState !== socket.OPEN ||
      (attempt && attempt.artifactSocket !== socket) ||
      this.config.recovery?.isRejected(saved.attempt_id)
    ) {
      return;
    }

    const meta = readAttemptMetadata(this.config.stateDir, saved.attempt_id) ?? saved;
    if (
      meta.status !== 'completed_awaiting_upload' ||
      (attempt?.runInProgress && !meta.cleanup_result)
    ) {
      return;
    }
    if (!attempt) {
      attempt = createAttemptRuntime(meta.attempt_id, meta.job_id, socket);
      this.attempts.set(meta.attempt_id, attempt);
    } else {
      attempt.jobId = meta.job_id;
    }
    attempt.leaseRisk = meta.risk_level;
    if (!attempt.leaseDeadline && meta.lease_deadline) {
      const epochMs = Date.parse(meta.lease_deadline);
      if (Number.isFinite(epochMs)) {
        const now = readLeaseClock();
        attempt.leaseDeadline = { epochMs, monotonicMs: now.monotonicMs + epochMs - now.epochMs };
      }
    }

    const isActive = () =>
      this.socket === socket &&
      socket.readyState === socket.OPEN &&
      this.attempts.get(meta.attempt_id) === attempt;
    const completion = this.finishArtifactTransfer(meta, isActive).catch((error) => {
      logger.warn('could not finalize artifact transfer', {
        attemptId: meta.attempt_id,
        error: String(error),
      });
    });
    attempt.artifactTransfer = { socket, completion };
    try {
      await completion;
    } finally {
      attempt.artifactTransfer = undefined;
      if (!attempt.runInProgress && this.attempts.get(meta.attempt_id) === attempt) {
        this.clearAttempt(meta.attempt_id);
      }
    }
  }

  private async finishArtifactTransfer(
    meta: AttemptMetadata,
    isActive: () => boolean,
  ): Promise<void> {
    const { attempt_id: attemptId, lease_id: leaseId, lease_epoch: leaseEpoch } = meta;
    const stagingCompleted =
      meta.artifact_staging === 'complete' ||
      (meta.artifact_staging === undefined &&
        Boolean(
          meta.artifact_manifest ||
            meta.artifact_collection ||
            (meta.artifact_transfer && meta.cleanup_result),
        ));
    const stagingInterrupted = !stagingCompleted;
    const staging = stagingCompleted ? 'complete' : 'interrupted';
    let transfer = meta.artifact_transfer;
    if (!transfer) {
      const stored =
        (!stagingInterrupted || Boolean(meta.artifact_manifest?.length)) &&
        (await this.uploadStagedArtifacts(meta, isActive));
      if (!isActive()) {
        return;
      }
      transfer = stored ? 'stored' : 'failed';
    } else if (stagingInterrupted && meta.artifact_staging === undefined) {
      transfer = 'failed';
    }

    try {
      if (
        transfer !== meta.artifact_transfer ||
        staging !== meta.artifact_staging ||
        meta.artifact_manifest
      ) {
        const current = readAttemptMetadata(this.config.stateDir, attemptId) ?? meta;
        writeAttemptMetadata(this.config.stateDir, {
          ...current,
          artifact_staging: staging,
          artifact_transfer: transfer,
          artifact_manifest: undefined,
          updated_at: new Date().toISOString(),
        });
      }
      await rm(join(this.config.stateDir, 'artifacts', attemptId), {
        recursive: true,
        force: true,
        maxRetries: 3,
      });
    } catch (error) {
      logger.warn('could not retire artifact transfer staging', {
        attemptId,
        error: String(error),
      });
    }
    if (isActive()) {
      this.sendFrame('cleanup_complete', attemptId, leaseId, leaseEpoch, {
        attempt_id: attemptId,
        lease_id: leaseId,
        lease_epoch: leaseEpoch,
        ...(meta.cleanup_result ?? { exit_code: null, timed_out: false }),
        ...(stagingInterrupted ? { artifact_staging_interrupted: true } : {}),
        ...(meta.cleanup_result ? {} : { cleanup_interrupted: true }),
      });
    }
  }

  private async uploadStagedArtifacts(
    meta: AttemptMetadata,
    isActive: () => boolean,
  ): Promise<boolean> {
    const { attempt_id: attemptId, lease_id: leaseId, lease_epoch: leaseEpoch } = meta;
    const staged = new Map((meta.artifact_manifest ?? []).map((item) => [item.logical_name, item]));
    const permanentFailures = new Set<string>();
    for (let round = 0; round < ARTIFACT_UPLOAD_ROUNDS && isActive(); round++) {
      if (round > 0) {
        await delay(250 * 2 ** (round - 1));
        if (!isActive()) break;
      }
      try {
        const grant = await this.requestArtifactUploadTokens(
          attemptId,
          leaseId,
          leaseEpoch,
          [...staged.values()],
          meta.artifact_collection,
        );
        let retry = false;
        for (const artifact of grant.artifacts) {
          if (!isActive()) return false;
          const item = staged.get(artifact.logical_name);
          if (!item || item.size_bytes !== artifact.size_bytes || item.sha256 !== artifact.sha256) {
            logger.warn('ignoring upload grant inconsistent with staged manifest', {
              attemptId,
              artifact: artifact.logical_name,
            });
            retry = true;
            continue;
          }
          if (permanentFailures.has(item.logical_name)) continue;
          try {
            const file = await stat(item.path).catch(() => null);
            if (
              !file?.isFile() ||
              file.size !== item.size_bytes ||
              (await sha256File(item.path)) !== item.sha256
            ) {
              throw new PermanentArtifactUploadError(
                'Staged artifact missing or checksum mismatch',
              );
            }
            if (!isActive()) return false;
            await this.uploadArtifactFile(
              artifact.upload_url,
              artifact.upload_token,
              item.path,
              item.logical_name,
              item.size_bytes,
              item.sha256,
            );
          } catch (error) {
            if (error instanceof PermanentArtifactUploadError) {
              permanentFailures.add(item.logical_name);
            } else {
              retry = true;
            }
            logger.warn('artifact upload attempt failed', {
              attemptId,
              artifact: item.logical_name,
              round: round + 1,
              error: String(error),
            });
          }
        }
        if (!retry)
          return !grant.artifacts.some((artifact) => permanentFailures.has(artifact.logical_name));
      } catch (error) {
        logger.warn('artifact upload grant failed', {
          attemptId,
          round: round + 1,
          error: String(error),
        });
      }
    }
    return false;
  }

  private persistCompletedAwaitingUpload(
    attempt: AttemptRuntime,
    offer: LeaseOfferPayload,
    run: RunJobPayload,
    exit: {
      exit_code: number | null;
      outcome: JobExitPayload['outcome'];
      failure_category?: JobExitPayload['failure_category'];
      failure_message?: string;
    },
    staging?: {
      manifest: AttemptArtifactManifestItem[];
      collection?: ArtifactCollectionSummary;
      interrupted: boolean;
    },
  ): void {
    const existing = readAttemptMetadata(this.config.stateDir, run.attempt_id);
    writeAttemptMetadata(this.config.stateDir, {
      attempt_id: run.attempt_id,
      job_id: offer.job_id,
      lease_id: run.lease_id,
      lease_epoch: run.lease_epoch,
      process_identity: existing?.process_identity ?? null,
      status: 'completed_awaiting_upload',
      workspace_path:
        existing?.workspace_path ?? join(this.config.stateDir, 'workspaces', run.attempt_id),
      spool_dir: existing?.spool_dir ?? join(this.config.stateDir, 'logs', run.attempt_id),
      risk_level: offer.job_request.risk_level ?? existing?.risk_level ?? 'normal',
      updated_at: new Date().toISOString(),
      ...(attempt.leaseDeadline
        ? { lease_deadline: new Date(attempt.leaseDeadline.epochMs).toISOString() }
        : existing?.lease_deadline
          ? { lease_deadline: existing.lease_deadline }
          : {}),
      last_exit: {
        exit_code: exit.exit_code,
        outcome: exit.outcome,
        ...(exit.failure_category ? { failure_category: exit.failure_category } : {}),
        ...(exit.failure_message ? { failure_message: exit.failure_message } : {}),
      },
      artifact_staging: staging ? (staging.interrupted ? 'interrupted' : 'complete') : 'pending',
      artifact_manifest: staging?.manifest,
      artifact_collection: staging?.collection,
    });
  }

  /** Mark on-disk metadata terminal then remove it so recovery does not rescan it. */
  private persistTerminalMetadata(attemptId: string, lastExit: AttemptExitRecord): void {
    const existing = readAttemptMetadata(this.config.stateDir, attemptId);
    if (!existing) {
      return;
    }
    try {
      writeAttemptMetadata(this.config.stateDir, {
        ...existing,
        status: 'terminal',
        last_exit: lastExit,
        updated_at: new Date().toISOString(),
      });
    } catch (error) {
      logger.warn('could not persist terminal attempt metadata', {
        attemptId,
        error: String(error),
      });
    }
    void removeAttemptMetadata(this.config.stateDir, attemptId).catch(() => undefined);
  }

  private sendCancelledTerminal(
    attemptId: string,
    leaseId: string,
    leaseEpoch: number,
    message: string,
  ): void {
    this.persistTerminalMetadata(attemptId, {
      exit_code: null,
      outcome: 'cancelled',
      failure_category: 'cancelled',
      failure_message: message,
    });
    const exitPayload: JobExitPayload = {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: leaseEpoch,
      exit_code: null,
      outcome: 'cancelled',
      failure_category: 'cancelled',
      failure_message: message,
    };
    this.sendFrame(
      'job_exit',
      attemptId,
      leaseId,
      leaseEpoch,
      exitPayload as unknown as Record<string, unknown>,
    );

    const cleanupPayload: CleanupCompletePayload = {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: leaseEpoch,
      exit_code: null,
      timed_out: false,
      message,
    };
    this.sendFrame(
      'cleanup_complete',
      attemptId,
      leaseId,
      leaseEpoch,
      cleanupPayload as unknown as Record<string, unknown>,
    );
  }

  private failTerminal(
    attemptId: string,
    leaseId: string,
    leaseEpoch: number,
    failureCategory: NonNullable<JobExitPayload['failure_category']>,
    failureMessage: string,
  ): void {
    this.persistTerminalMetadata(attemptId, {
      exit_code: 1,
      outcome: 'failed',
      failure_category: failureCategory,
      failure_message: failureMessage,
    });
    const exitPayload: JobExitPayload = {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: leaseEpoch,
      exit_code: 1,
      outcome: 'failed',
      failure_category: failureCategory,
      failure_message: failureMessage,
    };
    this.sendFrame(
      'job_exit',
      attemptId,
      leaseId,
      leaseEpoch,
      exitPayload as unknown as Record<string, unknown>,
    );

    const cleanupPayload: CleanupCompletePayload = {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: leaseEpoch,
      exit_code: 1,
      timed_out: false,
      message: failureMessage,
    };
    this.sendFrame(
      'cleanup_complete',
      attemptId,
      leaseId,
      leaseEpoch,
      cleanupPayload as unknown as Record<string, unknown>,
    );
  }

  public handleLeaseOffer(offer: LeaseOfferPayload): void {
    if (this.config.recovery?.isRejected(offer.attempt_id)) {
      return;
    }
    const cleanupPending = this.worktreeCleanup.hasPending(offer.attempt_id);
    if (cleanupPending || this.attempts.size >= this.maxJobs) {
      this.sendFrame('lease_reject', offer.attempt_id, offer.lease_id, offer.lease_epoch, {
        attempt_id: offer.attempt_id,
        lease_id: offer.lease_id,
        lease_epoch: offer.lease_epoch,
        reason: cleanupPending
          ? 'Previous source workspace cleanup is still pending'
          : `Agent capacity limit reached (${this.maxJobs} active job max)`,
      });
      return;
    }

    const minFree = this.config.diskMinFreeBytes;
    if (minFree !== undefined && this.config.getFreeDiskBytes) {
      const free = this.config.getFreeDiskBytes();
      const freeBytes = typeof free === 'number' ? free : undefined;
      const spoolPressure = this.config.getSpoolPressure?.() ?? false;
      if (
        freeBytes !== undefined &&
        !isAcceptingJobsUnderDiskPressure({
          freeBytes,
          minFreeBytes: minFree,
          spoolPressure,
        })
      ) {
        this.sendFrame('lease_reject', offer.attempt_id, offer.lease_id, offer.lease_epoch, {
          attempt_id: offer.attempt_id,
          lease_id: offer.lease_id,
          lease_epoch: offer.lease_epoch,
          reason: spoolPressure
            ? 'Agent refusing leases under log spool pressure'
            : 'Agent refusing leases under disk pressure',
        });
        return;
      }
    }

    const attempt = createAttemptRuntime(offer.attempt_id, offer.job_id, this.socket);
    attempt.offer = offer;
    this.attempts.set(offer.attempt_id, attempt);
    this.armLeaseDeadline(attempt, offer);

    const risk = offer.job_request.risk_level ?? 'normal';
    const spoolDir = join(this.config.stateDir, 'logs', offer.attempt_id);
    writeAttemptMetadata(this.config.stateDir, {
      attempt_id: offer.attempt_id,
      job_id: offer.job_id,
      lease_id: offer.lease_id,
      lease_epoch: offer.lease_epoch,
      process_identity: null,
      status: 'accepted',
      workspace_path: join(this.config.stateDir, 'workspaces', offer.attempt_id),
      spool_dir: spoolDir,
      risk_level: risk,
      updated_at: new Date().toISOString(),
      lease_deadline: new Date(attempt.leaseDeadline?.epochMs ?? Date.now()).toISOString(),
    });

    this.sendFrame('lease_accept', offer.attempt_id, offer.lease_id, offer.lease_epoch, {
      attempt_id: offer.attempt_id,
      lease_id: offer.lease_id,
      lease_epoch: offer.lease_epoch,
    });
  }

  public async handlePrepareSource(prepare: PrepareSourcePayload): Promise<void> {
    const attempt = this.matchesReservedLease(
      prepare.attempt_id,
      prepare.lease_id,
      prepare.lease_epoch,
    );
    if (!attempt || attempt.prepare || attempt.discardSource) {
      return;
    }
    attempt.prepare = prepare;
    attempt.prepareTask = this.prepareSource(attempt, prepare);
    try {
      await attempt.prepareTask;
    } finally {
      attempt.prepareTask = undefined;
    }
  }

  private async prepareSource(
    attempt: AttemptRuntime,
    prepare: PrepareSourcePayload,
  ): Promise<void> {
    const attemptDir = join(this.config.stateDir, 'workspaces', prepare.attempt_id);
    const signal = attempt.sourceAbort.signal;
    try {
      await mkdir(attemptDir, { recursive: true });
      signal.throwIfAborted();
      if (prepare.source_mode === 'git_overlay') {
        await this.handlePrepareGitOverlay(attempt, prepare, attemptDir, signal);
      } else {
        if (prepare.expected_size_bytes <= 0 || !prepare.expected_sha256) {
          throw new Error('prepare_source missing expected size or sha256');
        }
        const archivePartPath = join(attemptDir, 'snapshot.tar.zst.part');
        const archivePath = join(attemptDir, 'snapshot.tar.zst');
        await this.downloadSnapshotFile(
          prepare.download_url,
          prepare.data_token,
          archivePartPath,
          prepare.expected_size_bytes,
          prepare.expected_sha256,
          signal,
        );
        signal.throwIfAborted();
        await rename(archivePartPath, archivePath);
        const materialized = await materializeFullSnapshot({
          manifest: prepare.manifest,
          archivePath,
          workspaceRoot: join(attemptDir, 'workspace'),
        });
        attempt.materializedProjectPath = materialized.projectPath;
      }
      signal.throwIfAborted();
      attempt.prepareReady = true;
      this.sendFrame('source_ready', prepare.attempt_id, prepare.lease_id, prepare.lease_epoch, {
        attempt_id: prepare.attempt_id,
        lease_id: prepare.lease_id,
        lease_epoch: prepare.lease_epoch,
      });
    } catch (error) {
      try {
        if (attempt.discardSource) {
          await removeAttemptMetadata(this.config.stateDir, prepare.attempt_id);
        } else if (attempt.leaseExpired) {
          this.failTerminal(
            prepare.attempt_id,
            prepare.lease_id,
            prepare.lease_epoch,
            'lease_expired',
            'Lease expired during source preparation',
          );
        } else if (attempt.cancelSignal.cancelled) {
          this.sendCancelledTerminal(
            prepare.attempt_id,
            prepare.lease_id,
            prepare.lease_epoch,
            'Job cancelled during prepare_source',
          );
        } else {
          logger.error('prepare_source failed', {
            attemptId: prepare.attempt_id,
            error: String(error),
          });
          this.failTerminal(
            prepare.attempt_id,
            prepare.lease_id,
            prepare.lease_epoch,
            prepare.source_mode === 'git_overlay' && String(error).includes('fetch')
              ? 'repo_fetch'
              : 'materialization',
            String(error),
          );
        }
      } finally {
        await this.cleanupSourceWorkspace(attempt);
        this.clearAttempt(prepare.attempt_id);
      }
    }
  }

  /** Phase 5 git_overlay prepare — mirror + worktree + overlay materialization. */
  private async handlePrepareGitOverlay(
    attempt: AttemptRuntime,
    prepare: PrepareSourceGitOverlayPayload,
    attemptDir: string,
    signal: AbortSignal,
  ): Promise<void> {
    const projectPath = join(attemptDir, 'project');

    let repoKey: string | undefined;
    let fetchFailed = false;
    let fetchError: unknown;
    try {
      const mirror = await this.mirrorManager.ensureMirror(prepare.repo.url, signal);
      signal.throwIfAborted();
      repoKey = mirror.repoKey;
      if (prepare.repo.fetch_refs.length > 0) {
        await this.mirrorManager.fetchRefs(prepare.repo.url, prepare.repo.fetch_refs, signal);
      }
    } catch (error) {
      signal.throwIfAborted();
      fetchFailed = true;
      fetchError = error;
      logger.warn('mirror ensure/fetch failed', {
        attemptId: prepare.attempt_id,
        error: String(error),
      });
    }

    signal.throwIfAborted();
    let hasCommit =
      repoKey != null &&
      (await this.mirrorManager.hasCommit(repoKey, prepare.repo.base_commit, signal));
    signal.throwIfAborted();

    if (!hasCommit) {
      // Try to restore the original base from a bundle after fetch. The
      // Controller cannot substitute source captured after submission.
      this.sendFrame('source_need', prepare.attempt_id, prepare.lease_id, prepare.lease_epoch, {
        attempt_id: prepare.attempt_id,
        lease_id: prepare.lease_id,
        lease_epoch: prepare.lease_epoch,
        reason: 'base_commit_missing',
        detail: fetchFailed
          ? `Fetch failed (${String(fetchError)}); requesting bundle for ${prepare.repo.base_commit}`
          : `Commit ${prepare.repo.base_commit} missing`,
      });

      let bundle: BundleDownloadPayload;
      try {
        bundle = await this.waitForBundleDownload(attempt);
      } catch (bundleError) {
        signal.throwIfAborted();
        throw new Error(
          `Git fetch and bundle could not restore the submitted overlay. Submit a new job with snapshot_mode=full. Bundle unavailable: ${String(bundleError)}`,
        );
      }
      signal.throwIfAborted();

      const bundlePartPath = join(attemptDir, 'bundle.part');
      const bundlePath = join(attemptDir, 'bundle.gitbundle');
      await this.downloadSnapshotFile(
        bundle.download_url,
        bundle.data_token,
        bundlePartPath,
        bundle.expected_size_bytes,
        bundle.expected_sha256,
        signal,
      );
      signal.throwIfAborted();
      await rename(bundlePartPath, bundlePath);
      const bundleId = `${prepare.attempt_id}-${Date.now()}`;
      await this.mirrorManager.importBundle(prepare.repo.url, bundlePath, bundleId, signal);
      signal.throwIfAborted();
      if (!repoKey) {
        const mirror = await this.mirrorManager.ensureMirror(prepare.repo.url, signal);
        repoKey = mirror.repoKey;
      }
      signal.throwIfAborted();
      hasCommit = await this.mirrorManager.hasCommit(repoKey, prepare.repo.base_commit, signal);
      signal.throwIfAborted();
      if (!hasCommit) {
        throw new Error(
          `Git fetch and bundle did not restore the submitted commit ${prepare.repo.base_commit}. Submit a new job with snapshot_mode=full.`,
        );
      }
    }

    signal.throwIfAborted();
    await this.mirrorManager.createWorktree(
      prepare.repo.url,
      prepare.repo.base_commit,
      projectPath,
      signal,
    );
    attempt.overlayRepoUrl = prepare.repo.url;
    attempt.materializedProjectPath = projectPath;
    signal.throwIfAborted();

    const gitSourceRequirements = await detectGitSourceRequirements(projectPath, (repoRoot) =>
      hasControlledGitLfsTrackedFiles(repoRoot, signal),
    );
    const gitLfsAvailable =
      gitSourceRequirements.lfs && (await isControlledGitLfsAvailable(signal));
    await applyControlledGitSource({
      repoRoot: projectPath,
      allowlist: this.config.gitAllowlist,
      submodules: gitSourceRequirements.submodules,
      lfs: gitSourceRequirements.lfs,
      gitLfsAvailable,
      signal,
    });

    const gitlinkPins = listGitlinkPins(prepare.manifest);
    if (gitlinkPins.length > 0) {
      await checkoutOverlayGitlinkPins({
        projectPath,
        pins: gitlinkPins,
        allowlist: this.config.gitAllowlist,
        signal,
      });
    }

    signal.throwIfAborted();

    const overlayPartPath = join(attemptDir, 'overlay.tar.zst.part');
    const overlayPath = join(attemptDir, 'overlay.tar.zst');
    await this.downloadSnapshotFile(
      prepare.overlay.download_url,
      prepare.overlay.data_token,
      overlayPartPath,
      prepare.overlay.expected_size_bytes,
      prepare.overlay.expected_sha256,
      signal,
    );
    signal.throwIfAborted();
    await rename(overlayPartPath, overlayPath);

    await applyGitOverlay({
      manifest: prepare.manifest,
      archivePath: overlayPath,
      workspaceRoot: attemptDir,
      projectPath,
    });
  }

  public handleBundleDownload(bundle: BundleDownloadPayload): void {
    const attempt = this.matchesReservedLease(
      bundle.attempt_id,
      bundle.lease_id,
      bundle.lease_epoch,
    );
    if (
      !attempt ||
      !attempt.pendingBundleDownload ||
      attempt.pendingBundleDownload.attemptId !== bundle.attempt_id
    ) {
      return;
    }
    clearTimeout(attempt.pendingBundleDownload.timer);
    const { resolve } = attempt.pendingBundleDownload;
    attempt.pendingBundleDownload = null;
    resolve(bundle);
  }

  private waitForBundleDownload(attempt: AttemptRuntime): Promise<BundleDownloadPayload> {
    return new Promise((resolvePromise, rejectPromise) => {
      if (attempt.pendingBundleDownload) {
        rejectPromise(new Error('bundle download already pending'));
        return;
      }
      const timer = setTimeout(() => {
        attempt.pendingBundleDownload = null;
        rejectPromise(new Error('timed out waiting for bundle_download'));
      }, BUNDLE_TOKEN_TIMEOUT_MS);
      attempt.pendingBundleDownload = {
        attemptId: attempt.attemptId,
        resolve: resolvePromise,
        reject: rejectPromise,
        timer,
      };
    });
  }

  private cancelSourcePreparation(attempt: AttemptRuntime, reason: Error): void {
    attempt.sourceAbort.abort(reason);
    if (attempt.pendingBundleDownload) {
      clearTimeout(attempt.pendingBundleDownload.timer);
      const pending = attempt.pendingBundleDownload;
      attempt.pendingBundleDownload = null;
      pending.reject(reason);
    }
  }

  private async cleanupSourceWorkspace(attempt: AttemptRuntime): Promise<void> {
    const workspace = join(this.config.stateDir, 'workspaces', attempt.attemptId);
    if (attempt.overlayRepoUrl) {
      await this.worktreeCleanup.enqueue(attempt.attemptId, attempt.overlayRepoUrl);
      attempt.overlayRepoUrl = null;
      return;
    }
    if (this.worktreeCleanup.hasPending(attempt.attemptId)) {
      return;
    }
    await rm(workspace, {
      recursive: true,
      force: true,
    }).catch((error) => {
      logger.warn('could not remove source workspace', {
        attemptId: attempt.attemptId,
        error: String(error),
      });
    });
  }

  public async handleRunJob(run: RunJobPayload): Promise<void> {
    const attempt = this.matchesReservedLease(run.attempt_id, run.lease_id, run.lease_epoch);
    if (
      !attempt ||
      !attempt.offer ||
      !attempt.prepare ||
      attempt.discardSource ||
      attempt.runInProgress ||
      (attempt.prepareTask && !attempt.prepareReady)
    ) {
      return;
    }

    attempt.runInProgress = true;

    const offer = attempt.offer;
    const request = offer.job_request;
    const attemptDir = join(this.config.stateDir, 'workspaces', run.attempt_id);
    const isOverlay = attempt.prepare.source_mode === 'git_overlay';
    const workspaceRoot = isOverlay ? attemptDir : join(attemptDir, 'workspace');
    const controlDir = join(attemptDir, 'control');
    const artifactsDir = join(attemptDir, 'artifacts');
    // Canonical spool: {stateDir}/logs/<attempt-id>/ (also RBO_LOG_DIR via AttemptLogPaths)
    const logsDir = join(this.config.stateDir, 'logs', run.attempt_id);
    const acquiredCaches: Array<{
      cacheKey: string;
      kind: BuildCacheKind;
      result: AcquireResult;
    }> = [];
    let stopOwnedProcess: ((sweepExited?: boolean) => Promise<void>) | undefined;
    const stopBeforeSpawn = (): boolean => {
      const leaseExpired =
        isDestructiveOrHardwareRisk(attempt.leaseRisk) &&
        (attempt.leaseExpired ||
          !attempt.leaseDeadline ||
          leaseRemainingMs(attempt.leaseDeadline) <= 0);
      if (!leaseExpired && !attempt.cancelSignal.cancelled) return false;

      if (
        this.attempts.get(run.attempt_id) === attempt &&
        !this.config.recovery?.isRejected(run.attempt_id)
      ) {
        if (leaseExpired) {
          attempt.leaseExpired = true;
          this.failTerminal(
            run.attempt_id,
            run.lease_id,
            run.lease_epoch,
            'lease_expired',
            'Lease expired before process start',
          );
        } else {
          this.sendCancelledTerminal(
            run.attempt_id,
            run.lease_id,
            run.lease_epoch,
            'Job cancelled before spawn',
          );
        }
      }
      return true;
    };

    try {
      await mkdir(controlDir, { recursive: true });
      await mkdir(artifactsDir, { recursive: true });

      const spool = await openAttemptSpool(logsDir);
      const logs = spool.logs;
      const logSpoolMaxBytes = this.config.logSpoolMaxBytes ?? DEFAULT_LOG_SPOOL_MAX_BYTES;
      const logSendQueueMax = this.config.logSendQueueMax ?? DEFAULT_LOG_SEND_QUEUE_MAX;
      attempt.activeSpool = spool;
      attempt.activeSpoolLease = {
        attemptId: run.attempt_id,
        leaseId: run.lease_id,
        leaseEpoch: run.lease_epoch,
      };
      attempt.spoolLimitBreached = false;
      attempt.spoolWriteChain = Promise.resolve();
      const sender = new SpoolSender({
        maxQueue: logSendQueueMax,
        getSpool: () => attempt.activeSpool ?? spool,
        send: (chunk) => {
          if (this.socket.readyState !== this.socket.OPEN) {
            return false;
          }
          this.sendFrame('log_chunk', run.attempt_id, run.lease_id, run.lease_epoch, {
            attempt_id: run.attempt_id,
            lease_id: run.lease_id,
            lease_epoch: run.lease_epoch,
            stream: chunk.stream,
            sequence: chunk.sequence,
            bytes: chunk.bytes,
          });
          return true;
        },
      });
      sender.setAcked(await readAck(spool));
      attempt.activeSpoolSender = sender;
      this.config.recovery?.registerLiveSender(run.attempt_id, sender);

      // Toolchain recheck before spawn: path + environment_fingerprint vs current caps
      const currentProfiles = this.config.toolchainProfiles ?? [];
      for (const profile of offer.selected_toolchain_profiles ?? []) {
        const activationPath = profile.activation.path;
        if (activationPath && !existsSync(activationPath)) {
          this.failTerminal(
            run.attempt_id,
            run.lease_id,
            run.lease_epoch,
            'toolchain_changed',
            `Selected toolchain path missing: ${activationPath}`,
          );
          return;
        }
        const current = currentProfiles.find((p) => p.id === profile.id);
        if (
          !current ||
          current.environment_fingerprint !== profile.environment_fingerprint ||
          current.version !== profile.version ||
          (activationPath && current.activation.path && current.activation.path !== activationPath)
        ) {
          this.failTerminal(
            run.attempt_id,
            run.lease_id,
            run.lease_epoch,
            'toolchain_changed',
            `Selected toolchain fingerprint mismatch for profile '${profile.id}'`,
          );
          return;
        }
      }

      if (stopBeforeSpawn()) return;

      // Resolve secrets: execution.secret_refs is { ENV_NAME: store_ref }
      const secretMap = this.config.secretMap ?? {};
      const secretEnv: Record<string, string> = {};
      const secretValuesToRedact: string[] = [];

      for (const [envName, storeRef] of Object.entries(request.execution.secret_refs ?? {})) {
        const sourceEnvVar = secretMap[storeRef] ?? storeRef;
        const val = process.env[sourceEnvVar];
        if (!val) {
          this.failTerminal(
            run.attempt_id,
            run.lease_id,
            run.lease_epoch,
            'secret_missing',
            `Missing required secret ref '${storeRef}'`,
          );
          return;
        }
        secretEnv[envName] = val;
        secretValuesToRedact.push(val);
      }

      const stdoutRedactor = new StreamRedactor(secretValuesToRedact);
      const stderrRedactor = new StreamRedactor(secretValuesToRedact);

      const buildCacheConfig = this.config.buildCache ?? DEFAULT_BUILD_CACHE_CONFIG;
      const cacheStore = new BuildCacheStore(
        resolveBuildCachesDir(this.config.stateDir),
        buildCacheConfig,
      );
      await writeJobScript(controlDir, request.execution);

      const projectPath = attempt.materializedProjectPath ?? join(workspaceRoot, 'main_mount');
      const projectCwd = await resolveContainedCwd(projectPath, request.source.cwd);

      const selectedToolchain = offer.selected_toolchain_profiles?.[0];
      const riskLevel = request.risk_level ?? 'normal';
      const cacheInjection = resolveBuildCacheInjection({
        stateDir: this.config.stateDir,
        config: buildCacheConfig,
        preferBuildCache: request.preferences?.prefer_build_cache !== false,
        riskLevel,
        osFamily: agentOsFamily(),
        arch: process.arch,
        projectIdentity: resolveProjectIdentity(offer, attempt.prepare),
        selectedToolchain: selectedToolchain
          ? {
              id: selectedToolchain.id,
              environment_fingerprint: selectedToolchain.environment_fingerprint,
            }
          : null,
        requiredTools: request.requirements?.tools,
      });

      const cacheEnv: Record<string, string> = {};
      for (const target of cacheInjection.targets) {
        const result = await cacheStore.acquireForJob({
          cacheKey: target.cacheKey,
          kind: target.kind,
          attemptId: run.attempt_id,
          riskLevel,
        });
        acquiredCaches.push({ cacheKey: target.cacheKey, kind: target.kind, result });
        if (result.mode === 'hit' || result.mode === 'miss') {
          Object.assign(cacheEnv, buildCacheEnvForKind(target.kind, result.path));
        }
      }

      const strippedUserEnv = stripUserBuildCacheEnv(request.execution.env);
      const executionForSpawn = {
        ...request.execution,
        env: strippedUserEnv,
      };

      if (stopBeforeSpawn()) return;

      const child = spawnJobScript({
        attemptId: run.attempt_id,
        requireWindowsJobObject: true,
        getWindowsStartBudgetMs: isDestructiveOrHardwareRisk(attempt.leaseRisk)
          ? () =>
              !attempt.leaseExpired && attempt.leaseDeadline
                ? leaseRemainingMs(attempt.leaseDeadline)
                : 0
          : undefined,
        controlDir,
        workspacePath: workspaceRoot,
        projectPath: projectCwd,
        execution: executionForSpawn,
        env: {
          ...strippedUserEnv,
          ...secretEnv,
          ...cacheEnv,
          RBO_JOB_ID: offer.job_id,
          RBO_ATTEMPT_ID: run.attempt_id,
          RBO_ARTIFACT_DIR: artifactsDir,
        },
        logs,
        attachLogs: false,
      });

      // Own the child before the first bookkeeping operation can fail or yield.
      let processExited = false;
      const childExit = child.waitForExit();
      void childExit.then(() => {
        processExited = true;
      });
      let stopping: Promise<void> | undefined;
      const stopProcess = (grace = 10, sweepExited = false): Promise<void> => {
        if ((!processExited || sweepExited) && !stopping) {
          stopping = (async () => {
            // Allow an already-observed close to settle before signalling a PID.
            await Promise.resolve();
            if (!processExited || sweepExited) {
              try {
                await child.kill(grace);
              } catch (error) {
                logger.warn('failed to stop owned process tree', {
                  attemptId: run.attempt_id,
                  error: String(error),
                });
              }
            }
            // Keep the workspace and slot until the managed child closes.
            await childExit;
          })();
        }
        return stopping ?? Promise.resolve();
      };
      attempt.activeProcessKill = stopProcess;
      const stopAfterFailure = () => stopProcess(request.execution.cancel_grace_seconds);
      stopOwnedProcess = (sweepExited) =>
        stopProcess(request.execution.cancel_grace_seconds, sweepExited);
      if (attempt.cancelSignal.cancelled) {
        void stopAfterFailure();
      }

      const pid = child.pid;
      const processIdentity = pid && pid > 0 ? processIdentityFromPid(pid) : null;
      writeAttemptMetadata(this.config.stateDir, {
        attempt_id: run.attempt_id,
        job_id: offer.job_id,
        lease_id: run.lease_id,
        lease_epoch: run.lease_epoch,
        process_identity: processIdentity,
        status: 'running',
        workspace_path: workspaceRoot,
        spool_dir: logsDir,
        risk_level: request.risk_level ?? 'normal',
        ...(attempt.leaseDeadline
          ? { lease_deadline: new Date(attempt.leaseDeadline.epochMs).toISOString() }
          : {}),
        updated_at: new Date().toISOString(),
      });
      for (const key of child.ignoredRboEnvKeys ?? []) {
        await appendEvent(logs, {
          type: 'env_override_ignored',
          sequence: await nextEventSequence(logs),
          created_at: new Date().toISOString(),
          job_id: offer.job_id,
          attempt_id: run.attempt_id,
          name: key,
          reason: 'Reserved RBO_ env key ignored; injected system value wins',
        });
      }

      // If lease already expired before kill was registered, terminate now.
      if (
        isDestructiveOrHardwareRisk(attempt.leaseRisk) &&
        attempt.leaseDeadline !== null &&
        leaseRemainingMs(attempt.leaseDeadline) <= 0
      ) {
        if (attempt.leaseExpired) {
          // Timer already ran with null activeProcessKill — kill now.
          try {
            await attempt.activeProcessKill(10);
          } catch (error) {
            logger.warn('failed to kill process on late lease-expiry', { error: String(error) });
          }
        } else {
          void this.onLeaseExpired(run.attempt_id);
        }
      }

      const appendAndEnqueue = (stream: 'stdout' | 'stderr', text: string): Promise<void> => {
        const runAppend = async (): Promise<void> => {
          if (attempt.spoolLimitBreached) {
            return;
          }
          const { sequence: seq } = await appendChunk(spool, stream, text);
          sender.enqueue({ sequence: seq, stream, bytes: text });
          if ((await totalBytes(spool)) >= logSpoolMaxBytes) {
            attempt.spoolLimitBreached = true;
            logger.error('log spool limit breached', {
              attemptId: run.attempt_id,
              maxBytes: logSpoolMaxBytes,
            });
            void stopAfterFailure();
          }
        };
        attempt.spoolWriteChain = attempt.spoolWriteChain.then(runAppend, runAppend);
        return attempt.spoolWriteChain;
      };

      child.stdout.on('data', (rawChunk: Buffer) => {
        const redacted = stdoutRedactor.redact(rawChunk.toString('utf8'));
        if (redacted) {
          void appendAndEnqueue('stdout', redacted);
        }
      });

      child.stderr.on('data', (rawChunk: Buffer) => {
        const redacted = stderrRedactor.redact(rawChunk.toString('utf8'));
        if (redacted) {
          void appendAndEnqueue('stderr', redacted);
        }
      });

      const childStart = child.waitForStart().then((start) => {
        if (
          start.started &&
          this.attempts.get(run.attempt_id) === attempt &&
          attempt.artifactSocket === this.socket &&
          !this.config.recovery?.isRejected(run.attempt_id)
        ) {
          this.sendFrame('job_started', run.attempt_id, run.lease_id, run.lease_epoch, {
            attempt_id: run.attempt_id,
            lease_id: run.lease_id,
            lease_epoch: run.lease_epoch,
            ...(pid && pid > 0 ? { pid } : {}),
            process_identity: processIdentity,
          });
        }
        return start;
      });
      const result = await waitForCompletion({
        child: {
          waitForStart: () => childStart,
          waitForExit: () => childExit,
          nativeResultDelivery: child.nativeResultDelivery,
        },
        execution: request.execution,
        logs,
        signal: attempt.cancelSignal,
      });

      // Drain in-flight spool writes before flush / exit.
      await attempt.spoolWriteChain.catch(() => undefined);

      for (const [stream, redactor] of [
        ['stdout', stdoutRedactor],
        ['stderr', stderrRedactor],
      ] as const) {
        const flushed = redactor.flush();
        if (flushed) {
          await appendAndEnqueue(stream, flushed).catch((error) => {
            logger.warn('could not flush final job output', {
              attemptId: run.attempt_id,
              error: String(error),
            });
          });
        }
      }

      let timedOut = false;
      let logFailure = false;
      let durationComplete = false;
      const spoolLimit = attempt.spoolLimitBreached;

      if (result.type === 'timeout') {
        timedOut = true;
        await stopProcess(request.execution.cancel_grace_seconds);
      } else if (result.type === 'duration_complete') {
        durationComplete = true;
        await stopProcess(request.execution.cancel_grace_seconds);
      } else if (result.type === 'log_success') {
        await stopProcess(request.execution.cancel_grace_seconds);
      } else if (result.type === 'log_failure') {
        logFailure = true;
        await stopProcess(request.execution.cancel_grace_seconds);
      }

      const start = await childStart;

      const exitCode = result.type === 'exit' ? result.exitCode : null;
      const outcome = attempt.cancelSignal.cancelled
        ? 'cancelled'
        : spoolLimit
          ? 'failed'
          : timedOut
            ? 'timed_out'
            : !start.started || logFailure
              ? 'failed'
              : durationComplete || result.type === 'log_success'
                ? 'succeeded'
                : exitCode === 0
                  ? 'succeeded'
                  : 'failed';

      const exitExtras = spoolLimit
        ? {
            failure_category: 'log_spool_limit' as const,
            failure_message: `Log spool exceeded ${logSpoolMaxBytes} bytes`,
          }
        : attempt.leaseExpired
          ? {
              failure_category: 'lease_expired' as const,
              failure_message: 'Lease expired — Agent self-terminated destructive/hardware job',
            }
          : outcome === 'failed'
            ? {
                failure_category: start.started
                  ? ('process_exit' as const)
                  : ('process_spawn' as const),
                failure_message: start.started
                  ? logFailure
                    ? 'Completion failure_pattern matched in logs'
                    : `Script exited with code ${exitCode}`
                  : (start.errorMessage ?? 'Job process exited before confirming startup'),
              }
            : outcome === 'timed_out'
              ? {
                  failure_category: 'timeout' as const,
                  failure_message: 'Execution timed out',
                }
              : {};

      const effectiveOutcome = attempt.leaseExpired
        ? ('failed' as const)
        : attempt.cancelSignal.cancelled
          ? ('cancelled' as const)
          : outcome;

      const canFinalize = () =>
        this.attempts.get(run.attempt_id) === attempt &&
        !this.config.recovery?.isRejected(run.attempt_id);
      if (!canFinalize()) {
        return;
      }
      if (attempt.leaseExpired) {
        // Metadata already written in onLeaseExpired; emit terminals if still connected.
        const exitPayload: JobExitPayload = {
          attempt_id: run.attempt_id,
          lease_id: run.lease_id,
          lease_epoch: run.lease_epoch,
          exit_code: null,
          outcome: 'failed',
          failure_category: 'lease_expired',
          failure_message: 'Lease expired — Agent self-terminated destructive/hardware job',
        };
        this.sendFrame(
          'job_exit',
          run.attempt_id,
          run.lease_id,
          run.lease_epoch,
          exitPayload as unknown as Record<string, unknown>,
        );
        this.sendFrame('cleanup_complete', run.attempt_id, run.lease_id, run.lease_epoch, {
          attempt_id: run.attempt_id,
          lease_id: run.lease_id,
          lease_epoch: run.lease_epoch,
          exit_code: null,
          timed_out: false,
          message: 'Lease expired — Agent self-terminated destructive/hardware job',
        });
        return;
      }

      // Persist before/alongside job_exit so reconnect can recover completion.
      const leaseCleanup: AttemptRuntime['leaseCleanup'] = isDestructiveOrHardwareRisk(
        attempt.leaseRisk,
      )
        ? { cancellation: new AbortController() }
        : undefined;
      attempt.leaseCleanup = leaseCleanup;
      const processExit: AttemptExitRecord = {
        exit_code: exitCode,
        outcome: effectiveOutcome,
        ...exitExtras,
      };
      try {
        this.persistCompletedAwaitingUpload(attempt, offer, run, processExit);
      } catch (error) {
        logger.warn('could not persist completed process outcome', {
          attemptId: run.attempt_id,
          error: String(error),
        });
      }

      if (attempt.artifactSocket === this.socket) {
        this.sendFrame('job_exit', run.attempt_id, run.lease_id, run.lease_epoch, {
          attempt_id: run.attempt_id,
          lease_id: run.lease_id,
          lease_epoch: run.lease_epoch,
          exit_code: exitCode,
          outcome: effectiveOutcome,
          ...exitExtras,
        });
      } else {
        void this.config.recovery?.reportCompletedAttempt(run.attempt_id).catch((error) => {
          logger.warn('could not report completed attempt after reconnect', {
            attemptId: run.attempt_id,
            error: String(error),
          });
        });
      }

      const collection = await collectArtifactFiles({
        projectPath,
        rules: request.artifacts ?? [],
        tempDir: join(artifactsDir, '.collect-tmp'),
      }).catch((error) => {
        logger.warn('artifact collection failed after process exit', {
          attemptId: run.attempt_id,
          error: String(error),
        });
        return null;
      });

      // Stage under durable artifacts dir for resume (never re-glob workspace later).
      const stagingRoot = join(this.config.stateDir, 'artifacts', run.attempt_id);
      const stagedManifest: AttemptArtifactManifestItem[] = [];
      for (const f of collection?.files ?? []) {
        if (!canFinalize()) return;
        try {
          const stagedPath = join(stagingRoot, f.logical_name);
          await mkdir(join(stagedPath, '..'), { recursive: true });
          if (!canFinalize()) return;
          await copyFile(f.sourcePath, stagedPath);
          stagedManifest.push({
            logical_name: f.logical_name,
            path: stagedPath,
            size_bytes: f.size_bytes,
            sha256: f.sha256,
          });
        } catch (error) {
          logger.warn('could not stage artifact after process exit', {
            attemptId: run.attempt_id,
            artifact: f.logical_name,
            error: String(error),
          });
        }
      }

      if (!canFinalize()) return;
      try {
        this.persistCompletedAwaitingUpload(attempt, offer, run, processExit, {
          manifest: stagedManifest,
          collection: collection?.summary,
          interrupted: collection === null,
        });
      } catch (error) {
        logger.warn('could not persist staged artifact manifest', {
          attemptId: run.attempt_id,
          error: String(error),
        });
      }

      if (stopping) {
        await stopping.catch(() => undefined);
      }

      const cleanupTask = runCleanupScript({
        attemptId: run.attempt_id,
        requireWindowsJobObject: true,
        cancelSignal: leaseCleanup?.cancellation.signal,
        getWindowsStartBudgetMs: leaseCleanup
          ? () => {
              const observedAt = readLeaseClock();
              const remainingMs =
                !attempt.leaseExpired && attempt.leaseDeadline
                  ? leaseRemainingMs(attempt.leaseDeadline, observedAt)
                  : 0;
              if (remainingMs <= 0) void this.onLeaseExpired(run.attempt_id, observedAt);
              return remainingMs;
            }
          : undefined,
        controlDir,
        workspacePath: workspaceRoot,
        projectPath: projectCwd,
        execution: request.execution,
        env: {
          RBO_JOB_ID: offer.job_id,
          RBO_ATTEMPT_ID: run.attempt_id,
          RBO_ARTIFACT_DIR: artifactsDir,
        },
        logs,
      }).catch((error) => {
        const message = `Could not run cleanup script: ${String(error)}`;
        logger.warn(message, { attemptId: run.attempt_id });
        return { exitCode: null, timedOut: false, message };
      });
      if (leaseCleanup) leaseCleanup.task = cleanupTask;
      const cleanup = await cleanupTask;
      if (leaseCleanup) leaseCleanup.task = undefined;

      if (!canFinalize()) return;
      const cleanupResult = {
        exit_code: cleanup.exitCode,
        timed_out: cleanup.timedOut,
        ...('message' in cleanup ? { message: cleanup.message } : {}),
      };
      const meta = readAttemptMetadata(this.config.stateDir, run.attempt_id);
      try {
        if (meta?.status !== 'completed_awaiting_upload') {
          throw new Error('Attempt metadata unavailable after cleanup');
        }
        const completed = {
          ...meta,
          cleanup_result: cleanupResult,
          updated_at: new Date().toISOString(),
        };
        writeAttemptMetadata(this.config.stateDir, completed);
        await this.resumeArtifactUpload(completed);
      } catch (error) {
        if (meta?.status !== 'completed_awaiting_upload') {
          this.persistTerminalMetadata(run.attempt_id, processExit);
        }
        logger.warn('could not persist artifact completion', {
          attemptId: run.attempt_id,
          error: String(error),
        });
        if (attempt.artifactSocket === this.socket) {
          this.sendFrame('cleanup_complete', run.attempt_id, run.lease_id, run.lease_epoch, {
            attempt_id: run.attempt_id,
            lease_id: run.lease_id,
            lease_epoch: run.lease_epoch,
            ...cleanupResult,
          });
        }
      }

      // Promote miss caches only on successful job outcome (risk-gated inside store).
      for (const entry of acquiredCaches) {
        if (entry.result.mode !== 'miss') {
          continue;
        }
        await cacheStore
          .publishIfAllowed({
            cacheKey: entry.cacheKey,
            kind: entry.kind,
            attemptId: run.attempt_id,
            riskLevel: request.risk_level ?? 'normal',
            outcome: effectiveOutcome,
            tempPath: entry.result.path,
          })
          .catch((error) => {
            logger.warn('build-cache publish failed', {
              attemptId: run.attempt_id,
              cacheKey: entry.cacheKey,
              error: String(error),
            });
          });
      }
    } catch (error) {
      await stopOwnedProcess?.(true);
      logger.error('run_job failed', { attemptId: run.attempt_id, error: String(error) });
      if (
        this.attempts.get(run.attempt_id) === attempt &&
        !this.config.recovery?.isRejected(run.attempt_id)
      ) {
        this.failTerminal(run.attempt_id, run.lease_id, run.lease_epoch, 'internal', String(error));
      }
    } finally {
      await stopOwnedProcess?.();
      await attempt.spoolWriteChain.catch(() => undefined);
      for (const entry of acquiredCaches) {
        await entry.result.release().catch(() => undefined);
      }
      // Label-scoped Docker cleanup before workspace rm (idempotent; skips if no docker).
      await cleanupDockerResourcesForAttempt({ attemptId: run.attempt_id }).catch((error) => {
        logger.warn('docker cleanup after job terminal failed', {
          attemptId: run.attempt_id,
          error: String(error),
        });
      });
      await this.cleanupSourceWorkspace(attempt);
      attempt.runInProgress = false;
      if (!attempt.artifactTransfer && this.attempts.get(run.attempt_id) === attempt) {
        this.clearAttempt(run.attempt_id);
      }
    }
  }

  public handleArtifactUploadGrant(grant: ArtifactUploadGrantPayload): void {
    // Fence against the exact outstanding request's own lease tuple (captured when it was sent),
    // not the offer-flow-only matchesReservedLease — a resumed upload after Agent
    // restart (resumeArtifactUpload) never goes through handleLeaseOffer, so offer may be null
    // there even though the request is legitimate.
    const attempt = this.attempts.get(grant.attempt_id);
    if (
      attempt?.pendingArtifactUpload &&
      attempt.pendingArtifactUpload.attemptId === grant.attempt_id &&
      attempt.pendingArtifactUpload.leaseId === grant.lease_id &&
      attempt.pendingArtifactUpload.leaseEpoch === grant.lease_epoch
    ) {
      clearTimeout(attempt.pendingArtifactUpload.timer);
      const { resolve } = attempt.pendingArtifactUpload;
      attempt.pendingArtifactUpload = null;
      resolve(grant);
    }
  }

  /** Controller contiguous log_ack — persist ack.json and advance the sender cursor. */
  public async handleLogAck(ack: LogAckPayload): Promise<void> {
    const attempt = this.attempts.get(ack.attempt_id);
    const lease = attempt?.activeSpoolLease;
    if (
      !attempt ||
      !lease ||
      lease.attemptId !== ack.attempt_id ||
      lease.leaseId !== ack.lease_id ||
      lease.leaseEpoch !== ack.lease_epoch
    ) {
      return;
    }
    const spool = attempt.activeSpool;
    const sender = attempt.activeSpoolSender;
    if (!spool || !sender) {
      return;
    }
    try {
      await writeAck(spool, ack.sequence);
    } catch (error) {
      // Disk ack is best-effort durability for reconnect; never crash the Agent daemon.
      logger.warn('failed to persist log ack', {
        attemptId: ack.attempt_id,
        sequence: ack.sequence,
        ackPath: spool.ackPath,
        error: String(error),
      });
    }
    // Always advance in-memory cursor — Controller already accepted these chunks.
    sender.onAck(ack.sequence);
  }

  public async handleCancelJob(cancel: CancelJobPayload): Promise<void> {
    const attempt = this.matchesReservedLease(
      cancel.attempt_id,
      cancel.lease_id,
      cancel.lease_epoch,
    );
    if (!attempt) {
      return;
    }
    attempt.cancelSignal.cancelled = true;
    this.cancelSourcePreparation(attempt, new Error('Job cancelled during source preparation'));
    if (attempt.leaseCleanup) {
      attempt.leaseCleanup.cancellation.abort(new Error('job cancelled'));
      await attempt.leaseCleanup.task;
      return;
    }
    if (attempt.activeProcessKill) {
      await attempt.activeProcessKill(cancel.grace_seconds);
      return;
    }

    // run_job owns the attempt (including pre-spawn): keep cancelSignal for waiters.
    if (attempt.runInProgress) {
      return;
    }
    if (attempt.prepareTask && !attempt.prepareReady) {
      await attempt.prepareTask;
      return;
    }

    // Lease reserved, prepare ready (or not started) — free the slot now.
    try {
      this.sendCancelledTerminal(
        cancel.attempt_id,
        cancel.lease_id,
        cancel.lease_epoch,
        cancel.reason ?? 'Job cancelled before process start',
      );
    } finally {
      await this.cleanupSourceWorkspace(attempt);
      this.clearAttempt(cancel.attempt_id);
    }
  }

  private requestArtifactUploadTokens(
    attemptId: string,
    leaseId: string,
    leaseEpoch: number,
    artifacts: Array<{
      logical_name: string;
      path: string;
      size_bytes: number;
      sha256: string;
    }>,
    collection?: ArtifactCollectionSummary,
  ): Promise<ArtifactUploadGrantPayload> {
    return new Promise((resolve, reject) => {
      const attempt = this.attempts.get(attemptId);
      if (!attempt || this.socket.readyState !== this.socket.OPEN) {
        reject(new Error('attempt not active for artifact upload'));
        return;
      }
      if (attempt.pendingArtifactUpload) {
        reject(new Error('artifact upload already pending'));
        return;
      }
      const timer = setTimeout(() => {
        const live = this.attempts.get(attemptId);
        if (live) {
          live.pendingArtifactUpload = null;
        }
        reject(new Error('timed out waiting for artifact upload tokens'));
      }, ARTIFACT_TOKEN_TIMEOUT_MS);
      attempt.pendingArtifactUpload = { attemptId, leaseId, leaseEpoch, resolve, reject, timer };
      const manifest: ArtifactManifestPayload = {
        attempt_id: attemptId,
        lease_id: leaseId,
        lease_epoch: leaseEpoch,
        artifacts,
        ...(collection ? { collection } : {}),
      };
      try {
        this.sendFrame(
          'artifact_manifest',
          attemptId,
          leaseId,
          leaseEpoch,
          manifest as unknown as Record<string, unknown>,
        );
      } catch (error) {
        clearTimeout(timer);
        attempt.pendingArtifactUpload = null;
        reject(error);
      }
    });
  }

  private async downloadSnapshotFile(
    downloadUrl: string,
    dataToken: string,
    destPath: string,
    expectedSize: number,
    expectedSha256: string,
    attemptSignal: AbortSignal,
  ): Promise<void> {
    attemptSignal.throwIfAborted();
    const deadline = new AbortController();
    const signal = AbortSignal.any([attemptSignal, deadline.signal]);
    const timer = setTimeout(
      () => deadline.abort(new Error('Source download deadline exceeded')),
      SOURCE_DOWNLOAD_TIMEOUT_MS,
    );
    timer.unref();

    try {
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = httpsRequest(
          downloadUrl,
          {
            method: 'GET',
            headers: { Authorization: `Bearer ${dataToken}` },
            signal,
            ...pinnedTlsRequestOptions(this.config.controllerFingerprint, signal),
          },
          resolve,
        );
        req.once('error', reject);
        req.setTimeout(SOURCE_DOWNLOAD_IDLE_TIMEOUT_MS, () => {
          deadline.abort(new Error('Source download stalled'));
        });
        req.end();
      });
      if (response.statusCode !== 200) {
        response.destroy();
        throw new Error(`Snapshot download failed with HTTP ${response.statusCode}`);
      }
      await streamDownloadWithLimits(response, destPath, expectedSize, expectedSha256, signal);
    } catch (error) {
      signal.throwIfAborted();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private uploadArtifactFile(
    uploadUrl: string,
    uploadToken: string,
    filePath: string,
    logicalName: string,
    sizeBytes: number,
    sha256: string,
  ): Promise<void> {
    return new Promise<void>((resolvePromise, rejectPromise) => {
      const req = httpsRequest(
        uploadUrl,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${uploadToken}`,
            'Content-Length': sizeBytes,
            'X-RBO-SHA256': sha256,
            'X-RBO-Artifact-Name': logicalName,
          },
          signal: AbortSignal.timeout(ARTIFACT_UPLOAD_TIMEOUT_MS),
          ...pinnedTlsRequestOptions(this.config.controllerFingerprint),
        },
        (res) => {
          res.on('error', rejectPromise);
          res.resume();
          const status = res.statusCode ?? 0;
          if (status === 200) {
            resolvePromise();
          } else {
            const message = `Artifact upload failed HTTP ${status}`;
            const retryable =
              status === 0 || status >= 500 || status === 408 || status === 409 || status === 429;
            rejectPromise(
              retryable ? new Error(message) : new PermanentArtifactUploadError(message),
            );
          }
        },
      );
      req.on('error', rejectPromise);
      void pipeline(createReadStream(filePath), req).catch(rejectPromise);
    });
  }
}
