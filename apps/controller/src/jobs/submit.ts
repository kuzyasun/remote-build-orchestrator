import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { appendEvent, readLogTail } from '@rbo/executor';
import type { AgentCapabilityReport, JobRequest } from '@rbo/protocol';
import { JobRequestSchema } from '@rbo/protocol';
import type { ControllerIdentity } from '@rbo/shared';
import { RboError, generateId, signEdDsaJwt, verifyEdDsaJwt } from '@rbo/shared';
import { stableStringify } from '@rbo/snapshot';
import { listArtifactsForJob } from '../execution/artifacts.js';
import { initiateRemoteAttempt, requestRemoteJobCancel } from '../execution/remote-execution.js';
import {
  type LocalRunnerContext,
  attemptLogDir,
  captureAndPersistSnapshot,
  requestJobCancel,
  runLocalJob,
} from '../execution/runner.js';
import {
  type SchedulerAgent,
  getActiveJobsForAgents,
  selectAgentForJob,
} from '../scheduler/index.js';
import type { ControllerDatabase } from '../storage/database.js';
import { nowIso } from '../storage/database.js';
import type { ConnectedAgent } from '../websocket/server.js';
import {
  createJob,
  createJobEvent,
  getJob,
  getLatestAttempt,
  isDestructiveRisk,
  isTerminalJobState,
  recordEvent,
  transitionAttemptState,
  transitionJobState,
} from './lifecycle.js';
import { completeSubmission, reserveSubmission } from './submissions.js';

const CONFIRMATION_TTL_SECONDS = 300;

export interface SubmitJobContext extends LocalRunnerContext {
  clientId: string;
  controllerIdentity: ControllerIdentity;
  connectedAgents?: Map<string, ConnectedAgent>;
  agentPlanePort?: number;
  controllerPublicHost?: string;
  dataPlaneBaseUrl?: string;
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
  const reserve = reserveSubmission(ctx.db, ctx.clientId, request.client_request_id);
  if (!reserve.created) {
    const existing = reserve.submission;
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
  }

  const initialState = 'created';
  const pendingJobId = generateId('job');

  try {
    const { snapshotId, contentId, secretWarnings } = await captureAndPersistSnapshot(
      ctx,
      pendingJobId,
      request,
    );
    const hash = requestHash(request);

    const job = createJob(ctx.db, {
      jobId: pendingJobId,
      clientId: ctx.clientId,
      clientRequestId: request.client_request_id,
      request,
      initialState,
      name: request.name,
    });
    transitionJobState(ctx.db, job.id, job.state, { snapshot_id: snapshotId });

    if (isDestructiveRisk(request.risk_level)) {
      const confirmation_token = issueConfirmationToken(ctx.controllerIdentity, {
        job_id: job.id,
        request_hash: hash,
        content_id: contentId,
        risk_level: request.risk_level,
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
        request.client_request_id,
        'captured',
        response,
        job.id,
      );
      return response;
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
      request.client_request_id,
      'captured',
      response,
      job.id,
    );
    void dispatchJobExecution(ctx, job.id, request).catch((error) => {
      console.error('job execution dispatch failed', job.id, error);
    });
    return response;
  } catch (error) {
    await rm(join(ctx.dataDir, 'snapshots', pendingJobId), {
      recursive: true,
      force: true,
    }).catch(() => undefined);

    const payload =
      error instanceof RboError
        ? error.toJSON()
        : { category: 'internal', message: String(error), retryable: false };
    completeSubmission(
      ctx.db,
      ctx.clientId,
      request.client_request_id,
      'failed',
      payload as Record<string, unknown>,
    );
    return { error: payload };
  }
}

export async function dispatchJobExecution(
  ctx: SubmitJobContext,
  jobId: string,
  request: JobRequest,
): Promise<void> {
  const connectedMap = ctx.connectedAgents ?? new Map();
  const dbAgents = ctx.db
    .prepare('SELECT id, capabilities_json, state FROM agents WHERE disabled_at IS NULL')
    .all() as Array<{ id: string; capabilities_json: string; state: string }>;

  const activeCounts = getActiveJobsForAgents(ctx.db);
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

  const decision = selectAgentForJob(candidates, request, {
    allowLocalFallback: true,
  });

  if (decision.action === 'remote' && decision.selectedAgent && ctx.agentPlanePort) {
    await initiateRemoteAttempt(
      {
        db: ctx.db,
        identity: ctx.controllerIdentity,
        dataDir: ctx.dataDir,
        connectedAgents: connectedMap,
        serverPort: ctx.agentPlanePort,
        controllerPublicHost: ctx.controllerPublicHost,
        dataPlaneBaseUrl: ctx.dataPlaneBaseUrl,
      },
      jobId,
      decision.selectedAgent.agentId,
      decision.selectedToolchains,
    );
    return;
  }

  if (decision.action === 'local_fallback') {
    await runLocalJob(ctx, jobId);
    return;
  }

  if (decision.action === 'fail_fast') {
    transitionJobState(ctx.db, jobId, 'completed', {
      outcome: 'failed',
      finished_at: nowIso(),
      failure_category: 'no_matching_agent',
      failure_message: 'No eligible agent available to execute job',
    });
    return;
  }

  // queue_policy=wait: leave job queued until an eligible agent has capacity.
}

/** Re-attempt scheduling for jobs left in `queued` (wait policy / capacity). */
export async function tryDispatchQueuedJobs(ctx: SubmitJobContext): Promise<void> {
  const rows = ctx.db
    .prepare(
      `SELECT id, request_json FROM jobs WHERE state = 'queued' ORDER BY queued_at ASC, id ASC`,
    )
    .all() as Array<{ id: string; request_json: string }>;

  for (const row of rows) {
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
    console.error('job execution dispatch failed', job.id, error);
  });
  return { job_id: job.id, state: 'queued' };
}

export async function waitForJob(
  ctx: LocalRunnerContext,
  jobId: string,
  waitSeconds: number,
  includeLogTailLines: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + waitSeconds * 1000;
  let job = getJob(ctx.db, jobId);
  if (!job) {
    return {
      error: { category: 'validation', message: `Unknown job_id '${jobId}'`, retryable: false },
    };
  }

  while (job && !isTerminalJobState(job.state) && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    job = getJob(ctx.db, jobId);
  }

  const response: Record<string, unknown> = { job };
  if (includeLogTailLines > 0 && job) {
    const attempt = getLatestAttempt(ctx.db, jobId);
    if (attempt) {
      const logDir = attemptLogDir(ctx.dataDir, attempt.id);
      response.log_tail = {
        stdout: (await readLogTail(join(logDir, 'stdout.log'), includeLogTailLines)).lines,
        stderr: (await readLogTail(join(logDir, 'stderr.log'), includeLogTailLines)).lines,
        attempt_id: attempt.id,
      };
    }
  }
  return response;
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
