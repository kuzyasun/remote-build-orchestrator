import { readFileSync } from 'node:fs';
import { appendLogChunk, ensureAttemptLogs } from '@rbo/executor';
import type {
  ArtifactManifestPayload,
  ArtifactUploadGrantPayload,
  CleanupCompletePayload,
  JobExitPayload,
  JobStartedPayload,
  LeaseAcceptPayload,
  LeaseOfferPayload,
  LeaseRejectPayload,
  LogChunkPayload,
  PrepareSourcePayload,
  RunJobPayload,
  SourceReadyPayload,
  ToolchainProfileSchema,
} from '@rbo/protocol';
import type { ControllerIdentity } from '@rbo/shared';
import { RboError, createLogger, generateId } from '@rbo/shared';
import type { WebSocket } from 'ws';
import type { z } from 'zod';
import { clearArtifactExpectations, registerArtifactExpectations } from '../http/data-plane.js';
import {
  createJobEvent,
  getJob,
  getJobRequest,
  getLatestAttempt,
  recordEvent,
  transitionAttemptState,
  transitionJobState,
} from '../jobs/lifecycle.js';
import { issueDataToken } from '../security/data-tokens.js';
import type { ControllerDatabase } from '../storage/database.js';
import { nowIso } from '../storage/database.js';
import type { ConnectedAgent } from '../websocket/server.js';
import { attemptLogDir } from './runner.js';

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
      `SELECT id, job_id, agent_id, state, lease_id, lease_epoch, lease_deadline, outcome
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
       WHERE state NOT IN ('completed')
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
  const leaseEpoch = 1;
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

  const snapshotRow = opts.db
    .prepare(
      `SELECT s.size_bytes, s.sha256, s.manifest_path
       FROM jobs j JOIN snapshots s ON j.snapshot_id = s.id
       WHERE j.id = ?`,
    )
    .get(attempt.job_id) as
    | { size_bytes: number; sha256: string; manifest_path: string }
    | undefined;

  if (!snapshotRow?.sha256 || snapshotRow.size_bytes == null) {
    transitionAttemptState(opts.db, attempt.id, 'completed', {
      outcome: 'failed',
      finished_at: nowIso(),
    });
    transitionJobState(opts.db, attempt.job_id, 'completed', {
      outcome: 'failed',
      finished_at: nowIso(),
      failure_category: 'materialization',
      failure_message: 'Snapshot metadata missing size or sha256',
    });
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
    attempt_id: attempt.id,
    lease_id: payload.lease_id,
    lease_epoch: payload.lease_epoch,
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
  transitionAttemptState(opts.db, attempt.id, 'completed', {
    outcome: 'failed',
    finished_at: nowIso(),
  });

  const request = getJobRequest(opts.db, attempt.job_id);
  const queuePolicy = request?.queue_policy ?? 'local_fallback';
  if (queuePolicy === 'fail_fast') {
    transitionJobState(opts.db, attempt.job_id, 'completed', {
      outcome: 'failed',
      finished_at: nowIso(),
      failure_category: 'no_capacity',
      failure_message: `Agent rejected lease offer: ${payload.reason}`,
    });
    return;
  }

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

  const logDir = attemptLogDir(opts.dataDir, attempt.id);
  const logs = await ensureAttemptLogs(logDir);
  await appendLogChunk(logs, payload.stream, payload.bytes);
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
  if (!rejectStale('job_exit', attempt, agentId, ['leasing', 'preparing_source', 'running'])) {
    return;
  }

  // Persist process outcome here; cleanup_complete only finalizes the attempt.
  transitionAttemptState(opts.db, attempt.id, 'collecting_artifacts', {
    outcome: payload.outcome,
  });
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

  const artifactsWithTokens = payload.artifacts.map((art) => {
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
    return { ...art, upload_token: uploadToken, upload_url: uploadUrl };
  });

  registerArtifactExpectations(attempt.id, payload.artifacts);

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
  const attempts = db
    .prepare(
      `SELECT id, job_id FROM job_attempts
       WHERE agent_id = ? AND state NOT IN ('completed')`,
    )
    .all(agentId) as Array<{ id: string; job_id: string }>;

  for (const att of attempts) {
    clearArtifactExpectations(att.id);
    transitionAttemptState(db, att.id, 'completed', { outcome: 'failed', finished_at: nowIso() });
    transitionJobState(db, att.job_id, 'completed', {
      outcome: 'failed',
      finished_at: nowIso(),
      failure_category: 'agent_disconnected',
      failure_message: 'Agent disconnected during remote execution',
    });
  }
}
