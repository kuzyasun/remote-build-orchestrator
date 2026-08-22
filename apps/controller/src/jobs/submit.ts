import { createHash } from 'node:crypto';
import { link, open, rm, stat, unlink } from 'node:fs/promises';
import { cpus, freemem } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { appendEvent, presentLogTail } from '@rbo/executor';
import type { AgentCapabilityReport, JobRequest, QueuePolicy } from '@rbo/protocol';
import { JobRequestSchema } from '@rbo/protocol';
import type { ControllerIdentity } from '@rbo/shared';
import {
  RboError,
  computeCapacityScore,
  createLogger,
  formatUnknownError,
  generateId,
  signEdDsaJwt,
  verifyEdDsaJwt,
} from '@rbo/shared';
import { stableStringify } from '@rbo/snapshot';
import { listArtifactsForJob } from '../execution/artifacts.js';
import { initiateRemoteAttempt, requestRemoteJobCancel } from '../execution/remote-execution.js';
import {
  type LocalRunnerContext,
  attemptLogDir,
  captureAndPersistSnapshot,
  getLocalRunningJobsCount,
  mergeGitSourceToolRequirements,
  readGitSourceRequirements,
  requestJobCancel,
  runLocalJob,
} from '../execution/runner.js';
import {
  type HostLoadSnapshot,
  type LocalHostExecutionCapability,
  type SchedulerAgent,
  getActiveJobsForAgents,
  getRecentFailurePenaltiesForAgents,
  selectAgentForJob,
} from '../scheduler/index.js';
import type { ControllerDatabase } from '../storage/database.js';
import { nowIso } from '../storage/database.js';
import type { ConnectedAgent } from '../websocket/server.js';
import {
  hasCaptureLeaseAuthority,
  releaseCaptureLease,
  renewCaptureLease,
  reserveCaptureLease,
} from './capture-lease.js';
import { subscribeToJobLifecycle } from './lifecycle-notifier.js';
import {
  createJob,
  createJobEvent,
  getJob,
  getLatestAttempt,
  isDestructiveRisk,
  isTerminalJobState,
  persistSnapshot,
  recordEvent,
  runLifecycleTransaction,
  transitionAttemptState,
  transitionJobState,
} from './lifecycle.js';
import { completeSubmission } from './submissions.js';

const logger = createLogger('controller.jobs.submit');

const CONFIRMATION_TTL_SECONDS = 300;
const DEFAULT_WAIT_TAIL_MAX_BYTES = 16 * 1024;
const WAIT_FALLBACK_INTERVAL_MS = 1_000;
const CAPTURE_LEASE_RENEW_INTERVAL_MS = 10_000;

function localHostExecutionCapability(
  platform: NodeJS.Platform = process.platform,
): LocalHostExecutionCapability | undefined {
  switch (platform) {
    case 'win32':
      return { os: 'windows', shells: ['powershell', 'cmd', 'direct'] };
    case 'linux':
      return { os: 'linux', shells: ['bash', 'sh', 'direct'] };
    case 'darwin':
      return { os: 'macos', shells: ['bash', 'sh', 'direct'] };
    default:
      return undefined;
  }
}

/**
 * Deterministic fault boundaries for the S-03 publication tests. These hooks
 * are only supplied by in-process tests; production contexts leave them unset.
 */
export interface SnapshotPublicationTestHooks {
  afterCapture?: () => void;
  afterCandidateFlush?: (candidatePath: string, index: number) => void;
  beforeCandidatePublication?: (candidatePath: string, index: number) => void;
  afterCandidatePublication?: (finalPath: string, index: number) => void;
  afterPublicationDirectoryFlush?: () => void;
  beforeTransactionAuthorityCheck?: () => void;
  /** Runs inside the lifecycle transaction after the snapshot row is written. */
  afterSnapshotPersisted?: () => void;
  /** Runs immediately before conditional terminal failure persistence. */
  beforeConditionalTerminalSubmissionFailure?: () => void;
}

function generationPath(candidatePath: string, generation: number): string {
  const suffix = candidatePath.match(new RegExp(`\\.g${generation}(\\.candidate-[^\\\\/]+)$`))?.[1];
  if (!suffix) {
    throw RboError.internal(
      'Snapshot capture did not return a generation-scoped private candidate',
    );
  }
  return candidatePath.slice(0, -suffix.length);
}

function failSubmissionIfCaptureLeaseIsAuthoritative(
  db: ControllerDatabase,
  captureLease: Parameters<typeof releaseCaptureLease>[1],
  payload: Record<string, unknown>,
): boolean {
  const timestamp = nowIso();
  const info = db
    .prepare(
      `UPDATE job_submissions AS submission
          SET state = 'failed', error_json = ?, updated_at = ?
        WHERE submission.client_id = ? AND submission.client_request_id = ?
          AND submission.state = 'capturing'
          AND EXISTS (
            SELECT 1
              FROM snapshot_capture_leases AS lease
             WHERE lease.client_id = submission.client_id
               AND lease.client_request_id = submission.client_request_id
               AND lease.owner_token = ?
               AND lease.fencing_generation = ?
               AND lease.lease_expires_at > ?
          )`,
    )
    .run(
      JSON.stringify(payload),
      timestamp,
      captureLease.clientId,
      captureLease.clientRequestId,
      captureLease.ownerToken,
      captureLease.fencingGeneration,
      timestamp,
    );
  return info.changes === 1;
}

async function flushFile(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    try {
      await handle.sync();
    } catch {
      // Windows may reject fsync on a read-only handle; close still completes the guard.
    }
  } finally {
    await handle.close();
  }
}

/** Best-effort directory durability; directory handles are unsupported on some Windows builds. */
async function flushDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // The file publication remains atomic; Windows does not consistently expose directory fsync.
  }
}

/** Publish without clobbering an existing generation: link is atomic and no-replace. */
async function publishCandidate(candidatePath: string, generation: number): Promise<string> {
  const finalPath = generationPath(candidatePath, generation);
  await link(candidatePath, finalPath);
  try {
    await unlink(candidatePath);
  } catch (error) {
    await unlink(finalPath).catch(() => undefined);
    throw error;
  }
  await flushDirectory(dirname(finalPath));
  return finalPath;
}

export interface SubmitJobContext extends LocalRunnerContext {
  clientId: string;
  controllerIdentity: ControllerIdentity;
  connectedAgents?: Map<string, ConnectedAgent>;
  agentPlanePort?: number;
  controllerPublicHost?: string;
  dataPlaneBaseUrl?: string;
  allowLocalFallback?: boolean;
  /**
   * Queue policy applied when a job's `JobRequest.queue_policy` is not explicitly set by the
   * client. Falls back to `'local_fallback'` when omitted (back-compat for tests/programmatic use).
   */
  defaultQueuePolicy?: QueuePolicy;
  /**
   * Host-aware local fallback (docs/dev/host-aware-local-fallback-plan.md). Omitted means
   * unchanged, backward-compatible behavior (host load not considered).
   */
  getHostCpuBusyFraction?: () => number;
  maxHostCpuBusyFraction?: number;
  /** Internal agent-plane shutdown fence for queued dispatch work. */
  shouldContinueDispatch?: () => boolean;
  /** In-process S-03 fault injection; never populated from an external request. */
  snapshotPublicationTestHooks?: SnapshotPublicationTestHooks;
}

function requestHash(request: JobRequest): string {
  return createHash('sha256').update(stableStringify(request)).digest('hex');
}

function issueConfirmationToken(
  identity: ControllerIdentity,
  claims: {
    job_id: string;
    request_hash: string;
    content_id: string;
    risk_level: string;
  },
): string {
  return signEdDsaJwt(identity.signingPrivateKeyPem, {
    sub: claims.job_id,
    aud: identity.controllerId,
    exp: Math.floor(Date.now() / 1000) + CONFIRMATION_TTL_SECONDS,
    job_id: claims.job_id,
    request_hash: claims.request_hash,
    content_id: claims.content_id,
    risk_level: claims.risk_level,
  });
}

export function verifyConfirmationToken(
  identity: ControllerIdentity,
  token: string,
): {
  job_id: string;
  request_hash: string;
  content_id: string;
  risk_level: string;
} | null {
  const claims = verifyEdDsaJwt(identity.signingPublicKeyPem, token);
  if (!claims || claims.aud !== identity.controllerId) {
    return null;
  }
  const job_id = typeof claims.sub === 'string' ? claims.sub : '';
  const request_hash = String(claims.request_hash ?? '');
  const content_id = String(claims.content_id ?? '');
  const risk_level = String(claims.risk_level ?? '');
  if (!job_id || !request_hash || !content_id || !risk_level) {
    return null;
  }
  return { job_id, request_hash, content_id, risk_level };
}

export async function handleJobSubmit(
  ctx: SubmitJobContext,
  rawRequest: unknown,
): Promise<Record<string, unknown>> {
  const parsed = JobRequestSchema.safeParse(rawRequest);
  if (!parsed.success) {
    throw RboError.validation('Invalid job_submit request', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  const request = parsed.data;
  // Resolve the queue policy once, here, so the persisted `request_json` always carries a
  // concrete value: an explicit client choice wins; otherwise the Controller-level default
  // (`config.defaultQueuePolicy`) applies. Downstream readers (`selectAgentForJob`,
  // `handleRemoteLeaseReject`) then see a concrete policy without re-deriving it.
  const effectiveQueuePolicy: QueuePolicy =
    request.queue_policy ?? ctx.defaultQueuePolicy ?? 'local_fallback';
  if (request.queue_policy !== effectiveQueuePolicy) {
    request.queue_policy = effectiveQueuePolicy;
  }
  const reserve = reserveCaptureLease(ctx.db, {
    clientId: ctx.clientId,
    clientRequestId: request.client_request_id,
  });
  if (!reserve.acquired) {
    const existing = reserve.submission;
    if (!existing) {
      throw RboError.internal('Capture lease reservation returned no submission');
    }
    if (existing.state === 'capturing') {
      throw RboError.validation('Submission is still capturing snapshot', {
        client_request_id: request.client_request_id,
      });
    }
    if (existing.state === 'captured' && existing.response_json) {
      return JSON.parse(existing.response_json) as Record<string, unknown>;
    }
    if (existing.state === 'failed' && existing.error_json) {
      return { error: JSON.parse(existing.error_json) };
    }
    throw RboError.validation('Submission cannot acquire a capture lease', {
      client_request_id: request.client_request_id,
      reason: reserve.reason ?? 'missing',
    });
  }
  const captureLease = reserve.lease;
  if (!captureLease) {
    throw RboError.internal('Capture lease reservation returned no lease');
  }

  const initialState = 'created';
  const pendingJobId = generateId('job');
  let captured: Awaited<ReturnType<typeof captureAndPersistSnapshot>> | undefined;
  let leaseRenewal: ReturnType<typeof setInterval> | undefined;

  try {
    leaseRenewal = setInterval(() => {
      renewCaptureLease(ctx.db, captureLease);
    }, CAPTURE_LEASE_RENEW_INTERVAL_MS);
    leaseRenewal.unref?.();
    const captureCtx: LocalRunnerContext = {
      ...ctx,
      remoteCapable: (ctx.connectedAgents?.size ?? 0) > 0,
      gitAllowlist: ctx.gitAllowlist,
    };
    const capturedSnapshot = await captureAndPersistSnapshot(
      captureCtx,
      pendingJobId,
      request,
      captureLease.fencingGeneration,
    );
    captured = capturedSnapshot;
    ctx.snapshotPublicationTestHooks?.afterCapture?.();
    const { snapshotId, contentId, secretWarnings, request: normalizedRequest } = capturedSnapshot;
    const hash = requestHash(normalizedRequest);

    const candidatePaths = [
      capturedSnapshot.archivePath,
      capturedSnapshot.manifestPath,
      capturedSnapshot.secretWarningsPath,
      capturedSnapshot.gitSourceRequirementsPath,
    ];
    for (const [index, candidatePath] of candidatePaths.entries()) {
      await flushFile(candidatePath);
      ctx.snapshotPublicationTestHooks?.afterCandidateFlush?.(candidatePath, index);
    }
    for (const [index, candidatePath] of candidatePaths.entries()) {
      ctx.snapshotPublicationTestHooks?.beforeCandidatePublication?.(candidatePath, index);
      if (!hasCaptureLeaseAuthority(ctx.db, captureLease)) {
        throw new RboError('lease_expired', 'Snapshot capture lease lost before publication', true);
      }
      const finalPath = await publishCandidate(candidatePath, captureLease.fencingGeneration);
      ctx.snapshotPublicationTestHooks?.afterCandidatePublication?.(finalPath, index);
    }
    await flushDirectory(join(ctx.dataDir, 'snapshots', pendingJobId));
    ctx.snapshotPublicationTestHooks?.afterPublicationDirectoryFlush?.();

    const committed = runLifecycleTransaction(ctx.db, () => {
      ctx.snapshotPublicationTestHooks?.beforeTransactionAuthorityCheck?.();
      if (!hasCaptureLeaseAuthority(ctx.db, captureLease)) {
        throw new RboError(
          'lease_expired',
          'Snapshot capture lease lost before database commit',
          true,
        );
      }
      persistSnapshot(ctx.db, {
        snapshotId,
        contentId,
        repoId: capturedSnapshot.repoId,
        baseCommit: capturedSnapshot.baseCommit,
        dirty: true,
        manifestPath: generationPath(capturedSnapshot.manifestPath, captureLease.fencingGeneration),
        payloadPath: generationPath(capturedSnapshot.archivePath, captureLease.fencingGeneration),
        sizeBytes: capturedSnapshot.sizeBytes,
        sha256: capturedSnapshot.sha256,
      });
      ctx.snapshotPublicationTestHooks?.afterSnapshotPersisted?.();
      const job = createJob(ctx.db, {
        jobId: pendingJobId,
        clientId: ctx.clientId,
        clientRequestId: normalizedRequest.client_request_id,
        request: normalizedRequest,
        initialState,
        name: normalizedRequest.name,
      });
      transitionJobState(ctx.db, job.id, job.state, { snapshot_id: snapshotId });

      if (isDestructiveRisk(normalizedRequest.risk_level)) {
        const confirmation_token = issueConfirmationToken(ctx.controllerIdentity, {
          job_id: job.id,
          request_hash: hash,
          content_id: contentId,
          risk_level: normalizedRequest.risk_level,
        });
        transitionJobState(ctx.db, job.id, 'awaiting_confirmation', { queued_at: nowIso() });
        const response = {
          job_id: job.id,
          state: 'awaiting_confirmation',
          snapshot_id: snapshotId,
          content_id: contentId,
          snapshot_captured: true,
          selected_agent: null,
          confirmation_token,
          secret_warnings: secretWarnings.map((w) => w.path),
        };
        completeSubmission(
          ctx.db,
          ctx.clientId,
          normalizedRequest.client_request_id,
          'captured',
          response,
          job.id,
        );
        return { response, dispatch: false };
      }

      transitionJobState(ctx.db, job.id, 'queued', { queued_at: nowIso() });
      const response = {
        job_id: job.id,
        state: 'queued',
        snapshot_id: snapshotId,
        content_id: contentId,
        snapshot_captured: true,
        selected_agent: null,
        secret_warnings: secretWarnings.map((w) => w.path),
      };
      completeSubmission(
        ctx.db,
        ctx.clientId,
        normalizedRequest.client_request_id,
        'captured',
        response,
        job.id,
      );
      return { response, dispatch: true };
    });
    clearInterval(leaseRenewal);
    leaseRenewal = undefined;
    releaseCaptureLease(ctx.db, captureLease);
    if (committed.dispatch) {
      void dispatchJobExecution(ctx, pendingJobId, normalizedRequest).catch((error) => {
        // Never pass raw Error objects to console.* — Node 24.11+ util.inspect can
        // throw on ZodError and kill the Controller process.
        logger.error('job execution dispatch failed', {
          jobId: pendingJobId,
          error: formatUnknownError(error),
        });
      });
    }
    return committed.response;
  } catch (error) {
    if (leaseRenewal) clearInterval(leaseRenewal);
    await captured?.cleanupCandidate();

    // A request may safely become terminal only when the capture failure says
    // so explicitly. Unknown publication and transaction failures can happen
    // after private or final generation-scoped files exist; keep the
    // reservation reclaimable so the same idempotency key can capture g+1.
    let payload =
      error instanceof RboError
        ? error.toJSON()
        : { category: 'internal', message: String(error), retryable: true };
    if (payload.retryable) {
      releaseCaptureLease(ctx.db, captureLease);
    } else {
      ctx.snapshotPublicationTestHooks?.beforeConditionalTerminalSubmissionFailure?.();
      if (
        failSubmissionIfCaptureLeaseIsAuthoritative(
          ctx.db,
          captureLease,
          payload as Record<string, unknown>,
        )
      ) {
        releaseCaptureLease(ctx.db, captureLease);
      } else {
        payload = new RboError(
          'lease_expired',
          'Snapshot capture lease lost before recording terminal capture failure',
          true,
        ).toJSON();
      }
    }
    return { error: payload };
  }
}

export async function dispatchJobExecution(
  ctx: SubmitJobContext,
  jobId: string,
  request: JobRequest,
): Promise<void> {
  if (ctx.shouldContinueDispatch && !ctx.shouldContinueDispatch()) {
    return;
  }
  const connectedMap = ctx.connectedAgents ?? new Map();
  const dbAgents = ctx.db
    .prepare('SELECT id, capabilities_json, state FROM agents WHERE disabled_at IS NULL')
    .all() as Array<{ id: string; capabilities_json: string; state: string }>;

  const activeCounts = getActiveJobsForAgents(ctx.db);
  const recentFailurePenalties = getRecentFailurePenaltiesForAgents(ctx.db);
  const candidates: SchedulerAgent[] = [];

  for (const agentRow of dbAgents) {
    if (!connectedMap.has(agentRow.id)) {
      continue;
    }
    try {
      const caps = JSON.parse(agentRow.capabilities_json) as AgentCapabilityReport;
      candidates.push({
        agentId: agentRow.id,
        capabilities: caps,
        activeJobsCount: activeCounts.get(agentRow.id) ?? 0,
      });
    } catch {
      // skip invalid caps
    }
  }

  const snapshotMeta = ctx.db
    .prepare(
      'SELECT repo_id, base_commit, content_id, size_bytes FROM snapshots WHERE id = (SELECT snapshot_id FROM jobs WHERE id = ?)',
    )
    .get(jobId) as
    | {
        repo_id: string | null;
        base_commit: string | null;
        content_id: string;
        size_bytes: number | null;
      }
    | undefined;

  const buildCacheProjectIdentity =
    snapshotMeta?.repo_id && snapshotMeta.repo_id !== 'local'
      ? snapshotMeta.repo_id
      : snapshotMeta?.content_id
        ? `local:${snapshotMeta.content_id}`
        : null;

  const gitSourceRequirements = await readGitSourceRequirements(ctx.dataDir, jobId);
  if (ctx.shouldContinueDispatch && !ctx.shouldContinueDispatch()) {
    return;
  }
  const schedulingRequest = mergeGitSourceToolRequirements(request, gitSourceRequirements);

  const hostLoad: HostLoadSnapshot | undefined = ctx.getHostCpuBusyFraction
    ? {
        cpuBusyFraction: ctx.getHostCpuBusyFraction(),
        capacityScore: computeCapacityScore({
          cpuLogical: cpus().length,
          cpuSpeedMhz: cpus()[0]?.speed ?? 0,
          memoryFreeMb: Math.round(freemem() / (1024 * 1024)),
        }),
        runningJobs: getLocalRunningJobsCount(),
      }
    : undefined;

  const decision = selectAgentForJob(candidates, schedulingRequest, {
    allowLocalFallback: ctx.allowLocalFallback,
    repoCanonicalId:
      snapshotMeta?.repo_id && snapshotMeta.repo_id !== 'local' ? snapshotMeta.repo_id : null,
    baseCommit: snapshotMeta?.base_commit ?? null,
    buildCacheProjectIdentity,
    estimatedTransferBytes: snapshotMeta?.size_bytes ?? null,
    recentFailurePenalties,
    registeredAgentCount: dbAgents.length,
    localHostExecution: localHostExecutionCapability(),
    hostLoad,
    maxHostCpuBusyFraction: ctx.maxHostCpuBusyFraction,
  });

  if (decision.action === 'remote' && decision.selectedAgent && ctx.agentPlanePort) {
    if (ctx.shouldContinueDispatch && !ctx.shouldContinueDispatch()) {
      return;
    }
    await initiateRemoteAttempt(
      {
        db: ctx.db,
        identity: ctx.controllerIdentity,
        dataDir: ctx.dataDir,
        connectedAgents: connectedMap,
        serverPort: ctx.agentPlanePort,
        controllerPublicHost: ctx.controllerPublicHost,
        dataPlaneBaseUrl: ctx.dataPlaneBaseUrl,
        snapshotCaptureLimits: ctx.snapshotCaptureLimits,
      },
      jobId,
      decision.selectedAgent.agentId,
      decision.selectedToolchains,
    );
    return;
  }

  if (decision.action === 'local_fallback') {
    if (ctx.shouldContinueDispatch && !ctx.shouldContinueDispatch()) {
      return;
    }
    await runLocalJob(ctx, jobId);
    return;
  }

  if (decision.action === 'fail_fast') {
    const failureMessage =
      decision.noMatchDiagnostic?.hint ?? 'No eligible agent available to execute job';
    logger.info('no matching agent available for job', {
      jobId,
      diagnostic: decision.noMatchDiagnostic,
    });
    transitionJobState(ctx.db, jobId, 'completed', {
      outcome: 'failed',
      finished_at: nowIso(),
      failure_category: 'no_matching_agent',
      failure_message: failureMessage,
      result_json: JSON.stringify({ no_match: decision.noMatchDiagnostic }),
    });
    return;
  }

  // queue_policy=wait: leave job queued until an eligible agent has capacity, or (reason ===
  // 'host_busy') until the host cools down or an agent connects — no attempt exists yet for this
  // job, so there's nowhere to record a per-attempt job_event; this is operator-facing only.
  if (decision.reason === 'host_busy') {
    logger.info(
      'local fallback deferred — host over CPU threshold and not the least-loaded option',
      {
        jobId,
        hostCpuBusyFraction: hostLoad?.cpuBusyFraction,
      },
    );
  }
}

/** Re-attempt scheduling for jobs left in `queued` (wait policy / capacity). */
export async function tryDispatchQueuedJobs(ctx: SubmitJobContext): Promise<void> {
  const rows = ctx.db
    .prepare(
      `SELECT id, request_json FROM jobs WHERE state = 'queued' ORDER BY queued_at ASC, id ASC`,
    )
    .all() as Array<{ id: string; request_json: string }>;

  for (const row of rows) {
    if (ctx.shouldContinueDispatch && !ctx.shouldContinueDispatch()) {
      return;
    }
    let request: JobRequest;
    try {
      request = JobRequestSchema.parse(JSON.parse(row.request_json));
    } catch {
      continue;
    }
    await dispatchJobExecution(ctx, row.id, request);
  }
}

export async function handleJobConfirm(
  ctx: SubmitJobContext,
  args: { job_id: string; confirmation_token: string },
): Promise<Record<string, unknown>> {
  const job = getJob(ctx.db, args.job_id);
  if (!job) {
    return {
      error: {
        category: 'validation',
        message: `Unknown job_id '${args.job_id}'`,
        retryable: false,
      },
    };
  }
  if (job.state !== 'awaiting_confirmation') {
    return {
      error: {
        category: 'validation',
        message: `Job is not awaiting confirmation (state=${job.state})`,
        retryable: false,
      },
    };
  }

  const tokenClaims = verifyConfirmationToken(ctx.controllerIdentity, args.confirmation_token);
  if (!tokenClaims || tokenClaims.job_id !== job.id) {
    return {
      error: {
        category: 'validation',
        message: 'Invalid or expired confirmation token',
        retryable: false,
      },
    };
  }

  const request = JSON.parse(
    (
      ctx.db.prepare('SELECT request_json FROM jobs WHERE id = ?').get(job.id) as {
        request_json: string;
      }
    ).request_json,
  ) as JobRequest;
  const hash = requestHash(request);
  const snapshot = ctx.db
    .prepare('SELECT content_id FROM snapshots WHERE id = ?')
    .get(job.snapshot_id) as { content_id: string } | undefined;

  if (
    tokenClaims.request_hash !== hash ||
    tokenClaims.content_id !== snapshot?.content_id ||
    tokenClaims.risk_level !== request.risk_level
  ) {
    return {
      error: {
        category: 'validation',
        message: 'Confirmation token binding mismatch',
        retryable: false,
      },
    };
  }

  transitionJobState(ctx.db, job.id, 'queued', { queued_at: nowIso() });
  void dispatchJobExecution(ctx, job.id, request).catch((error) => {
    logger.error('job execution dispatch failed', {
      jobId: job.id,
      error: formatUnknownError(error),
    });
  });
  return { job_id: job.id, state: 'queued' };
}

export interface WaitForJobOptions {
  /** Called before each durable wait (for MCP progress heartbeats). */
  onTick?: (job: NonNullable<ReturnType<typeof getJob>>) => void | Promise<void>;
  /** Explicit bounded tail requested by the legacy job_wait contract. */
  includeLogTailLines?: number;
  /** Cancels the wait without changing the durable job state. */
  signal?: AbortSignal;
  /** Deterministic race injection for the focused waiter tests. */
  testHooks?: {
    beforeSubscribe?: () => void | Promise<void>;
    afterSubscribe?: () => void | Promise<void>;
  };
}

export interface BoundedFileTail {
  data: Buffer;
  /** False when the returned suffix may begin inside an escape sequence. */
  prefixComplete: boolean;
}

export async function readBoundedFileTail(
  path: string,
  maxBytes: number,
): Promise<BoundedFileTail> {
  try {
    const size = (await stat(path)).size;
    const start = Math.max(0, size - maxBytes);
    const handle = await open(path, 'r');
    try {
      const output = Buffer.alloc(size - start);
      let offset = 0;
      while (offset < output.length) {
        const result = await handle.read(output, offset, output.length - offset, start + offset);
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      return {
        data: output.subarray(0, offset),
        prefixComplete: start === 0 && offset === output.length,
      };
    } finally {
      await handle.close();
    }
  } catch {
    return { data: Buffer.alloc(0), prefixComplete: true };
  }
}

async function readJobWaitTail(
  ctx: LocalRunnerContext,
  jobId: string,
  lines: number,
): Promise<string> {
  const attempt = getLatestAttempt(ctx.db, jobId);
  if (!attempt || lines <= 0) return '';
  const logDir = attemptLogDir(ctx.dataDir, attempt.id);
  const perStreamBytes = Math.min(DEFAULT_WAIT_TAIL_MAX_BYTES, Math.max(1024, lines * 1024));
  const [stderr, stdout] = await Promise.all([
    readBoundedFileTail(join(logDir, 'stderr.log'), perStreamBytes),
    readBoundedFileTail(join(logDir, 'stdout.log'), perStreamBytes),
  ]);
  return presentLogTail([stderr.data], [stdout.data], {
    maxBytes: DEFAULT_WAIT_TAIL_MAX_BYTES,
    maxLines: lines,
    stderrPrefixComplete: stderr.prefixComplete,
    stdoutPrefixComplete: stdout.prefixComplete,
  }).toString('utf8');
}

export async function waitForJob(
  ctx: LocalRunnerContext,
  jobId: string,
  waitSeconds: number,
  options?: WaitForJobOptions,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + waitSeconds * 1000;
  let job = getJob(ctx.db, jobId);
  if (!job) {
    return {
      error: { category: 'validation', message: `Unknown job_id '${jobId}'`, retryable: false },
    };
  }

  while (
    job &&
    !isTerminalJobState(job.state) &&
    !options?.signal?.aborted &&
    Date.now() < deadline
  ) {
    if (options?.onTick) {
      await options.onTick(job);
    }

    // The initial read, subscribe, and second read form one lost-wakeup-safe
    // protocol: a transition in either read/subscribe gap is observed by the
    // second durable read, while a transition after the second read wakes the
    // waiter through the runtime-owned notifier.
    let wake: (() => void) | undefined;
    let unsubscribe: () => void = () => undefined;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const wakePromise = new Promise<void>((resolvePromise) => {
      wake = resolvePromise;
    });
    const fallbackPromise = new Promise<void>((resolvePromise) => {
      const remainingMs = Math.max(0, deadline - Date.now());
      fallbackTimer = setTimeout(resolvePromise, Math.min(WAIT_FALLBACK_INTERVAL_MS, remainingMs));
    });
    const signal = options?.signal;
    const abortPromise = signal
      ? new Promise<void>((resolvePromise) => {
          if (signal.aborted) {
            resolvePromise();
            return;
          }
          abortListener = () => resolvePromise();
          signal.addEventListener('abort', abortListener, { once: true });
        })
      : undefined;

    try {
      const beforeSubscribe = options?.testHooks?.beforeSubscribe;
      if (beforeSubscribe) await beforeSubscribe();
      try {
        unsubscribe = subscribeToJobLifecycle(ctx.db, jobId, () => wake?.());
      } catch (error) {
        // Tests and embedded callers may not bind the Controller runtime
        // notifier. The durable fallback remains safe, only less immediate.
        if (
          !(error instanceof Error) ||
          error.message !== 'No job lifecycle notifier is bound to this database'
        ) {
          throw error;
        }
      }
      const afterSubscribe = options?.testHooks?.afterSubscribe;
      if (afterSubscribe) await afterSubscribe();
      const reread = getJob(ctx.db, jobId);
      if (!reread || isTerminalJobState(reread.state)) {
        job = reread;
        continue;
      }
      job = reread;

      await Promise.race(
        [wakePromise, fallbackPromise, abortPromise].filter(
          (promise): promise is Promise<void> => promise !== undefined,
        ),
      );
    } finally {
      unsubscribe();
      if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
      if (abortListener && signal) {
        signal.removeEventListener('abort', abortListener);
      }
    }
    job = getJob(ctx.db, jobId);
  }

  const result: Record<string, unknown> = { job };
  if (options?.includeLogTailLines && options.includeLogTailLines > 0) {
    result.log_tail = await readJobWaitTail(ctx, jobId, options.includeLogTailLines);
  }
  return result;
}

export async function handleJobCancel(
  ctx: LocalRunnerContext & { connectedAgents?: Map<string, ConnectedAgent> },
  jobId: string,
  reason?: string,
): Promise<Record<string, unknown>> {
  const job = getJob(ctx.db, jobId);
  if (!job) {
    return {
      error: { category: 'validation', message: `Unknown job_id '${jobId}'`, retryable: false },
    };
  }
  if (isTerminalJobState(job.state)) {
    return { job, cancelled: false, reason: 'already_terminal' };
  }

  const attempt = getLatestAttempt(ctx.db, jobId);
  let signalled = false;

  // Remote attempt: send cancel_job over Agent WS. Do not free Controller
  // capacity / mark cancelled until Agent reports cancelled exit/cleanup
  // (or disconnect). If the Agent is already gone, finalize here.
  if (attempt?.agent_id) {
    if (ctx.connectedAgents) {
      signalled = requestRemoteJobCancel(
        { db: ctx.db, connectedAgents: ctx.connectedAgents },
        jobId,
        reason,
      );
    }
    if (!signalled) {
      transitionAttemptState(ctx.db, attempt.id, 'completed', {
        outcome: 'cancelled',
        finished_at: nowIso(),
      });
      transitionJobState(ctx.db, jobId, 'completed', {
        outcome: 'cancelled',
        finished_at: nowIso(),
        failure_category: 'cancelled',
        failure_message: reason ?? 'Job cancelled (agent unreachable)',
      });
      signalled = true;
    }
    recordCancelEvent(ctx.db, ctx.dataDir, jobId, reason, signalled);
    return { job_id: jobId, cancel_requested: signalled };
  }

  signalled = requestJobCancel(ctx.db, jobId);
  recordCancelEvent(ctx.db, ctx.dataDir, jobId, reason, signalled);
  return { job_id: jobId, cancel_requested: signalled };
}

function recordCancelEvent(
  db: ControllerDatabase,
  dataDir: string,
  jobId: string,
  reason: string | undefined,
  signalled: boolean,
): void {
  const attempt = getLatestAttempt(db, jobId);
  if (!attempt) {
    return;
  }
  const event = createJobEvent(db, {
    type: 'cancel_requested',
    job_id: jobId,
    attempt_id: attempt.id,
    reason,
    signalled,
  });
  recordEvent(db, event);
  const logDir = attemptLogDir(dataDir, attempt.id);
  void appendEvent(
    {
      logDir,
      stdoutPath: join(logDir, 'stdout.log'),
      stderrPath: join(logDir, 'stderr.log'),
      eventsPath: join(logDir, 'events.jsonl'),
      chunksPath: join(logDir, 'chunks.jsonl'),
    },
    event,
  ).catch(() => undefined);
}

export function handleJobArtifacts(db: ControllerDatabase, jobId: string): Record<string, unknown> {
  const job = getJob(db, jobId);
  if (!job) {
    return {
      error: { category: 'validation', message: `Unknown job_id '${jobId}'`, retryable: false },
    };
  }
  const artifacts = listArtifactsForJob(db, jobId);
  const attempts = [...new Set(artifacts.map((a) => a.attempt_id))];
  const terminalAttempt = getLatestAttempt(db, jobId)?.id ?? null;
  return { job_id: jobId, artifacts, attempts, terminal_attempt_id: terminalAttempt };
}
