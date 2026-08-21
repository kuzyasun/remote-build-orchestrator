import { join } from 'node:path';
import { presentLogChunks, readChunkIndexTail } from '@rbo/executor';
import type { ArtifactRule, ExecutionConfig, JobRequest, RiskLevel } from '@rbo/protocol';
import { JobRequestSchema } from '@rbo/protocol';
import { RboError, generateId } from '@rbo/shared';
import { attemptLogDir } from '../execution/runner.js';
import {
  type LogCursor,
  decodeCursor,
  encodeCursor,
  readIndexedRange,
  readJobLogsPage,
} from '../mcp/log-pagination.js';
import { type JobRow, getJob, getLatestAttempt, isTerminalJobState } from './lifecycle.js';
import { getSubmission } from './submissions.js';
import {
  type SubmitJobContext,
  handleJobArtifacts,
  handleJobSubmit,
  waitForJob,
} from './submit.js';

export const DEFAULT_MCP_WAIT_SLICE_SECONDS = 50;

type ShellId = ExecutionConfig['shell'];
const CANONICAL_TARGET_OS = new Set(['macos', 'windows', 'linux']);

export interface JobRunProgressUpdate {
  progress: number;
  message: string;
}

export interface JobRunInput {
  command?: string;
  project_root?: string;
  job_id?: string;
  shell?: ShellId;
  target_os?: Array<'macos' | 'windows' | 'linux'>;
  cwd?: string;
  timeout_seconds?: number;
  wait_seconds?: number;
  mcp_wait_slice_seconds?: number;
  artifacts?: ArtifactRule[];
  risk_level?: RiskLevel;
  client_request_id?: string;
  name?: string;
  log_cursor?: string | null;
  max_output_bytes?: number;
}

export interface JobRunOptions {
  onProgress?: (update: JobRunProgressUpdate) => void | Promise<void>;
}

/** Build fail-closed shell execution from a single command string (AI does not pass boilerplate). */
export function wrapCommandAsExecution(
  command: string,
  timeoutSeconds: number,
  platform: NodeJS.Platform = process.platform,
  explicitShell?: ShellId,
): Pick<ExecutionConfig, 'shell' | 'script' | 'timeout_seconds'> {
  const shell = explicitShell ?? (platform === 'win32' ? 'powershell' : 'bash');
  const powerShellScript = [
    "$ErrorActionPreference = 'Stop'",
    command,
    'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
  ].join('\n');
  const cmdScript = ['@echo off', command, 'if errorlevel 1 exit /b %errorlevel%'].join('\r\n');

  switch (shell) {
    case 'bash':
    case 'zsh':
      return {
        shell,
        script: `set -euo pipefail\n${command}\n`,
        timeout_seconds: timeoutSeconds,
      };
    case 'sh':
      return {
        shell,
        script: `set -eu\n${command}\n`,
        timeout_seconds: timeoutSeconds,
      };
    case 'powershell':
    case 'pwsh':
      return { shell, script: powerShellScript, timeout_seconds: timeoutSeconds };
    case 'cmd':
      return { shell, script: cmdScript, timeout_seconds: timeoutSeconds };
    case 'direct':
      // `direct` is legacy script execution: cmd.exe on Windows and an executable script on POSIX.
      // It remains a single compact command string, not a future executable/args interface.
      return {
        shell,
        script:
          platform === 'win32'
            ? cmdScript
            : `#!/usr/bin/env bash\nset -euo pipefail\n${command}\n`,
        timeout_seconds: timeoutSeconds,
      };
  }
}

function deriveJobName(command: string): string {
  const compact = command.replace(/\s+/g, ' ').trim();
  if (compact.length <= 72) {
    return compact;
  }
  return `${compact.slice(0, 69)}...`;
}

function directWrappingPlatform(
  targetOs: JobRunInput['target_os'],
  controllerPlatform: NodeJS.Platform,
): NodeJS.Platform {
  if (targetOs?.length !== 1) return controllerPlatform;
  return targetOs[0] === 'windows' ? 'win32' : targetOs[0] === 'macos' ? 'darwin' : 'linux';
}

/** Map job_run MCP args → canonical JobRequest (Controller owns shell wrapping). */
export function buildJobRunRequest(
  input: JobRunInput,
  platform: NodeJS.Platform = process.platform,
): JobRequest {
  if (!input.command || !input.project_root) {
    throw RboError.validation('job_run requires command and project_root unless job_id is set');
  }
  if (
    input.shell === 'direct' &&
    (input.target_os?.length !== 1 || !CANONICAL_TARGET_OS.has(input.target_os[0]))
  ) {
    throw RboError.validation('job_run shell=direct requires exactly one canonical target_os value');
  }
  const timeoutSeconds = input.timeout_seconds ?? 3600;
  return JobRequestSchema.parse({
    client_request_id: input.client_request_id ?? generateId('req'),
    name: input.name ?? deriveJobName(input.command),
    source: {
      project_root: input.project_root,
      cwd: input.cwd ?? '.',
    },
    execution: wrapCommandAsExecution(
      input.command,
      timeoutSeconds,
      input.shell === 'direct' ? directWrappingPlatform(input.target_os, platform) : platform,
      input.shell,
    ),
    requirements: input.target_os ? { os: input.target_os } : undefined,
    risk_level: input.risk_level ?? 'normal',
    artifacts: input.artifacts ?? [],
  });
}

function summarizeJob(job: JobRow | null | undefined): Record<string, unknown> {
  if (!job) {
    return {
      state: null,
      outcome: null,
      exit_code: null,
      failure_category: null,
      failure_message: null,
    };
  }
  return {
    state: job.state,
    outcome: job.outcome,
    exit_code: job.exit_code,
    failure_category: job.failure_category,
    failure_message: job.failure_message,
  };
}

function confirmationResponse(
  ctx: SubmitJobContext,
  jobId: string,
  job: JobRow,
): Record<string, unknown> {
  let persisted: Record<string, unknown> = {};
  try {
    const submission =
      job.client_id === ctx.clientId
        ? getSubmission(ctx.db, job.client_id, job.client_request_id)
        : null;
    if (submission?.response_json) {
      const parsed = JSON.parse(submission.response_json) as unknown;
      if (parsed && typeof parsed === 'object') persisted = parsed as Record<string, unknown>;
    }
  } catch {
    // A legacy/programmatic job may not have an idempotency row; keep the response actionable
    // with the durable snapshot identity even in that case.
  }
  return {
    job_id: jobId,
    ...summarizeJob(job),
    ...persisted,
    snapshot_id: persisted.snapshot_id ?? job.snapshot_id,
    resume: false,
    confirmation_required: true,
    log_tail: null,
    artifacts: [],
  };
}

function resolveSliceSeconds(rawInput: JobRunInput): number {
  const slice = rawInput.mcp_wait_slice_seconds ?? DEFAULT_MCP_WAIT_SLICE_SECONDS;
  return Math.min(55, Math.max(1, slice));
}

function resolveWaitBudget(rawInput: JobRunInput): number {
  const timeoutSeconds = rawInput.timeout_seconds ?? 3600;
  const requested = rawInput.wait_seconds ?? timeoutSeconds;
  return Math.min(requested, resolveSliceSeconds(rawInput));
}

function buildLogPaths(
  dataDir: string,
  attemptId: string,
): import('@rbo/executor').AttemptLogPaths {
  const logDir = attemptLogDir(dataDir, attemptId);
  return {
    logDir,
    stdoutPath: join(logDir, 'stdout.log'),
    stderrPath: join(logDir, 'stderr.log'),
    eventsPath: join(logDir, 'events.jsonl'),
    chunksPath: join(logDir, 'chunks.jsonl'),
  };
}

async function buildDiagnosticExcerpt(
  logs: import('@rbo/executor').AttemptLogPaths,
  maxBytes: number,
): Promise<string> {
  type Entry = import('@rbo/executor').ChunkIndexEntry;
  const rawBudget = Math.min(1024 * 1024, Math.max(4, maxBytes * 2));

  async function collectWindow(streamName: 'stdout' | 'stderr', budget: number): Promise<Entry[]> {
    const window: Entry[] = [];
    let total = 0;
    const boundedEntries = await readChunkIndexTail(
      logs,
      Math.min(4096, Math.max(128, Math.ceil(budget / 4))),
    );
    for (const entry of boundedEntries) {
      if (entry.stream !== streamName || entry.byte_length <= 0) continue;
      window.push(entry);
      total += Math.min(entry.byte_length, budget);
      while (total > budget && window.length > 0) {
        const removed = window.shift();
        total -= Math.min(removed?.byte_length ?? 0, budget);
      }
    }
    return window;
  }

  async function readStream(streamName: 'stdout' | 'stderr', budget: number): Promise<string> {
    if (budget < 4) return '';
    const entries = await collectWindow(streamName, Math.min(rawBudget, budget * 2));
    let state: import('@rbo/executor').LogPresentationState | undefined;
    let tail = Buffer.alloc(0);
    try {
      for (const e of entries) {
        // Read only the newest bounded suffix of a large durable chunk.
        const offset = Math.max(0, e.byte_length - Math.min(1024 * 1024, budget * 2));
        const b = await readIndexedRange(logs, e, offset);
        if (!b || b.length === 0) continue;
        const res = presentLogChunks([b], state, { maxBytes: 1024 * 1024, stripAnsi: true });
        state = res.state;
        if (res.data.length) {
          tail = Buffer.concat([tail, res.data]);
          if (tail.length > budget) tail = tail.subarray(tail.length - budget);
        }
      }
    } catch {
      return '';
    }
    while (tail.length > 0 && tail[0] >= 0x80 && tail[0] <= 0xbf) tail = tail.subarray(1);
    return tail.toString('utf8');
  }

  const stderrStr = await readStream('stderr', maxBytes);
  const stderrBuf = Buffer.from(stderrStr, 'utf8');
  const remaining = Math.max(
    0,
    Math.min(maxBytes - stderrBuf.length, rawBudget - stderrBuf.length),
  );
  const stdoutStr = await readStream('stdout', remaining);

  return stderrStr + stdoutStr;
}

function fitArtifactMetadata(artifacts: unknown[], budget: number): Record<string, unknown> {
  if (artifacts.length === 0) return {};
  const fitting: unknown[] = [];
  let used = 0;
  for (const artifact of artifacts) {
    const bytes = Buffer.byteLength(JSON.stringify(artifact), 'utf8');
    if (used + bytes > budget) break;
    fitting.push(artifact);
    used += bytes;
  }
  if (fitting.length === artifacts.length) return { artifacts: fitting };
  return {
    artifacts: fitting,
    artifact_count: artifacts.length,
    artifacts_truncated: true,
    artifacts_hint: 'Call job_artifacts for the complete artifact list.',
  };
}

function truncateUtf8(value: unknown, maxBytes: number): string {
  const text = String(value);
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let result = bytes.subarray(0, maxBytes);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  while (result.length > 0) {
    try {
      return decoder.decode(result);
    } catch {
      result = result.subarray(0, result.length - 1);
    }
  }
  return '';
}

async function finishJobRunResponse(
  ctx: SubmitJobContext,
  jobId: string,
  waitResult: Record<string, unknown>,
  rawInput: JobRunInput,
): Promise<Record<string, unknown>> {
  if ('error' in waitResult && waitResult.error) {
    return waitResult;
  }
  const job = waitResult.job as JobRow | undefined;
  if (!job) return waitResult;

  const terminal = isTerminalJobState(job.state);
  const artifactsRaw = terminal
    ? ((handleJobArtifacts(ctx.db, jobId).artifacts as unknown[]) ?? [])
    : [];
  const maxBytes = rawInput.max_output_bytes ?? 16384;
  const artifactPayload = fitArtifactMetadata(
    artifactsRaw,
    job.outcome === 'succeeded' ? 1536 : 3072,
  );
  const suppliedCursor = rawInput.log_cursor ?? null;

  let nextLogCursor = suppliedCursor;
  let diagnosticExcerpt: string | undefined;
  let logChunks:
    | Array<{ sequence: number; stream: string; text: string; complete: boolean }>
    | undefined;
  const resume = !terminal;
  let returnedBytes: number | undefined;
  let hasMore: boolean | undefined;
  let truncated: boolean | undefined;

  const attempt = getLatestAttempt(ctx.db, jobId);

  let decodedSupplied: LogCursor | null = null;
  if (suppliedCursor) {
    if (!ctx.controllerIdentity)
      return {
        error: {
          category: 'validation',
          message: 'Controller identity is not configured',
          retryable: false,
        },
      };
    decodedSupplied = decodeCursor(ctx.controllerIdentity, suppliedCursor);
    if (!decodedSupplied)
      return {
        error: {
          category: 'validation',
          message: 'Invalid or expired job_logs cursor',
          retryable: false,
        },
      };
    if (
      !attempt ||
      decodedSupplied.job !== jobId ||
      decodedSupplied.attempt !== attempt.id ||
      decodedSupplied.mode !== 'logs'
    ) {
      return {
        error: {
          category: 'validation',
          message: 'Cursor does not match job, attempt, or mode',
          retryable: false,
        },
      };
    }
  }

  if (terminal) {
    if (job.outcome === 'succeeded') {
      const out: Record<string, unknown> = {
        job_id: jobId,
        state: job.state,
        outcome: job.outcome,
        exit_code: job.exit_code,
      };
      Object.assign(out, artifactPayload);
      // returned exactly the cursor if no chunks consumed
      if (decodedSupplied) out.next_log_cursor = suppliedCursor;
      return out;
    }
    // failed terminal
    const out: Record<string, unknown> = {
      job_id: jobId,
      state: job.state,
      outcome: job.outcome,
      exit_code: job.exit_code,
    };
    if (job.failure_category != null)
      out.failure_category = truncateUtf8(job.failure_category, 1024);
    if (job.failure_message != null) out.failure_message = truncateUtf8(job.failure_message, 2048);
    Object.assign(out, artifactPayload);

    if (attempt) {
      const logs = buildLogPaths(ctx.dataDir, attempt.id);
      out.diagnostic_excerpt = await buildDiagnosticExcerpt(logs, maxBytes);
    }
    if (decodedSupplied) out.next_log_cursor = suppliedCursor;
    return out;
  }

  // Non-terminal resume
  if (attempt && ctx.controllerIdentity) {
    let cursor: LogCursor = {
      v: 1,
      job: jobId,
      attempt: attempt.id,
      mode: 'logs',
      seq: 0,
      off: 0,
      profile: 'ansi-v1',
    };
    if (decodedSupplied) {
      cursor = decodedSupplied;
    }

    const logs = buildLogPaths(ctx.dataDir, attempt.id);

    try {
      const page = await readJobLogsPage(logs, cursor, maxBytes);
      if (page.chunks.length > 0) logChunks = page.chunks;
      nextLogCursor = encodeCursor(ctx.controllerIdentity, page.next);
      if (!nextLogCursor)
        return {
          error: { category: 'internal', message: 'Unable to encode log cursor', retryable: true },
        };
      returnedBytes = page.returned;
      hasMore = page.hasMore;
      truncated = page.truncated;
    } catch {
      return {
        error: {
          category: 'internal',
          message: 'Unable to read durable job logs',
          retryable: true,
        },
      };
    }
  }

  const out: Record<string, unknown> = {
    job_id: jobId,
    state: job.state,
    outcome: job.outcome,
    exit_code: job.exit_code,
    resume,
  };
  if (job.failure_category != null) out.failure_category = truncateUtf8(job.failure_category, 1024);
  if (job.failure_message != null) out.failure_message = truncateUtf8(job.failure_message, 2048);
  if (logChunks) out.log_chunks = logChunks;
  if (nextLogCursor) out.next_log_cursor = nextLogCursor;
  if (returnedBytes !== undefined) out.returned_bytes = returnedBytes;
  if (hasMore !== undefined) out.has_more = hasMore;
  if (truncated !== undefined) out.truncated = truncated;
  Object.assign(out, artifactPayload);

  return out;
}

/**
 * Interactive AI primary path: submit → MCP wait slice → outcome/log_tail/artifacts.
 * Non-terminal after the slice returns resume:true; pass job_id to continue.
 */
export async function handleJobRun(
  ctx: SubmitJobContext,
  rawInput: JobRunInput,
  options: JobRunOptions = {},
): Promise<Record<string, unknown>> {
  const waitBudget = resolveWaitBudget(rawInput);
  let progressCounter = 0;
  const startedAt = Date.now();
  let lastProgressAt = 0;
  const onTick = options.onProgress
    ? async (job: JobRow) => {
        const now = Date.now();
        if (now - lastProgressAt < 5000 && progressCounter > 0) {
          return;
        }
        lastProgressAt = now;
        progressCounter += 1;
        const elapsedSec = Math.round((now - startedAt) / 1000);
        await options.onProgress?.({
          progress: progressCounter,
          message: `job_run state=${job.state} elapsed=${elapsedSec}s`,
        });
      }
    : undefined;

  let jobId = rawInput.job_id?.trim() || '';

  if (jobId) {
    const existing = getJob(ctx.db, jobId);
    if (!existing) {
      return {
        error: {
          category: 'validation',
          message: `Unknown job_id '${jobId}'`,
          retryable: false,
        },
      };
    }
    if (existing.state === 'awaiting_confirmation') {
      return confirmationResponse(ctx, jobId, existing);
    }
    if (isTerminalJobState(existing.state)) {
      return finishJobRunResponse(ctx, jobId, { job: existing }, rawInput);
    }
  } else {
    if (!rawInput.command || !rawInput.project_root) {
      return {
        error: {
          category: 'validation',
          message: 'job_run requires command and project_root unless job_id is set',
          retryable: false,
        },
      };
    }
    const request = buildJobRunRequest(rawInput);
    const submit = await handleJobSubmit(ctx, request);
    if ('error' in submit && submit.error) {
      return submit;
    }
    jobId = String(submit.job_id);
    if (submit.state === 'awaiting_confirmation') {
      return {
        job_id: jobId,
        state: 'awaiting_confirmation',
        confirmation_token: submit.confirmation_token,
        snapshot_id: submit.snapshot_id,
        content_id: submit.content_id,
        secret_warnings: submit.secret_warnings,
        outcome: null,
        exit_code: null,
        failure_category: null,
        failure_message: null,
        resume: false,
        log_tail: null,
        artifacts: [],
      };
    }
  }

  const waitResult = await waitForJob(ctx, jobId, waitBudget, { onTick });
  return finishJobRunResponse(ctx, jobId, waitResult, rawInput);
}
