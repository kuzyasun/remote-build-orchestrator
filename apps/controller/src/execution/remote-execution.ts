import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type {
  ArtifactManifestPayload,
  ArtifactUploadGrantPayload,
  BundleDownloadPayload,
  CleanupCompletePayload,
  JobExitPayload,
  JobStartedPayload,
  LeaseAcceptPayload,
  LeaseOfferPayload,
  LeaseRejectPayload,
  LogChunkPayload,
  PrepareSourcePayload,
  RunJobPayload,
  SourceNeedPayload,
  SourceReadyPayload,
  ToolchainProfileSchema,
} from '@rbo/protocol';
import type { ControllerIdentity } from '@rbo/shared';
import { RboError, createLogger, generateId, sha256File } from '@rbo/shared';
import { captureFullSnapshot, discardCapturedContent } from '@rbo/snapshot';
import type { WebSocket } from 'ws';
import type { z } from 'zod';
import { DEFAULT_MAX_GIT_BUNDLE_BYTES } from '../config.js';
import {
  clearArtifactExpectations,
  filterMissingArtifacts,
  registerArtifactExpectations,
} from '../http/data-plane.js';
import {
  assertJobLifecycleWriteAllowed,
  notifyJobLifecycleChanged,
} from '../jobs/lifecycle-notifier.js';
import {
  bumpLeaseEpoch,
  createJobEvent,
  getJob,
  getJobRequest,
  getLatestAttempt,
  nextLeaseEpochForJob,
  recordEvent,
  transitionAttemptState,
  transitionJobState,
  updateAttempt,
} from '../jobs/lifecycle.js';
import { persistAndPublishLogChunk } from '../logs/stream.js';
import { processIdentityFromPid } from '../recovery/coordinator.js';
import { issueDataToken } from '../security/data-tokens.js';
import type { ControllerDatabase } from '../storage/database.js';
import { nowIso } from '../storage/database.js';
import type { ConnectedAgent } from '../websocket/server.js';
import { attemptTransferDir } from './runner.js';

const execFileAsync = promisify(execFile);

export { DEFAULT_MAX_GIT_BUNDLE_BYTES };

type ToolchainProfile = z.infer<typeof ToolchainProfileSchema>;

const logger = createLogger('controller.remote-execution');
const DEFAULT_LEASE_TTL_SECONDS = 300;

export interface RemoteExecutionOptions {
  db: ControllerDatabase;
  identity: ControllerIdentity;
  dataDir: string;
  connectedAgents: Map<string, ConnectedAgent>;
  serverPort: number;
  /**
   * Host/IP remote Agents use to reach the Controller data plane.
   * Defaults to 127.0.0.1 (local e2e). Override for LAN/remote Agents.
   */
  controllerPublicHost?: string;
  /** Full base URL override (e.g. https://192.168.1.10:7411). Wins over host+port. */
  dataPlaneBaseUrl?: string;
  allowedProjectRoots?: string[];
  /** Metadata-admission limits for on-demand full snapshot transfer fallback (§4.3). */
  snapshotCaptureLimits?: import('@rbo/snapshot').SnapshotCaptureLimits;
  /** Max git bundle bytes; defaults to DEFAULT_MAX_GIT_BUNDLE_BYTES. */
  maxGitBundleBytes?: number;
  /**
   * Controller-level queue policy used as the safety-net in `handleRemoteLeaseReject` when a job's
   * persisted `queue_policy` is absent (legacy rows). Normally already concrete after submit-time
   * normalization.
   */
  defaultQueuePolicy?: import('@rbo/protocol').QueuePolicy;
}

function snapshotManifestMode(manifest: unknown): 'full' | 'git_overlay' {
  if (
    manifest &&
    typeof manifest === 'object' &&
    'payload' in manifest &&
    manifest.payload &&
    typeof manifest.payload === 'object' &&
    'mode' in manifest.payload &&
    manifest.payload.mode === 'git_overlay'
  ) {
    return 'git_overlay';
  }
  return 'full';
}

/** Derive targeted fetch refs (§10.6) from manifest repo fields. */
function resolveFetchRefs(repo: Record<string, unknown>): string[] {
  if (Array.isArray(repo.fetch_refs) && repo.fetch_refs.length > 0) {
    return repo.fetch_refs.map((ref) => String(ref));
  }
  const branch = repo.branch == null ? null : String(repo.branch);
  if (branch && branch.length > 0) {
    return [`refs/heads/${branch}`];
  }
  return [];
}

function loadSnapshotForJob(
  db: ControllerDatabase,
  jobId: string,
): { size_bytes: number; sha256: string; manifest_path: string; payload_path: string } | undefined {
  return db
    .prepare(
      `SELECT s.size_bytes, s.sha256, s.manifest_path, s.payload_path
       FROM jobs j JOIN snapshots s ON j.snapshot_id = s.id
       WHERE j.id = ?`,
    )
    .get(jobId) as
    | { size_bytes: number; sha256: string; manifest_path: string; payload_path: string }
    | undefined;
}

function sendPrepareSource(
  opts: RemoteExecutionOptions,
  agentId: string,
  attemptId: string,
  leaseId: string,
  leaseEpoch: number,
  jobId: string,
  manifest: unknown,
  snapshotRow: { size_bytes: number; sha256: string; payload_path: string },
): void {
  const mode = snapshotManifestMode(manifest);
  const baseUrl = resolveDataPlaneBaseUrl(opts);

  if (mode === 'git_overlay' && manifest && typeof manifest === 'object') {
    const repo = (manifest as { repo?: Record<string, unknown> }).repo;
    const payload = (manifest as { payload?: { size?: number; sha256?: string } }).payload;
    if (!repo?.url || !repo.base_commit || !payload?.sha256 || payload.size == null) {
      failAttemptPrepare(opts, attemptId, jobId, 'materialization', 'Invalid git_overlay manifest');
      return;
    }

    const overlayToken = issueDataToken(opts.identity, {
      agent_id: agentId,
      job_id: jobId,
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: leaseEpoch,
      op: 'overlay_download',
    });
    const overlayUrl = `${baseUrl}/data/v1/attempts/${attemptId}/overlay`;

    const preparePayload: PrepareSourcePayload = {
      source_mode: 'git_overlay',
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: leaseEpoch,
      repo: {
        url: String(repo.url),
        canonical_id: String(repo.canonical_id ?? repo.url),
        branch: repo.branch == null ? null : String(repo.branch),
        base_commit: String(repo.base_commit),
        fetch_refs: resolveFetchRefs(repo),
      },
      overlay: {
        download_url: overlayUrl,
        data_token: overlayToken,
        expected_size_bytes: payload.size,
        expected_sha256: payload.sha256,
      },
      manifest,
    };

    const conn = opts.connectedAgents.get(agentId);
    if (conn) {
      sendWsFrame(
        conn.socket,
        'prepare_source',
        attemptId,
        leaseId,
        leaseEpoch,
        preparePayload as unknown as Record<string, unknown>,
      );
    }
    return;
  }

  const dataToken = issueDataToken(opts.identity, {
    agent_id: agentId,
    job_id: jobId,
    attempt_id: attemptId,
    lease_id: leaseId,
    lease_epoch: leaseEpoch,
    op: 'snapshot_download',
  });
  const downloadUrl = `${baseUrl}/data/v1/attempts/${attemptId}/snapshot`;

  const preparePayload: PrepareSourcePayload = {
    source_mode: 'full',
    attempt_id: attemptId,
    lease_id: leaseId,
    lease_epoch: leaseEpoch,
    download_url: downloadUrl,
    data_token: dataToken,
    expected_size_bytes: snapshotRow.size_bytes,
    expected_sha256: snapshotRow.sha256,
    manifest,
  };

  const conn = opts.connectedAgents.get(agentId);
  if (conn) {
    sendWsFrame(
      conn.socket,
      'prepare_source',
      attemptId,
      leaseId,
      leaseEpoch,
      preparePayload as unknown as Record<string, unknown>,
    );
  }
}

function failAttemptPrepare(
  opts: RemoteExecutionOptions,
  attemptId: string,
  jobId: string,
  category: NonNullable<JobExitPayload['failure_category']>,
  message: string,
): void {
  transitionAttemptState(opts.db, attemptId, 'completed', {
    outcome: 'failed',
    finished_at: nowIso(),
  });
  transitionJobState(opts.db, jobId, 'completed', {
    outcome: 'failed',
    finished_at: nowIso(),
    failure_category: category,
    failure_message: message,
  });
}

export class GitBundleSizeExceededError extends Error {
  constructor(
    readonly sizeBytes: number,
    readonly maxBytes: number,
  ) {
    super(`Git bundle size ${sizeBytes} bytes exceeds maximum ${maxBytes} bytes`);
    this.name = 'GitBundleSizeExceededError';
  }
}

export async function createGitBundle(
  projectRoot: string,
  baseCommit: string,
  bundlePath: string,
  maxBytes: number = DEFAULT_MAX_GIT_BUNDLE_BYTES,
): Promise<{ sizeBytes: number; sha256: string }> {
  await mkdir(dirname(bundlePath), { recursive: true });
  const { stdout: head } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: projectRoot,
    windowsHide: true,
  });
  const headCommit = head.trim();
  await execFileAsync('git', ['cat-file', '-e', `${baseCommit}^{commit}`], {
    cwd: projectRoot,
    windowsHide: true,
  });
  const bundleRef = headCommit === baseCommit ? 'HEAD' : baseCommit;
  try {
    await execFileAsync('git', ['bundle', 'create', bundlePath, bundleRef], {
      cwd: projectRoot,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
  } catch {
    await execFileAsync('git', ['bundle', 'create', bundlePath, '--all'], {
      cwd: projectRoot,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
  }
  // Check the on-disk size first — `git bundle create` already wrote the whole bundle
  // unconditionally, but a stat is cheap; it lets an oversized bundle be rejected and deleted
  // without also loading the entire (potentially multi-GB) file into a Buffer just to throw it
  // away. This bounds Controller memory even though disk usage during the git subprocess's own
  // write is not itself streamed/aborted early — that would need piping `git bundle create -`
  // through a size-limiting transform, a larger change than this fix covers.
  const { size: sizeBytes } = await stat(bundlePath);
  if (sizeBytes > maxBytes) {
    await rm(bundlePath, { force: true });
    throw new GitBundleSizeExceededError(sizeBytes, maxBytes);
  }
  const data = await readFile(bundlePath);
  return {
    sizeBytes: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
  };
}

async function ensureFullFallbackArchive(
  opts: RemoteExecutionOptions,
  attemptId: string,
  jobId: string,
): Promise<{
  archivePath: string;
  sizeBytes: number;
  sha256: string;
  manifest: unknown;
} | null> {
  const request = getJobRequest(opts.db, jobId);
  if (!request) {
    return null;
  }

  const transferDir = attemptTransferDir(opts.dataDir, attemptId);
  const archivePath = join(transferDir, 'snapshot.tar.zst');
  const manifestPath = join(transferDir, 'snapshot.manifest.json');
  try {
    const existing = await stat(archivePath);
    const sha256 = await sha256File(archivePath);
    const manifestRaw = await readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestRaw) as {
      payload?: { sha256?: string; size?: number };
    };
    if (manifest.payload?.sha256 === sha256 && manifest.payload?.size === existing.size) {
      return {
        archivePath,
        sizeBytes: existing.size,
        sha256,
        manifest,
      };
    }
    // Stale cache: recreate below.
  } catch {
    // create on demand
  }

  await mkdir(transferDir, { recursive: true });
  const captured = await captureFullSnapshot({
    projectRoot: request.source.project_root,
    allowedProjectRoots: opts.allowedProjectRoots ?? [request.source.project_root],
    cwd: request.source.cwd,
    sourcePolicy: {
      include_untracked: request.source_policy?.include_untracked ?? true,
      include_ignored: request.source_policy?.include_ignored ?? [],
      secret_policy: request.source_policy?.secret_policy ?? 'block',
    },
    additionalRoots: request.source.additional_roots,
    contentStorageDir: transferDir,
    limits: opts.snapshotCaptureLimits,
  });
  try {
    await copyFile(captured.archivePath, archivePath);
    await writeFile(manifestPath, JSON.stringify(captured.manifest, null, 2));
    return {
      archivePath,
      sizeBytes: captured.manifest.payload.size,
      sha256: captured.manifest.payload.sha256,
      manifest: captured.manifest,
    };
  } finally {
    // `captureFullSnapshot` always writes into a private child of transferDir.
    // The stable transfer artifacts above are the only files this fallback owns
    // after the copy attempt, so discard the candidate on both success and error.
    await discardCapturedContent(captured.contentStorageDir);
  }
}

function resolveDataPlaneBaseUrl(opts: RemoteExecutionOptions): string {
  if (opts.dataPlaneBaseUrl) {
    return opts.dataPlaneBaseUrl.replace(/\/$/, '');
  }
  const host = opts.controllerPublicHost ?? '127.0.0.1';
  return `https://${host}:${opts.serverPort}`;
}

interface AttemptLeaseRow {
  id: string;
  job_id: string;
  agent_id: string;
  state: string;
  lease_id: string;
  lease_epoch: number;
  lease_deadline: string | null;
  outcome: string | null;
  log_acked_sequence: number;
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

function loadAttemptByLease(
  db: ControllerDatabase,
  attemptId: string,
  leaseId: string,
  leaseEpoch: number,
): AttemptLeaseRow | undefined {
  return db
    .prepare(
      `SELECT id, job_id, agent_id, state, lease_id, lease_epoch, lease_deadline, outcome,
              log_acked_sequence
       FROM job_attempts WHERE id = ? AND lease_id = ? AND lease_epoch = ?`,
    )
    .get(attemptId, leaseId, leaseEpoch) as AttemptLeaseRow | undefined;
}

function isLeaseExpired(attempt: AttemptLeaseRow, now = Date.now()): boolean {
  if (!attempt.lease_deadline) {
    return false;
  }
  return Date.parse(attempt.lease_deadline) <= now;
}

function rejectStale(
  label: string,
  attempt: AttemptLeaseRow | undefined,
  agentId: string,
  expectedStates?: string[],
): attempt is AttemptLeaseRow {
  if (!attempt || attempt.agent_id !== agentId) {
    logger.warn(`stale or invalid ${label} ignored`, { agentId });
    return false;
  }
  if (isLeaseExpired(attempt)) {
    logger.warn(`expired lease ${label} ignored`, { attemptId: attempt.id, agentId });
    return false;
  }
  if (expectedStates && !expectedStates.includes(attempt.state)) {
    logger.warn(`unexpected state for ${label} ignored`, {
      attemptId: attempt.id,
      state: attempt.state,
      expectedStates,
    });
    return false;
  }
  return true;
}

export function renewActiveLease(
  db: ControllerDatabase,
  agentId: string,
  ttlSeconds = DEFAULT_LEASE_TTL_SECONDS,
): void {
  const deadline = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  db.prepare(
    `UPDATE job_attempts
     SET lease_deadline = ?
     WHERE agent_id = ?
       AND state NOT IN ('completed')
       AND lease_deadline IS NOT NULL`,
  ).run(deadline, agentId);
}

export function expireStaleLeases(db: ControllerDatabase): void {
  const now = nowIso();
  const rows = db
    .prepare(
      `SELECT id, job_id FROM job_attempts
       WHERE state NOT IN ('completed', 'orphaned')
         AND lease_deadline IS NOT NULL
         AND lease_deadline <= ?`,
    )
    .all(now) as Array<{ id: string; job_id: string }>;

  for (const row of rows) {
    transitionAttemptState(db, row.id, 'completed', {
      outcome: 'failed',
      finished_at: now,
    });
    transitionJobState(db, row.job_id, 'completed', {
      outcome: 'failed',
      finished_at: now,
      failure_category: 'agent_disconnected',
      failure_message: 'Lease expired during remote execution',
    });
  }
}

export async function initiateRemoteAttempt(
  opts: RemoteExecutionOptions,
  jobId: string,
  agentId: string,
  selectedToolchains?: ToolchainProfile[],
): Promise<string> {
  const job = getJob(opts.db, jobId);
  if (!job) {
    throw RboError.validation(`Unknown job ${jobId}`);
  }

  const agentConn = opts.connectedAgents.get(agentId);
  if (!agentConn || agentConn.socket.readyState !== agentConn.socket.OPEN) {
    throw RboError.internal(`Agent ${agentId} is not connected`);
  }

  const snapshotRow = opts.db
    .prepare('SELECT id, content_id, size_bytes, sha256 FROM snapshots WHERE id = ?')
    .get(job.snapshot_id) as
    | { id: string; content_id: string; size_bytes: number; sha256: string }
    | undefined;

  if (!snapshotRow) {
    throw RboError.internal(`Missing snapshot metadata for job ${jobId}`);
  }
  if (!snapshotRow.sha256 || snapshotRow.size_bytes == null) {
    throw RboError.internal(`Snapshot ${snapshotRow.id} is missing size/sha256 metadata`);
  }

  const leaseId = generateId('lease');
  const leaseEpoch = nextLeaseEpochForJob(opts.db, jobId);
  const leaseDeadline = new Date(Date.now() + DEFAULT_LEASE_TTL_SECONDS * 1000).toISOString();
  const attemptId = generateId('att');
  const maxOrdinal = opts.db
    .prepare('SELECT MAX(ordinal) AS max_ordinal FROM job_attempts WHERE job_id = ?')
    .get(jobId) as { max_ordinal: number | null } | undefined;
  const ordinal = (maxOrdinal?.max_ordinal ?? 0) + 1;

  opts.db
    .prepare(
      `INSERT INTO job_attempts (id, job_id, ordinal, agent_id, lease_id, lease_epoch, lease_deadline, state, toolchain_profiles_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'leasing', ?)`,
    )
    .run(
      attemptId,
      jobId,
      ordinal,
      agentId,
      leaseId,
      leaseEpoch,
      leaseDeadline,
      selectedToolchains && selectedToolchains.length > 0
        ? JSON.stringify(selectedToolchains)
        : null,
    );

  transitionJobState(opts.db, jobId, 'leasing');

  const request = JSON.parse(
    (
      opts.db.prepare('SELECT request_json FROM jobs WHERE id = ?').get(jobId) as {
        request_json: string;
      }
    ).request_json,
  );

  const offerPayload: LeaseOfferPayload = {
    attempt_id: attemptId,
    lease_id: leaseId,
    lease_epoch: leaseEpoch,
    job_id: jobId,
    job_request: request,
    snapshot_metadata: {
      snapshot_id: snapshotRow.id,
      content_id: snapshotRow.content_id,
      size_bytes: snapshotRow.size_bytes,
      sha256: snapshotRow.sha256,
    },
    selected_toolchain_profiles:
      selectedToolchains && selectedToolchains.length > 0 ? selectedToolchains : undefined,
    lease_ttl_seconds: DEFAULT_LEASE_TTL_SECONDS,
  };

  sendWsFrame(
    agentConn.socket,
    'lease_offer',
    attemptId,
    leaseId,
    leaseEpoch,
    offerPayload as unknown as Record<string, unknown>,
  );
  return attemptId;
}

export function handleRemoteLeaseAccept(
  opts: RemoteExecutionOptions,
  agentId: string,
  payload: LeaseAcceptPayload,
): void {
  const attempt = loadAttemptByLease(
    opts.db,
    payload.attempt_id,
    payload.lease_id,
    payload.lease_epoch,
  );
  if (!rejectStale('lease_accept', attempt, agentId, ['leasing'])) {
    return;
  }

  transitionAttemptState(opts.db, attempt.id, 'preparing_source');
  transitionJobState(opts.db, attempt.job_id, 'preparing_source');

  const snapshotRow = loadSnapshotForJob(opts.db, attempt.job_id);

  if (!snapshotRow?.sha256 || snapshotRow.size_bytes == null || !snapshotRow.payload_path) {
    failAttemptPrepare(
      opts,
      attempt.id,
      attempt.job_id,
      'materialization',
      'Snapshot metadata missing size, sha256, or payload path',
    );
    return;
  }

  let manifest: unknown;
  if (snapshotRow.manifest_path) {
    try {
      manifest = JSON.parse(readFileSync(snapshotRow.manifest_path, 'utf8'));
    } catch {
      // ignore read error; Agent materialization will fail closed
    }
  }

  sendPrepareSource(
    opts,
    agentId,
    attempt.id,
    payload.lease_id,
    payload.lease_epoch,
    attempt.job_id,
    manifest,
    snapshotRow,
  );
}

export async function handleRemoteSourceNeed(
  opts: RemoteExecutionOptions,
  agentId: string,
  payload: SourceNeedPayload,
): Promise<void> {
  const attempt = loadAttemptByLease(
    opts.db,
    payload.attempt_id,
    payload.lease_id,
    payload.lease_epoch,
  );
  if (!rejectStale('source_need', attempt, agentId, ['preparing_source'])) {
    return;
  }

  if (payload.reason === 'base_present') {
    return;
  }

  const conn = opts.connectedAgents.get(agentId);
  if (!conn) {
    return;
  }

  if (payload.reason === 'base_commit_missing' || payload.reason === 'bundle_required') {
    const request = getJobRequest(opts.db, attempt.job_id);
    const snapshotRow = loadSnapshotForJob(opts.db, attempt.job_id);
    if (!request || !snapshotRow?.manifest_path) {
      failAttemptPrepare(
        opts,
        attempt.id,
        attempt.job_id,
        'materialization',
        'Cannot create bundle: missing job request or manifest',
      );
      return;
    }

    let manifest: { repo?: { base_commit?: string } };
    try {
      manifest = JSON.parse(readFileSync(snapshotRow.manifest_path, 'utf8')) as {
        repo?: { base_commit?: string };
      };
    } catch {
      failAttemptPrepare(
        opts,
        attempt.id,
        attempt.job_id,
        'materialization',
        'Cannot create bundle: manifest unreadable',
      );
      return;
    }

    const baseCommit = manifest.repo?.base_commit;
    if (!baseCommit) {
      failAttemptPrepare(
        opts,
        attempt.id,
        attempt.job_id,
        'materialization',
        'Cannot create bundle: manifest missing base_commit',
      );
      return;
    }

    const transferDir = attemptTransferDir(opts.dataDir, attempt.id);
    const bundlePath = join(transferDir, 'bundle.gitbundle');
    try {
      const maxBundleBytes = opts.maxGitBundleBytes ?? DEFAULT_MAX_GIT_BUNDLE_BYTES;
      const { sizeBytes, sha256 } = await createGitBundle(
        request.source.project_root,
        baseCommit,
        bundlePath,
        maxBundleBytes,
      );
      const bundleToken = issueDataToken(opts.identity, {
        agent_id: agentId,
        job_id: attempt.job_id,
        attempt_id: attempt.id,
        lease_id: payload.lease_id,
        lease_epoch: payload.lease_epoch,
        op: 'bundle_download',
      });
      const bundleUrl = `${resolveDataPlaneBaseUrl(opts)}/data/v1/attempts/${attempt.id}/bundle`;
      const bundlePayload: BundleDownloadPayload = {
        attempt_id: attempt.id,
        lease_id: payload.lease_id,
        lease_epoch: payload.lease_epoch,
        download_url: bundleUrl,
        data_token: bundleToken,
        expected_size_bytes: sizeBytes,
        expected_sha256: sha256,
      };
      sendWsFrame(
        conn.socket,
        'bundle_download',
        attempt.id,
        payload.lease_id,
        payload.lease_epoch,
        bundlePayload as unknown as Record<string, unknown>,
      );
    } catch (error) {
      failAttemptPrepare(
        opts,
        attempt.id,
        attempt.job_id,
        'materialization',
        `Failed to create git bundle: ${String(error)}`,
      );
    }
    return;
  }

  if (payload.reason === 'full_snapshot_required' || payload.reason === 'repo_fetch_failed') {
    const snapshotRow = loadSnapshotForJob(opts.db, attempt.job_id);
    if (!snapshotRow) {
      failAttemptPrepare(
        opts,
        attempt.id,
        attempt.job_id,
        'repo_fetch',
        'No snapshot available for full-mode fallback',
      );
      return;
    }

    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(snapshotRow.manifest_path, 'utf8'));
    } catch {
      manifest = undefined;
    }

    if (snapshotManifestMode(manifest) === 'full') {
      sendPrepareSource(
        opts,
        agentId,
        attempt.id,
        payload.lease_id,
        payload.lease_epoch,
        attempt.job_id,
        manifest,
        snapshotRow,
      );
      return;
    }

    const fallback = await ensureFullFallbackArchive(opts, attempt.id, attempt.job_id);
    if (!fallback) {
      failAttemptPrepare(
        opts,
        attempt.id,
        attempt.job_id,
        'repo_fetch',
        'Full snapshot fallback unavailable',
      );
      return;
    }

    const dataToken = issueDataToken(opts.identity, {
      agent_id: agentId,
      job_id: attempt.job_id,
      attempt_id: attempt.id,
      lease_id: payload.lease_id,
      lease_epoch: payload.lease_epoch,
      op: 'snapshot_download',
    });
    const downloadUrl = `${resolveDataPlaneBaseUrl(opts)}/data/v1/attempts/${attempt.id}/snapshot`;
    const preparePayload: PrepareSourcePayload = {
      source_mode: 'full',
      attempt_id: attempt.id,
      lease_id: payload.lease_id,
      lease_epoch: payload.lease_epoch,
      download_url: downloadUrl,
      data_token: dataToken,
      expected_size_bytes: fallback.sizeBytes,
      expected_sha256: fallback.sha256,
      manifest: fallback.manifest,
    };
    sendWsFrame(
      conn.socket,
      'prepare_source',
      attempt.id,
      payload.lease_id,
      payload.lease_epoch,
      preparePayload as unknown as Record<string, unknown>,
    );
  }
}

export function handleRemoteLeaseReject(
  opts: RemoteExecutionOptions,
  agentId: string,
  payload: LeaseRejectPayload,
): void {
  const attempt = loadAttemptByLease(
    opts.db,
    payload.attempt_id,
    payload.lease_id,
    payload.lease_epoch,
  );
  if (!rejectStale('lease_reject', attempt, agentId, ['leasing'])) {
    return;
  }

  // Abandon only this offer/attempt. Capacity-race rejects must not hard-fail
  // wait (or other rematch-eligible) jobs — re-queue for later dispatch.
  bumpLeaseEpoch(opts.db, attempt.id);
  transitionAttemptState(opts.db, attempt.id, 'completed', {
    outcome: 'failed',
    finished_at: nowIso(),
  });

  const request = getJobRequest(opts.db, attempt.job_id);
  const queuePolicy = request?.queue_policy ?? opts.defaultQueuePolicy ?? 'local_fallback';
  if (queuePolicy === 'fail_fast') {
    transitionJobState(opts.db, attempt.job_id, 'completed', {
      outcome: 'failed',
      finished_at: nowIso(),
      failure_category: 'no_capacity',
      failure_message: `Agent rejected lease offer: ${payload.reason}`,
    });
    return;
  }

  assertJobLifecycleWriteAllowed(opts.db);
  opts.db
    .prepare(
      `UPDATE jobs
       SET state = 'queued',
           outcome = NULL,
           finished_at = NULL,
           failure_category = NULL,
           failure_message = NULL,
           queued_at = COALESCE(queued_at, ?),
           updated_at = ?
       WHERE id = ?`,
    )
    .run(nowIso(), nowIso(), attempt.job_id);
  notifyJobLifecycleChanged(opts.db, attempt.job_id);
}

/**
 * Send typed `cancel_job` to the Agent for an in-flight remote attempt.
 * Does not mark the job terminal — Agent kill + job_exit/cleanup with
 * cancelled outcome (or disconnect) finalizes state.
 */
export function requestRemoteJobCancel(
  opts: Pick<RemoteExecutionOptions, 'db' | 'connectedAgents'>,
  jobId: string,
  reason?: string,
): boolean {
  const attempt = getLatestAttempt(opts.db, jobId);
  if (!attempt?.agent_id || attempt.state === 'completed') {
    return false;
  }
  if (!attempt.lease_id) {
    return false;
  }

  const conn = opts.connectedAgents.get(attempt.agent_id);
  if (!conn || conn.socket.readyState !== conn.socket.OPEN) {
    return false;
  }

  const request = getJobRequest(opts.db, jobId);
  const graceSeconds = request?.execution.cancel_grace_seconds ?? 10;

  sendWsFrame(conn.socket, 'cancel_job', attempt.id, attempt.lease_id, attempt.lease_epoch, {
    attempt_id: attempt.id,
    lease_id: attempt.lease_id,
    lease_epoch: attempt.lease_epoch,
    grace_seconds: graceSeconds,
    ...(reason ? { reason } : {}),
  });
  return true;
}

export function handleRemoteSourceReady(
  opts: RemoteExecutionOptions,
  agentId: string,
  payload: SourceReadyPayload,
): void {
  const attempt = loadAttemptByLease(
    opts.db,
    payload.attempt_id,
    payload.lease_id,
    payload.lease_epoch,
  );
  if (!rejectStale('source_ready', attempt, agentId, ['preparing_source'])) {
    return;
  }

  transitionAttemptState(opts.db, attempt.id, 'running');
  transitionJobState(opts.db, attempt.job_id, 'running', { started_at: nowIso() });

  const runPayload: RunJobPayload = {
    attempt_id: attempt.id,
    lease_id: payload.lease_id,
    lease_epoch: payload.lease_epoch,
  };

  const conn = opts.connectedAgents.get(agentId);
  if (conn) {
    sendWsFrame(
      conn.socket,
      'run_job',
      attempt.id,
      payload.lease_id,
      payload.lease_epoch,
      runPayload as unknown as Record<string, unknown>,
    );
  }
}

export async function handleRemoteLogChunk(
  opts: RemoteExecutionOptions,
  agentId: string,
  payload: LogChunkPayload,
): Promise<void> {
  const attempt = loadAttemptByLease(
    opts.db,
    payload.attempt_id,
    payload.lease_id,
    payload.lease_epoch,
  );
  if (!rejectStale('log_chunk', attempt, agentId, ['running', 'collecting_artifacts'])) {
    return;
  }

  const prev = attempt.log_acked_sequence ?? 0;
  const sendAck = (): void => {
    const conn = opts.connectedAgents.get(agentId);
    if (!conn) {
      return;
    }
    sendWsFrame(conn.socket, 'log_ack', attempt.id, payload.lease_id, payload.lease_epoch, {
      attempt_id: attempt.id,
      lease_id: payload.lease_id,
      lease_epoch: payload.lease_epoch,
      sequence: payload.sequence,
    });
  };

  if (payload.sequence <= prev) {
    // Duplicate / already acked — re-ack without appending.
    sendAck();
    return;
  }
  if (payload.sequence !== prev + 1) {
    // Out-of-order gap — do not append; agent must replay in order.
    logger.warn('out-of-order log_chunk ignored', {
      attemptId: attempt.id,
      sequence: payload.sequence,
      expected: prev + 1,
    });
    return;
  }

  // Durable write + index + live publish, then ack (observer path must not
  // affect Agent spool reliability).
  await persistAndPublishLogChunk({
    dataDir: opts.dataDir,
    attemptId: attempt.id,
    stream: payload.stream,
    chunk: payload.bytes,
    sequence: payload.sequence,
  });
  updateAttempt(opts.db, attempt.id, { log_acked_sequence: payload.sequence });
  sendAck();
}

/** Per-attempt chain so concurrent WS handlers cannot race log_acked_sequence. */
const logChunkChains = new Map<string, Promise<void>>();

/**
 * Serialize log_chunk handling per attempt. The agent plane dispatches WS
 * messages with `void` (non-blocking); without this queue, two in-flight
 * handlers can both observe the same log_acked_sequence and drop contiguous
 * chunks as "out-of-order".
 */
export function enqueueRemoteLogChunk(
  opts: RemoteExecutionOptions,
  agentId: string,
  payload: LogChunkPayload,
): Promise<void> {
  const key = payload.attempt_id;
  const prev = logChunkChains.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(() => handleRemoteLogChunk(opts, agentId, payload));
  logChunkChains.set(key, next);
  void next.finally(() => {
    if (logChunkChains.get(key) === next) {
      logChunkChains.delete(key);
    }
  });
  return next;
}

export function handleRemoteJobStarted(
  opts: RemoteExecutionOptions,
  agentId: string,
  payload: JobStartedPayload,
): void {
  const attempt = loadAttemptByLease(
    opts.db,
    payload.attempt_id,
    payload.lease_id,
    payload.lease_epoch,
  );
  if (!rejectStale('job_started', attempt, agentId, ['running'])) {
    return;
  }

  if (payload.pid && payload.pid > 0) {
    const process_identity = processIdentityFromPid(payload.pid);
    if (process_identity) {
      updateAttempt(opts.db, attempt.id, { process_identity });
    }
  }

  const event = createJobEvent(opts.db, {
    type: 'process_started',
    job_id: attempt.job_id,
    attempt_id: attempt.id,
    workspace: 'remote',
    ...(payload.pid ? { pid: payload.pid } : {}),
  });
  recordEvent(opts.db, event);
}

export function handleRemoteJobExit(
  opts: RemoteExecutionOptions,
  agentId: string,
  payload: JobExitPayload,
): void {
  const attempt = loadAttemptByLease(
    opts.db,
    payload.attempt_id,
    payload.lease_id,
    payload.lease_epoch,
  );
  if (
    !rejectStale('job_exit', attempt, agentId, [
      'leasing',
      'preparing_source',
      'running',
      'orphaned',
      'collecting_artifacts',
    ])
  ) {
    return;
  }

  // Persist process outcome here; cleanup_complete only finalizes the attempt.
  transitionAttemptState(opts.db, attempt.id, 'collecting_artifacts', {
    outcome: payload.outcome,
  });
  updateAttempt(opts.db, attempt.id, { orphaned_at: null });
  assertJobLifecycleWriteAllowed(opts.db);
  opts.db
    .prepare(
      `UPDATE jobs SET exit_code = ?, failure_category = ?, failure_message = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      payload.exit_code,
      payload.failure_category ?? null,
      payload.failure_message ?? null,
      nowIso(),
      attempt.job_id,
    );
  notifyJobLifecycleChanged(opts.db, attempt.job_id);
  transitionJobState(opts.db, attempt.job_id, 'collecting_artifacts');
}

export function handleRemoteArtifactManifest(
  opts: RemoteExecutionOptions,
  agentId: string,
  payload: ArtifactManifestPayload,
): void {
  const attempt = loadAttemptByLease(
    opts.db,
    payload.attempt_id,
    payload.lease_id,
    payload.lease_epoch,
  );
  if (!rejectStale('artifact_manifest', attempt, agentId, ['collecting_artifacts'])) {
    return;
  }

  // Register full manifest expectations, then grant tokens only for missing objects.
  registerArtifactExpectations(attempt.id, payload.artifacts);

  void filterMissingArtifacts(opts.dataDir, attempt.id, payload.artifacts).then((missing) => {
    const pathByName = new Map(payload.artifacts.map((a) => [a.logical_name, a.path]));
    const artifactsWithTokens = missing.map((art) => {
      const uploadToken = issueDataToken(opts.identity, {
        agent_id: agentId,
        job_id: attempt.job_id,
        attempt_id: attempt.id,
        lease_id: payload.lease_id,
        lease_epoch: payload.lease_epoch,
        op: 'artifact_upload',
        artifact_id: art.logical_name,
      });
      const uploadUrl = `${resolveDataPlaneBaseUrl(opts)}/data/v1/attempts/${attempt.id}/artifacts/${encodeURIComponent(art.logical_name)}`;
      return {
        logical_name: art.logical_name,
        path: pathByName.get(art.logical_name) ?? art.logical_name,
        size_bytes: art.size_bytes,
        sha256: art.sha256,
        upload_token: uploadToken,
        upload_url: uploadUrl,
      };
    });

    const responsePayload: ArtifactUploadGrantPayload = {
      attempt_id: attempt.id,
      lease_id: payload.lease_id,
      lease_epoch: payload.lease_epoch,
      artifacts: artifactsWithTokens,
    };

    const conn = opts.connectedAgents.get(agentId);
    if (conn) {
      sendWsFrame(
        conn.socket,
        'artifact_upload_grant',
        attempt.id,
        payload.lease_id,
        payload.lease_epoch,
        responsePayload as unknown as Record<string, unknown>,
      );
    }
  });
}

export function handleRemoteCleanupComplete(
  opts: RemoteExecutionOptions,
  agentId: string,
  payload: CleanupCompletePayload,
): void {
  const attempt = loadAttemptByLease(
    opts.db,
    payload.attempt_id,
    payload.lease_id,
    payload.lease_epoch,
  );
  if (!rejectStale('cleanup_complete', attempt, agentId, ['collecting_artifacts'])) {
    return;
  }

  clearArtifactExpectations(attempt.id);

  const job = getJob(opts.db, attempt.job_id);
  const outcome =
    attempt.outcome ??
    (payload.timed_out ? 'timed_out' : payload.exit_code === 0 ? 'succeeded' : 'failed');
  // Prefer process exit_code from job_exit (including intentional null for cancel/timeout).
  // Do not adopt cleanup script exit_code 0 over a null process exit.
  const exitCode =
    attempt.outcome != null ? (job?.exit_code ?? null) : (job?.exit_code ?? payload.exit_code);

  if (payload.timed_out || (payload.exit_code !== null && payload.exit_code !== 0)) {
    const event = createJobEvent(opts.db, {
      type: 'cleanup_error',
      job_id: attempt.job_id,
      attempt_id: attempt.id,
      exit_code: payload.exit_code,
      timed_out: payload.timed_out,
      message: payload.message ?? 'Cleanup script failed or timed out',
    });
    recordEvent(opts.db, event);
  }

  transitionAttemptState(opts.db, attempt.id, 'completed', {
    outcome,
    finished_at: nowIso(),
  });
  transitionJobState(opts.db, attempt.job_id, 'cleaning');
  transitionJobState(opts.db, attempt.job_id, 'completed', {
    outcome,
    finished_at: nowIso(),
    exit_code: exitCode,
    failure_category:
      job?.failure_category ??
      (outcome === 'failed' ? 'process_exit' : outcome === 'timed_out' ? 'timeout' : null),
    failure_message:
      job?.failure_message ??
      payload.message ??
      (outcome === 'failed' ? `Process exited with code ${exitCode}` : null),
    result_json: JSON.stringify({ outcome, exit_code: exitCode }),
  });
}

export function handleAgentDisconnect(db: ControllerDatabase, agentId: string): void {
  // Phase 6: immediate fail-all is replaced by RecoveryCoordinator (grace → orphan → adopt/lost).
  // Kept as a no-op shim only when a coordinator is not wired (should not happen in production).
  void db;
  void agentId;
  logger.warn(
    'handleAgentDisconnect called without RecoveryCoordinator — no-op (Phase 6 requires coordinator)',
    { agentId },
  );
}
