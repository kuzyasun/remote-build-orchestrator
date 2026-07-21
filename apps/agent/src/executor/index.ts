import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
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
  ArtifactManifestPayload,
  ArtifactUploadGrantPayload,
  BuildCacheKind,
  BundleDownloadPayload,
  CancelJobPayload,
  CleanupCompletePayload,
  JobExitPayload,
  LeaseOfferPayload,
  LogAckPayload,
  PrepareSourceGitOverlayPayload,
  PrepareSourcePayload,
  RunJobPayload,
  SourceNeedReason,
} from '@rbo/protocol';
import { certificateFingerprint, createLogger, generateId, resolveContainedCwd } from '@rbo/shared';
import type { GitUrlAllowlist } from '@rbo/shared';
import {
  applyGitOverlay,
  detectGitSourceRequirements,
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
  type AttemptMetadata,
  processIdentityFromPid,
  readAttemptMetadata,
  writeAttemptMetadata,
} from '../recovery/attempt-metadata.js';
import type { AgentRecoveryCoordinator } from '../recovery/coordinator.js';
import { isAcceptingJobsUnderDiskPressure } from '../recovery/disk-pressure.js';
import { applyControlledGitSource } from '../repos/controlled-git.js';
import { type RepoCacheConfig, RepoMirrorManager } from '../repos/mirror.js';
import { StreamRedactor } from './redactor.js';
import { streamDownloadWithLimits } from './stream-download-with-limits.js';

const logger = createLogger('agent.executor');
const ARTIFACT_TOKEN_TIMEOUT_MS = 60_000;
const BUNDLE_TOKEN_TIMEOUT_MS = 120_000;

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

function assertPinnedPeerCert(
  res: IncomingMessage,
  expectedFingerprint: string,
): Error | undefined {
  const socket = res.socket as unknown as {
    getPeerCertificate?: (detailed?: boolean) => { raw?: Buffer };
  };
  const cert = socket.getPeerCertificate?.(true);
  if (!cert?.raw) {
    return new Error('Controller did not present a TLS certificate');
  }
  const actual = certificateFingerprint(cert.raw);
  if (actual !== expectedFingerprint) {
    return new Error(
      `Controller certificate fingerprint mismatch: expected ${expectedFingerprint}, got ${actual}`,
    );
  }
  return undefined;
}

export class AgentJobExecutor {
  private readonly mirrorManager: RepoMirrorManager;
  private activeAttemptId: string | null = null;
  private currentOffer: LeaseOfferPayload | null = null;
  private currentPrepare: PrepareSourcePayload | null = null;
  /** True after source_ready until attempt clear — cancel must emit terminal itself. */
  private prepareReady = false;
  /** True while handleRunJob owns the attempt (including pre-spawn). */
  private runInProgress = false;
  private materializedProjectPath: string | null = null;
  private overlayRepoUrl: string | null = null;
  private activeProcessKill?: (graceSeconds?: number) => Promise<void>;
  private cancelSignal = { cancelled: false };
  private pendingArtifactUpload: {
    attemptId: string;
    resolve: (grant: ArtifactUploadGrantPayload) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private pendingBundleDownload: {
    attemptId: string;
    resolve: (grant: BundleDownloadPayload) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private activeSpool: AttemptSpool | null = null;
  private activeSpoolSender: SpoolSender | null = null;
  private activeSpoolLease: {
    attemptId: string;
    leaseId: string;
    leaseEpoch: number;
  } | null = null;
  /** Serializes disk spool writes across concurrent stdout/stderr handlers. */
  private spoolWriteChain: Promise<void> = Promise.resolve();
  private spoolLimitBreached = false;
  /** Local lease deadline (ms since epoch) from offer / heartbeat renewals. */
  private leaseDeadlineMs: number | null = null;
  private leaseTtlSeconds = 300;
  private leaseRisk: RiskLevel = 'normal';
  private leaseTimer: ReturnType<typeof setTimeout> | null = null;
  private leaseExpired = false;

  constructor(
    private socket: WebSocket,
    private config: AgentExecutorConfig,
  ) {
    this.mirrorManager = new RepoMirrorManager({
      reposDir: resolveReposDir(config),
      allowlist: config.gitAllowlist,
      repoCache: config.repoCache,
    });
  }

  public isBusy(): boolean {
    return this.activeAttemptId !== null;
  }

  /** True when the active log send queue is saturated (disk carries backlog). */
  public isUnderSpoolPressure(): boolean {
    return this.activeSpoolSender?.isUnderPressure() ?? false;
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

  private matchesReservedLease(attemptId: string, leaseId: string, leaseEpoch: number): boolean {
    return (
      this.activeAttemptId === attemptId &&
      this.currentOffer?.attempt_id === attemptId &&
      this.currentOffer.lease_id === leaseId &&
      this.currentOffer.lease_epoch === leaseEpoch
    );
  }

  private clearAttempt(): void {
    if (this.activeAttemptId && this.config.recovery) {
      this.config.recovery.clearLiveSender(this.activeAttemptId);
    }
    this.clearLeaseTimer();
    this.leaseDeadlineMs = null;
    this.leaseExpired = false;
    this.leaseRisk = 'normal';
    this.activeAttemptId = null;
    this.currentOffer = null;
    this.currentPrepare = null;
    this.prepareReady = false;
    this.runInProgress = false;
    this.materializedProjectPath = null;
    this.overlayRepoUrl = null;
    this.activeProcessKill = undefined;
    this.cancelSignal = { cancelled: false };
    this.activeSpool = null;
    this.activeSpoolSender = null;
    this.activeSpoolLease = null;
    this.spoolWriteChain = Promise.resolve();
    this.spoolLimitBreached = false;
    if (this.pendingArtifactUpload) {
      clearTimeout(this.pendingArtifactUpload.timer);
      const pending = this.pendingArtifactUpload;
      this.pendingArtifactUpload = null;
      pending.reject(new Error('attempt cleared'));
    }
    if (this.pendingBundleDownload) {
      clearTimeout(this.pendingBundleDownload.timer);
      const pending = this.pendingBundleDownload;
      this.pendingBundleDownload = null;
      pending.reject(new Error('attempt cleared'));
    }
  }

  private clearLeaseTimer(): void {
    if (this.leaseTimer) {
      clearTimeout(this.leaseTimer);
      this.leaseTimer = null;
    }
  }

  private scheduleLeaseTimer(): void {
    this.clearLeaseTimer();
    if (this.leaseDeadlineMs === null) {
      return;
    }
    const delay = Math.max(0, this.leaseDeadlineMs - Date.now());
    this.leaseTimer = setTimeout(() => {
      void this.onLeaseExpired();
    }, delay);
    this.leaseTimer.unref?.();
  }

  /**
   * Arm / re-arm local lease deadline from offer TTL.
   * Heartbeat renewals call {@link renewLeaseDeadline} while connected.
   */
  private armLeaseDeadline(offer: LeaseOfferPayload): void {
    this.leaseTtlSeconds = offer.lease_ttl_seconds;
    this.leaseRisk = offer.job_request.risk_level ?? 'normal';
    this.leaseDeadlineMs = Date.now() + offer.lease_ttl_seconds * 1000;
    this.leaseExpired = false;
    this.scheduleLeaseTimer();
  }

  /** Mirror Controller renewActiveLease while heartbeats succeed. */
  public renewLeaseDeadline(ttlSeconds?: number): void {
    if (this.leaseDeadlineMs === null || this.leaseExpired) {
      return;
    }
    const ttl = ttlSeconds ?? this.leaseTtlSeconds;
    this.leaseDeadlineMs = Date.now() + ttl * 1000;
    this.scheduleLeaseTimer();
    const attemptId = this.activeAttemptId;
    if (attemptId) {
      const existing = readAttemptMetadata(this.config.stateDir, attemptId);
      if (existing) {
        writeAttemptMetadata(this.config.stateDir, {
          ...existing,
          lease_deadline: new Date(this.leaseDeadlineMs).toISOString(),
          updated_at: new Date().toISOString(),
        });
      }
    }
  }

  private async onLeaseExpired(): Promise<void> {
    if (this.leaseExpired || this.leaseDeadlineMs === null) {
      return;
    }
    if (Date.now() < this.leaseDeadlineMs) {
      this.scheduleLeaseTimer();
      return;
    }
    if (!isDestructiveOrHardwareRisk(this.leaseRisk)) {
      // safe/normal: Controller owns lease expiry / orphan / lost.
      return;
    }
    this.leaseExpired = true;
    const offer = this.currentOffer;
    const attemptId = this.activeAttemptId;
    logger.warn('lease expired — self-terminating destructive/hardware attempt', {
      attemptId,
      risk: this.leaseRisk,
    });
    this.cancelSignal.cancelled = true;
    if (this.activeProcessKill) {
      try {
        await this.activeProcessKill(10);
      } catch (error) {
        logger.warn('failed to kill process on lease expiry', { error: String(error) });
      }
    }
    if (attemptId && offer) {
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
        risk_level: this.leaseRisk,
        updated_at: new Date().toISOString(),
        lease_deadline: new Date(this.leaseDeadlineMs).toISOString(),
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

  private async cleanupOverlayWorktree(): Promise<void> {
    if (this.overlayRepoUrl && this.materializedProjectPath) {
      await this.mirrorManager
        .removeWorktree(this.overlayRepoUrl, this.materializedProjectPath)
        .catch(() => undefined);
    }
    this.overlayRepoUrl = null;
  }

  /**
   * Re-bind the WebSocket after reconnect so frames (including spool replay) use the new socket.
   */
  public attachSocket(socket: WebSocket): void {
    this.socket = socket;
  }

  public getActiveAttemptId(): string | null {
    return this.activeAttemptId;
  }

  /**
   * On WS disconnect: keep safe/normal (and destructive until lease expiry) process alive.
   * Persist orphaned metadata; do not kill or clear the attempt registry.
   * Frames are not sent — Controller enters grace/orphan reconciliation.
   */
  public async abandonOnDisconnect(): Promise<void> {
    const attemptId = this.activeAttemptId;
    if (attemptId && this.config.recovery) {
      this.config.recovery.onDisconnectPark(attemptId);
      this.config.recovery.detachSocket();
    }
    // Intentionally do NOT kill the process or clearAttempt — Phase 6 grace/adopt.
  }

  /** Operator shutdown / terminate_stale: kill process and free the slot. */
  public async forceAbandon(): Promise<void> {
    this.cancelSignal.cancelled = true;
    if (this.activeProcessKill) {
      try {
        await this.activeProcessKill(10);
      } catch (error) {
        logger.warn('failed to kill process on force abandon', { error: String(error) });
      }
    }
    if (this.activeAttemptId && this.config.recovery) {
      this.config.recovery.clearLiveSender(this.activeAttemptId);
    }
    this.clearAttempt();
  }

  /** Recovery terminate_stale hook. */
  public async terminateAttemptForRecovery(attemptId: string): Promise<void> {
    if (this.activeAttemptId !== attemptId) {
      return;
    }
    await this.forceAbandon();
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
  public async resumeArtifactUpload(meta: AttemptMetadata): Promise<void> {
    const items = meta.artifact_manifest;
    if (!items || items.length === 0) {
      return;
    }
    const verified: AttemptArtifactManifestItem[] = [];
    for (const item of items) {
      try {
        const buf = await readFile(item.path);
        const hash = createHash('sha256').update(buf).digest('hex');
        if (hash !== item.sha256 || buf.length !== item.size_bytes) {
          logger.warn('skipping artifact resume — staging hash mismatch', {
            logical_name: item.logical_name,
          });
          continue;
        }
        verified.push(item);
      } catch (error) {
        logger.warn('skipping missing staging artifact on resume', {
          logical_name: item.logical_name,
          error: String(error),
        });
      }
    }
    if (verified.length === 0) {
      return;
    }

    this.activeAttemptId = meta.attempt_id;
    this.leaseRisk = meta.risk_level;
    if (meta.lease_deadline) {
      this.leaseDeadlineMs = Date.parse(meta.lease_deadline);
    }

    const uploadGrant = await this.requestArtifactUploadTokens(
      meta.attempt_id,
      meta.lease_id,
      meta.lease_epoch,
      verified.map((f) => ({
        logical_name: f.logical_name,
        path: f.path,
        size_bytes: f.size_bytes,
        sha256: f.sha256,
      })),
    );

    for (const art of uploadGrant.artifacts) {
      try {
        await this.uploadArtifactFile(
          art.upload_url,
          art.upload_token,
          art.path,
          art.logical_name,
          art.size_bytes,
          art.sha256,
        );
      } catch (error) {
        logger.error('failed artifact resume upload', {
          artifact: art.logical_name,
          error: String(error),
        });
      }
    }
  }

  private persistCompletedAwaitingUpload(
    offer: LeaseOfferPayload,
    run: RunJobPayload,
    exit: {
      exit_code: number | null;
      outcome: JobExitPayload['outcome'];
      failure_category?: JobExitPayload['failure_category'];
      failure_message?: string;
    },
    artifactManifest?: AttemptArtifactManifestItem[],
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
      ...(this.leaseDeadlineMs
        ? { lease_deadline: new Date(this.leaseDeadlineMs).toISOString() }
        : existing?.lease_deadline
          ? { lease_deadline: existing.lease_deadline }
          : {}),
      last_exit: {
        exit_code: exit.exit_code,
        outcome: exit.outcome,
        ...(exit.failure_category ? { failure_category: exit.failure_category } : {}),
        ...(exit.failure_message ? { failure_message: exit.failure_message } : {}),
      },
      ...(artifactManifest
        ? { artifact_manifest: artifactManifest }
        : existing?.artifact_manifest
          ? { artifact_manifest: existing.artifact_manifest }
          : {}),
    });
  }

  private sendCancelledTerminal(
    attemptId: string,
    leaseId: string,
    leaseEpoch: number,
    message: string,
  ): void {
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
    if (this.isBusy()) {
      this.sendFrame('lease_reject', offer.attempt_id, offer.lease_id, offer.lease_epoch, {
        attempt_id: offer.attempt_id,
        lease_id: offer.lease_id,
        lease_epoch: offer.lease_epoch,
        reason: 'Agent capacity limit reached (1 active job max)',
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

    this.activeAttemptId = offer.attempt_id;
    this.currentOffer = offer;
    this.armLeaseDeadline(offer);

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
      lease_deadline: new Date(this.leaseDeadlineMs ?? Date.now()).toISOString(),
    });

    this.sendFrame('lease_accept', offer.attempt_id, offer.lease_id, offer.lease_epoch, {
      attempt_id: offer.attempt_id,
      lease_id: offer.lease_id,
      lease_epoch: offer.lease_epoch,
    });
  }

  public async handlePrepareSource(prepare: PrepareSourcePayload): Promise<void> {
    if (!this.matchesReservedLease(prepare.attempt_id, prepare.lease_id, prepare.lease_epoch)) {
      return;
    }
    this.currentPrepare = prepare;
    this.prepareReady = false;

    if (prepare.source_mode === 'git_overlay') {
      await this.handlePrepareGitOverlay(prepare);
      return;
    }

    await this.cleanupOverlayWorktree();

    const attemptDir = join(this.config.stateDir, 'workspaces', prepare.attempt_id);
    const archivePartPath = join(attemptDir, 'snapshot.tar.zst.part');
    const archivePath = join(attemptDir, 'snapshot.tar.zst');
    const workspaceRoot = join(attemptDir, 'workspace');

    await mkdir(attemptDir, { recursive: true });

    try {
      if (prepare.expected_size_bytes <= 0 || !prepare.expected_sha256) {
        throw new Error('prepare_source missing expected size or sha256');
      }
      if (this.cancelSignal.cancelled) {
        throw new Error('cancelled');
      }

      await this.downloadSnapshotFile(
        prepare.download_url,
        prepare.data_token,
        archivePartPath,
        prepare.expected_size_bytes,
        prepare.expected_sha256,
      );

      if (this.cancelSignal.cancelled) {
        throw new Error('cancelled');
      }

      await rename(archivePartPath, archivePath);

      const materialized = await materializeFullSnapshot({
        manifest: prepare.manifest,
        archivePath,
        workspaceRoot,
      });
      this.materializedProjectPath = materialized.projectPath;

      if (this.cancelSignal.cancelled) {
        this.sendCancelledTerminal(
          prepare.attempt_id,
          prepare.lease_id,
          prepare.lease_epoch,
          'Job cancelled during prepare_source',
        );
        await rm(attemptDir, { recursive: true, force: true }).catch(() => undefined);
        this.clearAttempt();
        return;
      }

      this.prepareReady = true;
      this.sendFrame('source_ready', prepare.attempt_id, prepare.lease_id, prepare.lease_epoch, {
        attempt_id: prepare.attempt_id,
        lease_id: prepare.lease_id,
        lease_epoch: prepare.lease_epoch,
      });
    } catch (error) {
      logger.error('prepare_source failed', {
        attemptId: prepare.attempt_id,
        error: String(error),
      });
      if (!this.matchesReservedLease(prepare.attempt_id, prepare.lease_id, prepare.lease_epoch)) {
        await rm(attemptDir, { recursive: true, force: true }).catch(() => undefined);
        return;
      }
      if (this.cancelSignal.cancelled || String(error).includes('cancelled')) {
        this.sendCancelledTerminal(
          prepare.attempt_id,
          prepare.lease_id,
          prepare.lease_epoch,
          'Job cancelled during prepare_source',
        );
      } else {
        this.failTerminal(
          prepare.attempt_id,
          prepare.lease_id,
          prepare.lease_epoch,
          'materialization',
          String(error),
        );
      }
      await rm(attemptDir, { recursive: true, force: true }).catch(() => undefined);
      this.clearAttempt();
    }
  }

  /** Phase 5 git_overlay prepare — mirror + worktree + overlay materialization. */
  private async handlePrepareGitOverlay(prepare: PrepareSourceGitOverlayPayload): Promise<void> {
    const attemptDir = join(this.config.stateDir, 'workspaces', prepare.attempt_id);
    const projectPath = join(attemptDir, 'project');
    let worktreeCreated = false;

    await mkdir(attemptDir, { recursive: true });

    try {
      if (this.cancelSignal.cancelled) {
        throw new Error('cancelled');
      }

      let repoKey: string | undefined;
      let fetchFailed = false;
      let fetchError: unknown;
      try {
        const mirror = await this.mirrorManager.ensureMirror(prepare.repo.url);
        repoKey = mirror.repoKey;
        if (prepare.repo.fetch_refs.length > 0) {
          await this.mirrorManager.fetchRefs(prepare.repo.url, prepare.repo.fetch_refs);
        }
      } catch (error) {
        fetchFailed = true;
        fetchError = error;
        logger.warn('mirror ensure/fetch failed', {
          attemptId: prepare.attempt_id,
          error: String(error),
        });
      }

      let hasCommit =
        repoKey != null && (await this.mirrorManager.hasCommit(repoKey, prepare.repo.base_commit));

      if (!hasCommit) {
        // Design order: fetch → bundle → full. Always try bundle before escalating.
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
          bundle = await this.waitForBundleDownload(
            prepare.attempt_id,
            prepare.lease_id,
            prepare.lease_epoch,
          );
        } catch (bundleError) {
          if (this.cancelSignal.cancelled || String(bundleError).includes('cancelled')) {
            throw new Error('cancelled');
          }
          const escalate: SourceNeedReason = fetchFailed
            ? 'repo_fetch_failed'
            : 'full_snapshot_required';
          this.sendFrame('source_need', prepare.attempt_id, prepare.lease_id, prepare.lease_epoch, {
            attempt_id: prepare.attempt_id,
            lease_id: prepare.lease_id,
            lease_epoch: prepare.lease_epoch,
            reason: escalate,
            detail: `Bundle unavailable after missing commit: ${String(bundleError)}`,
          });
          return;
        }
        if (this.cancelSignal.cancelled) {
          throw new Error('cancelled');
        }

        const bundlePartPath = join(attemptDir, 'bundle.part');
        const bundlePath = join(attemptDir, 'bundle.gitbundle');
        await this.downloadSnapshotFile(
          bundle.download_url,
          bundle.data_token,
          bundlePartPath,
          bundle.expected_size_bytes,
          bundle.expected_sha256,
        );
        await rename(bundlePartPath, bundlePath);
        const bundleId = `${prepare.attempt_id}-${Date.now()}`;
        await this.mirrorManager.importBundle(prepare.repo.url, bundlePath, bundleId);
        if (!repoKey) {
          const mirror = await this.mirrorManager.ensureMirror(prepare.repo.url);
          repoKey = mirror.repoKey;
        }
        hasCommit = await this.mirrorManager.hasCommit(repoKey, prepare.repo.base_commit);
        if (!hasCommit) {
          const escalate: SourceNeedReason = fetchFailed
            ? 'repo_fetch_failed'
            : 'full_snapshot_required';
          this.sendFrame('source_need', prepare.attempt_id, prepare.lease_id, prepare.lease_epoch, {
            attempt_id: prepare.attempt_id,
            lease_id: prepare.lease_id,
            lease_epoch: prepare.lease_epoch,
            reason: escalate,
            detail: `Commit ${prepare.repo.base_commit} still missing after bundle import`,
          });
          return;
        }
      }

      await this.mirrorManager.createWorktree(
        prepare.repo.url,
        prepare.repo.base_commit,
        projectPath,
      );
      worktreeCreated = true;
      this.overlayRepoUrl = prepare.repo.url;
      this.materializedProjectPath = projectPath;

      const gitSourceRequirements = await detectGitSourceRequirements(projectPath);
      let gitLfsAvailable = false;
      try {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        await promisify(execFile)('git-lfs', ['version'], { windowsHide: true });
        gitLfsAvailable = true;
      } catch {
        gitLfsAvailable = false;
      }
      await applyControlledGitSource({
        repoRoot: projectPath,
        allowlist: this.config.gitAllowlist,
        submodules: gitSourceRequirements.submodules,
        lfs: gitSourceRequirements.lfs,
        gitLfsAvailable,
      });

      if (this.cancelSignal.cancelled) {
        throw new Error('cancelled');
      }

      const overlayPartPath = join(attemptDir, 'overlay.tar.zst.part');
      const overlayPath = join(attemptDir, 'overlay.tar.zst');
      await this.downloadSnapshotFile(
        prepare.overlay.download_url,
        prepare.overlay.data_token,
        overlayPartPath,
        prepare.overlay.expected_size_bytes,
        prepare.overlay.expected_sha256,
      );
      await rename(overlayPartPath, overlayPath);

      if (this.cancelSignal.cancelled) {
        throw new Error('cancelled');
      }

      await applyGitOverlay({
        manifest: prepare.manifest,
        archivePath: overlayPath,
        workspaceRoot: attemptDir,
        projectPath,
      });

      if (this.cancelSignal.cancelled) {
        this.sendCancelledTerminal(
          prepare.attempt_id,
          prepare.lease_id,
          prepare.lease_epoch,
          'Job cancelled during prepare_source',
        );
        await this.cleanupOverlayAttempt(
          attemptDir,
          prepare.repo.url,
          projectPath,
          worktreeCreated,
        );
        this.clearAttempt();
        return;
      }

      this.prepareReady = true;
      this.sendFrame('source_ready', prepare.attempt_id, prepare.lease_id, prepare.lease_epoch, {
        attempt_id: prepare.attempt_id,
        lease_id: prepare.lease_id,
        lease_epoch: prepare.lease_epoch,
      });
    } catch (error) {
      logger.error('git_overlay prepare_source failed', {
        attemptId: prepare.attempt_id,
        error: String(error),
      });
      if (!this.matchesReservedLease(prepare.attempt_id, prepare.lease_id, prepare.lease_epoch)) {
        await this.cleanupOverlayAttempt(
          attemptDir,
          prepare.repo.url,
          projectPath,
          worktreeCreated,
        );
        return;
      }
      if (this.cancelSignal.cancelled || String(error).includes('cancelled')) {
        this.sendCancelledTerminal(
          prepare.attempt_id,
          prepare.lease_id,
          prepare.lease_epoch,
          'Job cancelled during prepare_source',
        );
      } else {
        this.failTerminal(
          prepare.attempt_id,
          prepare.lease_id,
          prepare.lease_epoch,
          String(error).includes('fetch') ? 'repo_fetch' : 'materialization',
          String(error),
        );
      }
      await this.cleanupOverlayAttempt(attemptDir, prepare.repo.url, projectPath, worktreeCreated);
      this.clearAttempt();
    }
  }

  public handleBundleDownload(bundle: BundleDownloadPayload): void {
    if (
      !this.matchesReservedLease(bundle.attempt_id, bundle.lease_id, bundle.lease_epoch) ||
      !this.pendingBundleDownload ||
      this.pendingBundleDownload.attemptId !== bundle.attempt_id
    ) {
      return;
    }
    clearTimeout(this.pendingBundleDownload.timer);
    const { resolve } = this.pendingBundleDownload;
    this.pendingBundleDownload = null;
    resolve(bundle);
  }

  private waitForBundleDownload(
    attemptId: string,
    leaseId: string,
    leaseEpoch: number,
  ): Promise<BundleDownloadPayload> {
    return new Promise((resolvePromise, rejectPromise) => {
      if (this.pendingBundleDownload) {
        rejectPromise(new Error('bundle download already pending'));
        return;
      }
      const timer = setTimeout(() => {
        this.pendingBundleDownload = null;
        rejectPromise(new Error('timed out waiting for bundle_download'));
      }, BUNDLE_TOKEN_TIMEOUT_MS);
      this.pendingBundleDownload = {
        attemptId,
        resolve: resolvePromise,
        reject: rejectPromise,
        timer,
      };
    });
  }

  private async cleanupOverlayAttempt(
    attemptDir: string,
    repoUrl: string,
    projectPath: string,
    worktreeCreated: boolean,
  ): Promise<void> {
    if (worktreeCreated) {
      await this.mirrorManager.removeWorktree(repoUrl, projectPath).catch(() => undefined);
    }
    this.overlayRepoUrl = null;
    await rm(attemptDir, { recursive: true, force: true }).catch(() => undefined);
  }

  public async handleRunJob(run: RunJobPayload): Promise<void> {
    if (
      !this.matchesReservedLease(run.attempt_id, run.lease_id, run.lease_epoch) ||
      !this.currentOffer ||
      !this.currentPrepare
    ) {
      return;
    }

    this.runInProgress = true;

    const offer = this.currentOffer;
    const request = offer.job_request;
    const attemptDir = join(this.config.stateDir, 'workspaces', run.attempt_id);
    const isOverlay = this.currentPrepare?.source_mode === 'git_overlay';
    const workspaceRoot = isOverlay ? attemptDir : join(attemptDir, 'workspace');
    const controlDir = join(attemptDir, 'control');
    const artifactsDir = join(attemptDir, 'artifacts');
    // Canonical spool: {stateDir}/logs/<attempt-id>/ (also RBO_LOG_DIR via AttemptLogPaths)
    const logsDir = join(this.config.stateDir, 'logs', run.attempt_id);

    await mkdir(controlDir, { recursive: true });
    await mkdir(artifactsDir, { recursive: true });

    const spool = await openAttemptSpool(logsDir);
    const logs = spool.logs;
    const logSpoolMaxBytes = this.config.logSpoolMaxBytes ?? DEFAULT_LOG_SPOOL_MAX_BYTES;
    const logSendQueueMax = this.config.logSendQueueMax ?? DEFAULT_LOG_SEND_QUEUE_MAX;
    this.activeSpool = spool;
    this.activeSpoolLease = {
      attemptId: run.attempt_id,
      leaseId: run.lease_id,
      leaseEpoch: run.lease_epoch,
    };
    this.spoolLimitBreached = false;
    this.spoolWriteChain = Promise.resolve();
    const sender = new SpoolSender({
      maxQueue: logSendQueueMax,
      getSpool: () => this.activeSpool ?? spool,
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
    this.activeSpoolSender = sender;
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
        await rm(attemptDir, { recursive: true, force: true }).catch(() => undefined);
        this.clearAttempt();
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
        await rm(attemptDir, { recursive: true, force: true }).catch(() => undefined);
        this.clearAttempt();
        return;
      }
    }

    if (this.cancelSignal.cancelled) {
      this.sendCancelledTerminal(
        run.attempt_id,
        run.lease_id,
        run.lease_epoch,
        'Job cancelled before spawn',
      );
      await rm(attemptDir, { recursive: true, force: true }).catch(() => undefined);
      this.clearAttempt();
      return;
    }

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
        await rm(attemptDir, { recursive: true, force: true }).catch(() => undefined);
        this.clearAttempt();
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
    const acquiredCaches: Array<{
      cacheKey: string;
      kind: BuildCacheKind;
      result: AcquireResult;
    }> = [];

    try {
      await writeJobScript(controlDir, request.execution);

      const projectPath = this.materializedProjectPath ?? join(workspaceRoot, 'main_mount');
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
        projectIdentity: resolveProjectIdentity(offer, this.currentPrepare),
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

      const child = spawnJobScript({
        attemptId: run.attempt_id,
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

      this.sendFrame('job_started', run.attempt_id, run.lease_id, run.lease_epoch, {
        attempt_id: run.attempt_id,
        lease_id: run.lease_id,
        lease_epoch: run.lease_epoch,
        ...(child.pid && child.pid > 0 ? { pid: child.pid } : {}),
      });

      // Register kill before any sync OS lookup so lease-expiry self-term cannot
      // race past spawn with activeProcessKill still null.
      this.activeProcessKill = (grace) => child.kill(grace ?? 10);
      // Keep the same cancelSignal object through waitForCompletion so a cancel
      // that fired during spawn is not wiped.

      if (child.pid && child.pid > 0) {
        const identity = processIdentityFromPid(child.pid);
        if (identity) {
          const risk = request.risk_level ?? 'normal';
          writeAttemptMetadata(this.config.stateDir, {
            attempt_id: run.attempt_id,
            job_id: offer.job_id,
            lease_id: run.lease_id,
            lease_epoch: run.lease_epoch,
            process_identity: identity,
            status: 'running',
            workspace_path: workspaceRoot,
            spool_dir: logsDir,
            risk_level: risk,
            updated_at: new Date().toISOString(),
          });
        }
      }

      // If lease already expired before kill was registered, terminate now.
      if (
        isDestructiveOrHardwareRisk(this.leaseRisk) &&
        this.leaseDeadlineMs !== null &&
        Date.now() >= this.leaseDeadlineMs
      ) {
        if (this.leaseExpired) {
          // Timer already ran with null activeProcessKill — kill now.
          try {
            await this.activeProcessKill(10);
          } catch (error) {
            logger.warn('failed to kill process on late lease-expiry', { error: String(error) });
          }
        } else {
          void this.onLeaseExpired();
        }
      }

      const appendAndEnqueue = (stream: 'stdout' | 'stderr', text: string): Promise<void> => {
        const runAppend = async (): Promise<void> => {
          if (this.spoolLimitBreached) {
            return;
          }
          const { sequence: seq } = await appendChunk(spool, stream, text);
          sender.enqueue({ sequence: seq, stream, bytes: text });
          if ((await totalBytes(spool)) >= logSpoolMaxBytes) {
            this.spoolLimitBreached = true;
            logger.error('log spool limit breached', {
              attemptId: run.attempt_id,
              maxBytes: logSpoolMaxBytes,
            });
            void child.kill(request.execution.cancel_grace_seconds);
          }
        };
        this.spoolWriteChain = this.spoolWriteChain.then(runAppend, runAppend);
        return this.spoolWriteChain;
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

      const result = await waitForCompletion({
        child,
        execution: request.execution,
        logs,
        signal: this.cancelSignal,
      });

      // Drain in-flight spool writes before flush / exit.
      await this.spoolWriteChain.catch(() => undefined);

      for (const [stream, redactor] of [
        ['stdout', stdoutRedactor],
        ['stderr', stderrRedactor],
      ] as const) {
        const flushed = redactor.flush();
        if (flushed) {
          await appendAndEnqueue(stream, flushed);
        }
      }

      let timedOut = false;
      let logFailure = false;
      let durationComplete = false;
      const spoolLimit = this.spoolLimitBreached;

      if (result.type === 'timeout') {
        timedOut = true;
        await child.kill(request.execution.cancel_grace_seconds);
      } else if (result.type === 'duration_complete') {
        durationComplete = true;
        await child.kill(request.execution.cancel_grace_seconds);
      } else if (result.type === 'log_success') {
        await child.kill(request.execution.cancel_grace_seconds);
      } else if (result.type === 'log_failure') {
        logFailure = true;
        await child.kill(request.execution.cancel_grace_seconds);
      }

      const exitCode = result.type === 'exit' ? result.exitCode : null;
      const outcome = this.cancelSignal.cancelled
        ? 'cancelled'
        : spoolLimit
          ? 'failed'
          : timedOut
            ? 'timed_out'
            : logFailure
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
        : this.leaseExpired
          ? {
              failure_category: 'lease_expired' as const,
              failure_message: 'Lease expired — Agent self-terminated destructive/hardware job',
            }
          : outcome === 'failed'
            ? {
                failure_category: 'process_exit' as const,
                failure_message: logFailure
                  ? 'Completion failure_pattern matched in logs'
                  : `Script exited with code ${exitCode}`,
              }
            : outcome === 'timed_out'
              ? {
                  failure_category: 'timeout' as const,
                  failure_message: 'Execution timed out',
                }
              : {};

      const effectiveOutcome = this.leaseExpired
        ? ('failed' as const)
        : this.cancelSignal.cancelled
          ? ('cancelled' as const)
          : outcome;

      if (this.leaseExpired) {
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
      this.persistCompletedAwaitingUpload(offer, run, {
        exit_code: exitCode,
        outcome: effectiveOutcome,
        ...exitExtras,
      });

      this.sendFrame('job_exit', run.attempt_id, run.lease_id, run.lease_epoch, {
        attempt_id: run.attempt_id,
        lease_id: run.lease_id,
        lease_epoch: run.lease_epoch,
        exit_code: exitCode,
        outcome: effectiveOutcome,
        ...exitExtras,
      });

      const collection = await collectArtifactFiles({
        projectPath,
        rules: request.artifacts ?? [],
        tempDir: join(artifactsDir, '.collect-tmp'),
      });

      // Stage under durable artifacts dir for resume (never re-glob workspace later).
      const stagingRoot = join(this.config.stateDir, 'artifacts', run.attempt_id);
      await mkdir(stagingRoot, { recursive: true });
      const stagedManifest: AttemptArtifactManifestItem[] = [];
      for (const f of collection.files) {
        const stagedPath = join(stagingRoot, f.logical_name);
        await mkdir(join(stagedPath, '..'), { recursive: true });
        await copyFile(f.sourcePath, stagedPath);
        stagedManifest.push({
          logical_name: f.logical_name,
          path: stagedPath,
          size_bytes: f.size_bytes,
          sha256: f.sha256,
        });
      }

      this.persistCompletedAwaitingUpload(
        offer,
        run,
        {
          exit_code: exitCode,
          outcome: effectiveOutcome,
          ...exitExtras,
        },
        stagedManifest,
      );

      const artifactItems = stagedManifest.map((f) => ({
        logical_name: f.logical_name,
        path: f.path,
        size_bytes: f.size_bytes,
        sha256: f.sha256,
      }));

      const uploadGrant = await this.requestArtifactUploadTokens(
        run.attempt_id,
        run.lease_id,
        run.lease_epoch,
        artifactItems,
      );

      for (const art of uploadGrant.artifacts) {
        try {
          await this.uploadArtifactFile(
            art.upload_url,
            art.upload_token,
            art.path,
            art.logical_name,
            art.size_bytes,
            art.sha256,
          );
        } catch (error) {
          logger.error('failed artifact upload', {
            artifact: art.logical_name,
            error: String(error),
          });
        }
      }

      const cleanup = await runCleanupScript({
        attemptId: run.attempt_id,
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
      }).catch(() => ({ exitCode: null, timedOut: false }));

      this.sendFrame('cleanup_complete', run.attempt_id, run.lease_id, run.lease_epoch, {
        attempt_id: run.attempt_id,
        lease_id: run.lease_id,
        lease_epoch: run.lease_epoch,
        exit_code: cleanup.exitCode,
        timed_out: cleanup.timedOut,
      });

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
      logger.error('run_job failed', { attemptId: run.attempt_id, error: String(error) });
      this.failTerminal(run.attempt_id, run.lease_id, run.lease_epoch, 'internal', String(error));
    } finally {
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
      if (this.overlayRepoUrl && this.materializedProjectPath) {
        await this.mirrorManager
          .removeWorktree(this.overlayRepoUrl, this.materializedProjectPath)
          .catch(() => undefined);
      }
      await rm(attemptDir, { recursive: true, force: true }).catch(() => undefined);
      this.clearAttempt();
    }
  }

  public handleArtifactUploadGrant(grant: ArtifactUploadGrantPayload): void {
    if (this.pendingArtifactUpload && this.pendingArtifactUpload.attemptId === grant.attempt_id) {
      clearTimeout(this.pendingArtifactUpload.timer);
      const { resolve } = this.pendingArtifactUpload;
      this.pendingArtifactUpload = null;
      resolve(grant);
    }
  }

  /** Controller contiguous log_ack — persist ack.json and advance the sender cursor. */
  public async handleLogAck(ack: LogAckPayload): Promise<void> {
    const lease = this.activeSpoolLease;
    if (
      !lease ||
      lease.attemptId !== ack.attempt_id ||
      lease.leaseId !== ack.lease_id ||
      lease.leaseEpoch !== ack.lease_epoch
    ) {
      return;
    }
    const spool = this.activeSpool;
    const sender = this.activeSpoolSender;
    if (!spool || !sender) {
      return;
    }
    await writeAck(spool, ack.sequence);
    sender.onAck(ack.sequence);
  }

  public async handleCancelJob(cancel: CancelJobPayload): Promise<void> {
    if (!this.matchesReservedLease(cancel.attempt_id, cancel.lease_id, cancel.lease_epoch)) {
      return;
    }
    this.cancelSignal.cancelled = true;
    if (this.activeProcessKill) {
      await this.activeProcessKill(cancel.grace_seconds);
      return;
    }

    // run_job owns the attempt (including pre-spawn): keep cancelSignal for waiters.
    if (this.runInProgress) {
      return;
    }

    // Unblock prepare waiting on bundle_download.
    if (this.pendingBundleDownload?.attemptId === cancel.attempt_id) {
      clearTimeout(this.pendingBundleDownload.timer);
      const pending = this.pendingBundleDownload;
      this.pendingBundleDownload = null;
      pending.reject(new Error('cancelled'));
    }

    const attemptDir = join(this.config.stateDir, 'workspaces', cancel.attempt_id);
    const projectPath = join(attemptDir, 'project');
    if (this.overlayRepoUrl) {
      await this.mirrorManager
        .removeWorktree(this.overlayRepoUrl, projectPath)
        .catch(() => undefined);
    }
    await rm(attemptDir, { recursive: true, force: true }).catch(() => undefined);

    // In-flight prepare (before source_ready): prepare observes cancelSignal / bundle reject.
    if (this.currentPrepare && !this.prepareReady) {
      return;
    }

    // Lease reserved, prepare ready (or not started) — free the slot now.
    this.sendCancelledTerminal(
      cancel.attempt_id,
      cancel.lease_id,
      cancel.lease_epoch,
      cancel.reason ?? 'Job cancelled before process start',
    );
    this.clearAttempt();
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
  ): Promise<ArtifactUploadGrantPayload> {
    return new Promise((resolve, reject) => {
      if (this.pendingArtifactUpload) {
        reject(new Error('artifact upload already pending'));
        return;
      }
      const timer = setTimeout(() => {
        this.pendingArtifactUpload = null;
        reject(new Error('timed out waiting for artifact upload tokens'));
      }, ARTIFACT_TOKEN_TIMEOUT_MS);
      this.pendingArtifactUpload = { attemptId, resolve, reject, timer };
      const manifest: ArtifactManifestPayload = {
        attempt_id: attemptId,
        lease_id: leaseId,
        lease_epoch: leaseEpoch,
        artifacts,
      };
      this.sendFrame(
        'artifact_manifest',
        attemptId,
        leaseId,
        leaseEpoch,
        manifest as unknown as Record<string, unknown>,
      );
    });
  }

  private pinnedTlsOptions(): {
    rejectUnauthorized: false;
    checkServerIdentity: (_host: string, cert: { raw?: Buffer }) => Error | undefined;
  } {
    // Self-signed Controller certs are not in the system trust store. Disable
    // CA trust and pin the peer certificate fingerprint (same model as WS).
    const expected = this.config.controllerFingerprint;
    return {
      rejectUnauthorized: false,
      checkServerIdentity: (_host, cert) => {
        if (!cert.raw) {
          return new Error('Controller did not present a TLS certificate');
        }
        const actual = certificateFingerprint(cert.raw);
        if (actual !== expected) {
          return new Error(
            `Controller certificate fingerprint mismatch: expected ${expected}, got ${actual}`,
          );
        }
        return undefined;
      },
    };
  }

  private downloadSnapshotFile(
    downloadUrl: string,
    dataToken: string,
    destPath: string,
    expectedSize: number,
    expectedSha256: string,
  ): Promise<void> {
    return new Promise<void>((resolvePromise, rejectPromise) => {
      const req = httpsRequest(
        downloadUrl,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${dataToken}`,
          },
          ...this.pinnedTlsOptions(),
        },
        (res) => {
          const pinError = assertPinnedPeerCert(res, this.config.controllerFingerprint);
          if (pinError) {
            res.resume();
            rejectPromise(pinError);
            return;
          }
          if (res.statusCode !== 200) {
            rejectPromise(new Error(`Snapshot download failed with HTTP ${res.statusCode}`));
            return;
          }

          void streamDownloadWithLimits(res, destPath, expectedSize, expectedSha256).then(
            resolvePromise,
            rejectPromise,
          );
        },
      );

      req.on('error', rejectPromise);
      req.end();
    });
  }

  private uploadArtifactFile(
    uploadUrl: string,
    uploadToken: string,
    filePath: string,
    logicalName: string,
    _sizeBytes: number,
    sha256: string,
  ): Promise<void> {
    return new Promise<void>((resolvePromise, rejectPromise) => {
      void stat(filePath)
        .then((info) => {
          const req = httpsRequest(
            uploadUrl,
            {
              method: 'PUT',
              headers: {
                Authorization: `Bearer ${uploadToken}`,
                'Content-Length': info.size,
                'X-RBO-SHA256': sha256,
                'X-RBO-Artifact-Name': logicalName,
              },
              ...this.pinnedTlsOptions(),
            },
            (res) => {
              const pinError = assertPinnedPeerCert(res, this.config.controllerFingerprint);
              if (pinError) {
                res.resume();
                rejectPromise(pinError);
                return;
              }
              res.resume();
              if (res.statusCode === 200) {
                resolvePromise();
              } else {
                rejectPromise(new Error(`Artifact upload failed HTTP ${res.statusCode}`));
              }
            },
          );

          req.on('error', rejectPromise);
          createReadStream(filePath).pipe(req);
        })
        .catch(rejectPromise);
    });
  }
}
