import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { isAssignedLocalAddress, isPrivateLanAddress } from '@rbo/discovery';
import type {
  ArtifactManifestPayload,
  ArtifactUploadGrantPayload,
  BundleDownloadPayload,
  CleanupCompletePayload,
  HeartbeatAckPayload,
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
import {
  RboError,
  createLogger,
  generateId,
  isSafeRelativePath,
  parseProcessIdentity,
  sha256File,
} from '@rbo/shared';
import { FullSnapshotManifestSchema } from '@rbo/snapshot';
import type { WebSocket } from 'ws';
import type { z } from 'zod';
import { DEFAULT_MAX_GIT_BUNDLE_BYTES } from '../config.js';
import {
  clearArtifactExpectations,
  filterMissingArtifacts,
  readBundleMetadata,
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
  recordArtifactCollectionInterruption,
  recordEvent,
  recordRemoteProcessExit,
  runLifecycleTransaction,
  transitionAttemptState,
  transitionJobState,
  updateAttempt,
} from '../jobs/lifecycle.js';
import { persistAndPublishLogChunk } from '../logs/stream.js';
import {
  finalizeInterruptedArtifactCollection,
  processIdentityFromPid,
} from '../recovery/coordinator.js';
import { getActiveJobsForAgents } from '../scheduler/index.js';
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
  /** Max git bundle bytes; defaults to DEFAULT_MAX_GIT_BUNDLE_BYTES. */
  maxGitBundleBytes?: number;
  /**
   * Controller-level queue policy used as the safety-net in `handleRemoteLeaseReject` when a job's
   * persisted `queue_policy` is absent (legacy rows). Normally already concrete after submit-time
   * normalization.
   */
  defaultQueuePolicy?: import('@rbo/protocol').QueuePolicy;
  /** A live dispatcher can evaluate the remaining candidates after a rejected offer. */
  canRescheduleLeaseReject?: boolean;
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
  const conn = opts.connectedAgents.get(agentId);
  const baseUrl = resolveDataPlaneBaseUrl(opts, conn);

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
  const finishedAt = nowIso();
  runLifecycleTransaction(opts.db, () => {
    transitionAttemptState(opts.db, attemptId, 'completed', {
      outcome: 'failed',
      finished_at: finishedAt,
    });
    transitionJobState(opts.db, jobId, 'completed', {
      outcome: 'failed',
      finished_at: finishedAt,
      failure_category: category,
      failure_message: message,
    });
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
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(baseCommit)) {
    throw new Error('Captured base commit is not a Git object ID');
  }
  await mkdir(dirname(bundlePath), { recursive: true });
  const workDir = await mkdtemp(join(dirname(bundlePath), '.git-bundle-'));
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-path', 'objects'],
      {
        cwd: projectRoot,
        windowsHide: true,
      },
    );
    const objectsPath = stdout.replace(/\r?\n$/, '');
    if (!objectsPath || /[\r\n]/.test(objectsPath)) {
      throw new Error('Git object database path cannot be recorded as an alternate');
    }

    // Git bundles require a named ref. Use a private ref and read-only access to the source objects.
    const gitDir = join(workDir, 'repo.git');
    const stagedBundle = join(workDir, 'bundle.gitbundle');
    const objectFormat = baseCommit.length === 64 ? 'sha256' : 'sha1';
    const gitOpts = { cwd: workDir, windowsHide: true, maxBuffer: 1024 * 1024 };
    await execFileAsync(
      'git',
      ['init', '--bare', '--template=', `--object-format=${objectFormat}`, gitDir],
      gitOpts,
    );
    await writeFile(join(gitDir, 'objects', 'info', 'alternates'), `${objectsPath}\n`, {
      flag: 'wx',
    });
    const bundleRef = 'refs/heads/rbo-captured-base';
    await execFileAsync(
      'git',
      [`--git-dir=${gitDir}`, 'update-ref', bundleRef, baseCommit],
      gitOpts,
    );
    await execFileAsync(
      'git',
      [`--git-dir=${gitDir}`, 'bundle', 'create', stagedBundle, bundleRef],
      gitOpts,
    );

    const { size: sizeBytes } = await stat(stagedBundle);
    if (sizeBytes > maxBytes) {
      throw new GitBundleSizeExceededError(sizeBytes, maxBytes);
    }
    const sha256 = await sha256File(stagedBundle);
    await rename(stagedBundle, bundlePath);
    return { sizeBytes, sha256 };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function prepareBundleTransfer(
  transferDir: string,
  projectRoot: string,
  baseCommit: string,
  maxBytes: number,
): Promise<{ sizeBytes: number; sha256: string }> {
  const publishedDir = join(transferDir, 'bundle');
  const readPublished = async () => {
    const metadata = await readBundleMetadata(publishedDir);
    if (metadata.baseCommit !== baseCommit) {
      throw new Error('Published bundle does not match the captured commit');
    }
    if (metadata.sizeBytes > maxBytes) {
      throw new GitBundleSizeExceededError(metadata.sizeBytes, maxBytes);
    }
    return metadata;
  };
  try {
    return await readPublished();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  await mkdir(transferDir, { recursive: true });
  const stagingDir = await mkdtemp(join(transferDir, '.bundle-transfer-'));
  try {
    const metadata = await createGitBundle(
      projectRoot,
      baseCommit,
      join(stagingDir, 'bundle.gitbundle'),
      maxBytes,
    );
    await writeFile(
      join(stagingDir, 'metadata.json'),
      JSON.stringify({ ...metadata, baseCommit }),
      { flag: 'wx' },
    );
    try {
      await rename(stagingDir, publishedDir);
      return metadata;
    } catch (error) {
      // Another request may have published this same captured commit while Git was running.
      return await readPublished().catch(() => {
        throw error;
      });
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

function isLocalOrWildcardHost(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    normalized === '127.0.0.1' ||
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '0.0.0.0' ||
    normalized === '::'
  );
}

function formatHostForUrl(host: string): string {
  if (host.includes(':') && !host.startsWith('[')) {
    return `[${host}]`;
  }
  return host;
}

export function resolveDataPlaneBaseUrl(
  opts: RemoteExecutionOptions,
  agent?: ConnectedAgent,
): string {
  if (opts.dataPlaneBaseUrl) {
    return opts.dataPlaneBaseUrl.replace(/\/$/, '');
  }
  // Explicit hostname or an address that is still assigned on this machine.
  // A private LAN IP that DHCP has moved is ignored so Agents keep using the
  // interface they actually connected through.
  const pinned = opts.controllerPublicHost;
  const staleLanIp = Boolean(
    pinned &&
      !isLocalOrWildcardHost(pinned) &&
      isPrivateLanAddress(pinned) &&
      !isAssignedLocalAddress(pinned, os.networkInterfaces()),
  );
  if (pinned && !isLocalOrWildcardHost(pinned) && !staleLanIp) {
    const host = formatHostForUrl(pinned);
    return `https://${host}:${opts.serverPort}`;
  }
  // Otherwise, if the connected agent came through a reachable interface/host, prefer it:
  if (agent?.connectionHost && !isLocalOrWildcardHost(agent.connectionHost)) {
    const host = formatHostForUrl(agent.connectionHost);
    return `https://${host}:${opts.serverPort}`;
  }
  const fallback = staleLanIp ? '127.0.0.1' : (pinned ?? '127.0.0.1');
  const host = formatHostForUrl(fallback);
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
       FROM job_attempts WHERE id = ? AND lease_id = ? AND lease_epoch = ?
         AND NOT EXISTS (
           SELECT 1 FROM agents WHERE agents.id = job_attempts.agent_id
           AND (revoked_at IS NOT NULL OR disabled_at IS NOT NULL)
         )`,
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
): Omit<HeartbeatAckPayload, 'heartbeat_message_id'> {
  const renewedLeases = db
    .prepare(
      `UPDATE job_attempts
       SET lease_deadline = max(lease_deadline, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?))
       WHERE agent_id = ?
         AND state <> 'completed'
         AND lease_deadline > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         AND EXISTS (SELECT 1 FROM agents WHERE id = ? AND revoked_at IS NULL)
       RETURNING id AS attempt_id, lease_id, lease_epoch`,
    )
    .all(`+${ttlSeconds} seconds`, agentId, agentId) as HeartbeatAckPayload['renewed_leases'];
  return { lease_ttl_seconds: ttlSeconds, renewed_leases: renewedLeases };
}

export function expireStaleLeases(db: ControllerDatabase): void {
  const now = nowIso();
  const rows = db
    .prepare(
      `SELECT id, job_id, state, outcome FROM job_attempts
       WHERE state NOT IN ('completed', 'orphaned')
         AND lease_deadline IS NOT NULL
         AND lease_deadline <= ?`,
    )
    .all(now) as Array<{ id: string; job_id: string; state: string; outcome: string | null }>;

  for (const row of rows) {
    if (finalizeInterruptedArtifactCollection(db, row)) {
      continue;
    }
    runLifecycleTransaction(db, () => {
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
    });
  }
}

export async function initiateRemoteAttempt(
  opts: RemoteExecutionOptions,
  jobId: string,
  agentId: string,
  selectedToolchains?: ToolchainProfile[],
): Promise<string | null> {
  const agentConn = opts.connectedAgents.get(agentId);
  if (
    !agentConn ||
    agentConn.capabilitiesReady === false ||
    agentConn.socket.readyState !== agentConn.socket.OPEN ||
    agentConn.acceptingJobs === false ||
    (agentConn.leaseRetryAfter ?? 0) > Date.now()
  ) {
    return null;
  }

  const offerPayload = runLifecycleTransaction(opts.db, (): LeaseOfferPayload | null => {
    const agent = opts.db
      .prepare(
        'SELECT max_jobs FROM agents WHERE id = ? AND revoked_at IS NULL AND disabled_at IS NULL',
      )
      .get(agentId) as { max_jobs: number } | undefined;
    if (!agent || (getActiveJobsForAgents(opts.db).get(agentId) ?? 0) >= agent.max_jobs) {
      return null;
    }
    const claim = opts.db
      .prepare(
        "UPDATE jobs SET state = 'leasing', updated_at = ? WHERE id = ? AND state = 'queued'",
      )
      .run(nowIso(), jobId);
    if (claim.changes !== 1) {
      return null;
    }
    const snapshotRow = opts.db
      .prepare(
        `SELECT s.id, s.content_id, s.size_bytes, s.sha256 FROM snapshots s
         JOIN jobs j ON j.snapshot_id = s.id WHERE j.id = ?`,
      )
      .get(jobId) as
      | { id: string; content_id: string; size_bytes: number | null; sha256: string | null }
      | undefined;
    if (!snapshotRow?.sha256 || snapshotRow.size_bytes == null) {
      throw RboError.internal(`Missing snapshot size/sha256 metadata for job ${jobId}`);
    }
    const request = getJobRequest(opts.db, jobId);
    if (!request) {
      throw RboError.internal(`Missing job request for ${jobId}`);
    }

    const leaseId = generateId('lease');
    const leaseEpoch = nextLeaseEpochForJob(opts.db, jobId);
    const leaseDeadline = new Date(Date.now() + DEFAULT_LEASE_TTL_SECONDS * 1000).toISOString();
    const attemptId = generateId('att');
    const maxOrdinal = opts.db
      .prepare('SELECT COALESCE(MAX(ordinal), 0) AS max_ordinal FROM job_attempts WHERE job_id = ?')
      .get(jobId) as { max_ordinal: number };
    const toolchains = selectedToolchains?.length ? selectedToolchains : undefined;

    opts.db
      .prepare(
        `INSERT INTO job_attempts (id, job_id, ordinal, agent_id, lease_id, lease_epoch, lease_deadline, state, toolchain_profiles_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'leasing', ?)`,
      )
      .run(
        attemptId,
        jobId,
        maxOrdinal.max_ordinal + 1,
        agentId,
        leaseId,
        leaseEpoch,
        leaseDeadline,
        toolchains ? JSON.stringify(toolchains) : null,
      );
    notifyJobLifecycleChanged(opts.db, jobId);

    return {
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
      selected_toolchain_profiles: toolchains,
      lease_ttl_seconds: DEFAULT_LEASE_TTL_SECONDS,
    };
  });
  if (!offerPayload) {
    return null;
  }

  sendWsFrame(
    agentConn.socket,
    'lease_offer',
    offerPayload.attempt_id,
    offerPayload.lease_id,
    offerPayload.lease_epoch,
    offerPayload as unknown as Record<string, unknown>,
  );
  return offerPayload.attempt_id;
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

  const stillPreparing = () =>
    opts.connectedAgents.get(agentId) === conn &&
    rejectStale(
      'source_need',
      loadAttemptByLease(opts.db, attempt.id, payload.lease_id, payload.lease_epoch),
      agentId,
      ['preparing_source'],
    );

  const failSourceNeed = (
    category: NonNullable<JobExitPayload['failure_category']>,
    message: string,
  ) => {
    failAttemptPrepare(opts, attempt.id, attempt.job_id, category, message);
    sendWsFrame(
      conn.socket,
      'reconcile_decision',
      attempt.id,
      payload.lease_id,
      payload.lease_epoch,
      {
        attempt_id: attempt.id,
        lease_id: payload.lease_id,
        lease_epoch: payload.lease_epoch,
        action: 'terminate_stale',
        reason: message,
      },
    );
  };

  if (payload.reason === 'base_commit_missing' || payload.reason === 'bundle_required') {
    const request = getJobRequest(opts.db, attempt.job_id);
    const snapshotRow = loadSnapshotForJob(opts.db, attempt.job_id);
    if (!request || !snapshotRow?.manifest_path) {
      failSourceNeed('materialization', 'Cannot create bundle: missing job request or manifest');
      return;
    }

    let manifest: { repo?: { base_commit?: string } };
    try {
      manifest = JSON.parse(readFileSync(snapshotRow.manifest_path, 'utf8')) as {
        repo?: { base_commit?: string };
      };
    } catch {
      failSourceNeed('materialization', 'Cannot create bundle: manifest unreadable');
      return;
    }

    const baseCommit = manifest.repo?.base_commit;
    if (!baseCommit) {
      failSourceNeed('materialization', 'Cannot create bundle: manifest missing base_commit');
      return;
    }

    const transferDir = attemptTransferDir(opts.dataDir, attempt.id);
    try {
      const maxBundleBytes = opts.maxGitBundleBytes ?? DEFAULT_MAX_GIT_BUNDLE_BYTES;
      const { sizeBytes, sha256 } = await prepareBundleTransfer(
        transferDir,
        request.source.project_root,
        baseCommit,
        maxBundleBytes,
      );
      if (!stillPreparing()) {
        return;
      }
      const bundleToken = issueDataToken(opts.identity, {
        agent_id: agentId,
        job_id: attempt.job_id,
        attempt_id: attempt.id,
        lease_id: payload.lease_id,
        lease_epoch: payload.lease_epoch,
        op: 'bundle_download',
      });
      const bundleUrl = `${resolveDataPlaneBaseUrl(opts, conn)}/data/v1/attempts/${attempt.id}/bundle`;
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
      if (!stillPreparing()) {
        return;
      }
      failSourceNeed('materialization', `Failed to create git bundle: ${String(error)}`);
    }
    return;
  }

  if (payload.reason === 'full_snapshot_required' || payload.reason === 'repo_fetch_failed') {
    const snapshotRow = loadSnapshotForJob(opts.db, attempt.job_id);
    let manifest: unknown;
    try {
      if (snapshotRow) {
        manifest = JSON.parse(readFileSync(snapshotRow.manifest_path, 'utf8'));
      }
    } catch {
      // Handle the unavailable snapshot below.
    }

    if (snapshotRow && FullSnapshotManifestSchema.safeParse(manifest).success) {
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

    const message =
      snapshotManifestMode(manifest) === 'git_overlay'
        ? `Agent could not restore the submitted Git overlay (${payload.reason}). Resolve Git access or submit a new job with snapshot_mode=full.`
        : 'The submitted snapshot is unavailable or invalid';
    failSourceNeed('repo_fetch', message);
  }
}

export function handleRemoteLeaseReject(
  opts: RemoteExecutionOptions,
  agentId: string,
  payload: LeaseRejectPayload,
): boolean {
  const attempt = loadAttemptByLease(
    opts.db,
    payload.attempt_id,
    payload.lease_id,
    payload.lease_epoch,
  );
  if (!rejectStale('lease_reject', attempt, agentId, ['leasing'])) {
    return false;
  }

  // Abandon only this offer/attempt. Capacity-race rejects must not hard-fail
  // wait (or other rematch-eligible) jobs — re-queue for later dispatch.
  runLifecycleTransaction(opts.db, () => {
    const finished = nowIso();
    bumpLeaseEpoch(opts.db, attempt.id);
    transitionAttemptState(opts.db, attempt.id, 'completed', {
      outcome: 'failed',
      finished_at: finished,
    });

    const request = getJobRequest(opts.db, attempt.job_id);
    const queuePolicy = request?.queue_policy ?? opts.defaultQueuePolicy ?? 'local_fallback';
    if (queuePolicy === 'fail_fast' && !opts.canRescheduleLeaseReject) {
      transitionJobState(opts.db, attempt.job_id, 'completed', {
        outcome: 'failed',
        finished_at: finished,
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
      .run(finished, finished, attempt.job_id);
    notifyJobLifecycleChanged(opts.db, attempt.job_id);
  });
  return true;
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
  // `completed` stays open so a frame that arrives after the terminal
  // transition is still appended when its sequence is contiguous. Lease
  // expiry continues to reject stale frames via rejectStale.
  if (
    !rejectStale('log_chunk', attempt, agentId, ['running', 'collecting_artifacts', 'completed'])
  ) {
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
  const current = loadAttemptByLease(opts.db, attempt.id, payload.lease_id, payload.lease_epoch);
  if (!rejectStale('log_chunk', current, agentId)) {
    return;
  }
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
  const clearChain = (): void => {
    if (logChunkChains.get(key) === next) {
      logChunkChains.delete(key);
    }
  };
  // Do not discard a rejecting Promise produced by finally(). The caller owns
  // error handling for `next`; this branch only performs bookkeeping.
  void next.then(clearChain, clearChain);
  return next;
}

/**
 * Wait until log_chunk handlers queued for this attempt have settled,
 * including any chunk enqueued while this wait yields.
 *
 * The agent plane does not await ingest. A fast cleanup_complete otherwise
 * marks the attempt terminal while later chunks are still queued, so job_logs
 * on the completed job misses them. Stop when the settled promise is still
 * the tail, or the tail has already been cleared.
 */
export async function drainRemoteLogChunks(attemptId: string): Promise<void> {
  let pending = logChunkChains.get(attemptId);
  while (pending) {
    await pending.catch(() => undefined);
    const current = logChunkChains.get(attemptId);
    if (!current || current === pending) {
      return;
    }
    pending = current;
  }
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

  const identity = payload.process_identity;
  if (identity && payload.pid && parseProcessIdentity(identity)?.pid === payload.pid) {
    updateAttempt(opts.db, attempt.id, { process_identity: identity });
  } else if (identity === undefined && payload.pid) {
    const legacyIdentity = processIdentityFromPid(payload.pid);
    if (legacyIdentity) updateAttempt(opts.db, attempt.id, { process_identity: legacyIdentity });
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

  recordRemoteProcessExit(opts.db, attempt, payload);
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
  const conn = opts.connectedAgents.get(agentId);
  if (!conn) {
    return;
  }
  const canReconcile = () =>
    opts.connectedAgents.get(agentId) === conn &&
    rejectStale(
      'artifact_manifest',
      loadAttemptByLease(opts.db, attempt.id, payload.lease_id, payload.lease_epoch),
      agentId,
      ['collecting_artifacts'],
    );
  if (payload.artifacts.some((art) => !isSafeRelativePath(art.logical_name))) {
    logger.warn('invalid artifact logical name ignored', { attemptId: attempt.id, agentId });
    return;
  }

  const rules = getJobRequest(opts.db, attempt.job_id)?.artifacts ?? [];
  if (payload.collection) {
    if (payload.collection.rules.length === rules.length) {
      opts.db
        .prepare('UPDATE job_attempts SET artifact_collection_json = ? WHERE id = ?')
        .run(JSON.stringify(payload.collection), attempt.id);
    } else {
      logger.warn('discarding artifact collection summary with mismatched rule count', {
        attemptId: attempt.id,
        expected: rules.length,
        actual: payload.collection.rules.length,
      });
    }
  }

  // Register full manifest expectations, then grant tokens only for missing objects.
  registerArtifactExpectations(attempt.id, payload.artifacts);

  void filterMissingArtifacts(opts, attempt.id, payload.artifacts, canReconcile)
    .then((missing) => {
      if (!canReconcile()) {
        return;
      }
      const pathByName = new Map(payload.artifacts.map((a) => [a.logical_name, a.path]));
      const uploadBaseUrl = resolveDataPlaneBaseUrl(opts, conn);
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
        const uploadUrl = `${uploadBaseUrl}/data/v1/attempts/${attempt.id}/artifacts/${encodeURIComponent(art.logical_name)}`;
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

      sendWsFrame(
        conn.socket,
        'artifact_upload_grant',
        attempt.id,
        payload.lease_id,
        payload.lease_epoch,
        responsePayload as unknown as Record<string, unknown>,
      );
    })
    .catch((error) => {
      logger.warn('failed to reconcile artifact manifest', {
        attemptId: attempt.id,
        error: String(error),
      });
    });
}

export async function handleRemoteCleanupComplete(
  opts: RemoteExecutionOptions,
  agentId: string,
  payload: CleanupCompletePayload,
): Promise<void> {
  const loaded = loadAttemptByLease(
    opts.db,
    payload.attempt_id,
    payload.lease_id,
    payload.lease_epoch,
  );
  if (!rejectStale('cleanup_complete', loaded, agentId, ['collecting_artifacts'])) {
    return;
  }

  // Fast jobs emit cleanup_complete within a few WS frames of the last
  // log_chunk. Those frames are already queued; persist them before the
  // attempt leaves collecting_artifacts so job_logs sees the full spool.
  await drainRemoteLogChunks(loaded.id);

  const attempt = loadAttemptByLease(
    opts.db,
    payload.attempt_id,
    payload.lease_id,
    payload.lease_epoch,
  );
  if (!rejectStale('cleanup_complete', attempt, agentId, ['collecting_artifacts'])) {
    return;
  }

  const job = getJob(opts.db, attempt.job_id);
  const outcome =
    attempt.outcome ??
    (payload.timed_out ? 'timed_out' : payload.exit_code === 0 ? 'succeeded' : 'failed');
  // Prefer process exit_code from job_exit (including intentional null for cancel/timeout).
  // Do not adopt cleanup script exit_code 0 over a null process exit.
  const exitCode =
    attempt.outcome != null ? (job?.exit_code ?? null) : (job?.exit_code ?? payload.exit_code);

  const finishedAt = nowIso();
  runLifecycleTransaction(opts.db, () => {
    if (payload.artifact_staging_interrupted) {
      recordArtifactCollectionInterruption(opts.db, attempt.id);
    }
    if (
      payload.cleanup_interrupted ||
      payload.timed_out ||
      (payload.exit_code !== null && payload.exit_code !== 0)
    ) {
      const event = createJobEvent(opts.db, {
        type: 'cleanup_error',
        job_id: attempt.job_id,
        attempt_id: attempt.id,
        exit_code: payload.exit_code,
        timed_out: payload.timed_out,
        message: payload.cleanup_interrupted
          ? 'Cleanup result was unavailable when the Agent recovered the attempt'
          : (payload.message ?? 'Cleanup script failed or timed out'),
      });
      recordEvent(opts.db, event);
    }

    transitionAttemptState(opts.db, attempt.id, 'completed', {
      outcome,
      finished_at: finishedAt,
    });
    transitionJobState(opts.db, attempt.job_id, 'cleaning');
    transitionJobState(opts.db, attempt.job_id, 'completed', {
      outcome,
      finished_at: finishedAt,
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
  });
  clearArtifactExpectations(attempt.id);
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
