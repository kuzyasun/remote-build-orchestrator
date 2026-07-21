import type { ArtifactRule, ExecutionConfig, JobRequest, RiskLevel } from '@rbo/protocol';
import { JobRequestSchema } from '@rbo/protocol';
import { RboError, generateId } from '@rbo/shared';
import { type JobRow, getJob, isTerminalJobState } from './lifecycle.js';
import {
  type SubmitJobContext,
  handleJobArtifacts,
  handleJobSubmit,
  waitForJob,
} from './submit.js';

export const DEFAULT_MCP_WAIT_SLICE_SECONDS = 50;

export interface JobRunProgressUpdate {
  progress: number;
  message: string;
}

export interface JobRunInput {
  command?: string;
  project_root?: string;
  job_id?: string;
  cwd?: string;
  timeout_seconds?: number;
  wait_seconds?: number;
  mcp_wait_slice_seconds?: number;
  artifacts?: ArtifactRule[];
  risk_level?: RiskLevel;
  client_request_id?: string;
  name?: string;
  include_log_tail_lines?: number;
}

export interface JobRunOptions {
  onProgress?: (update: JobRunProgressUpdate) => void | Promise<void>;
}

/** Build fail-closed shell execution from a single command string (AI does not pass boilerplate). */
export function wrapCommandAsExecution(
  command: string,
  timeoutSeconds: number,
  platform: NodeJS.Platform = process.platform,
): Pick<ExecutionConfig, 'shell' | 'script' | 'timeout_seconds'> {
  if (platform === 'win32') {
    return {
      shell: 'powershell',
      script: [
        "$ErrorActionPreference = 'Stop'",
        command,
        'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
      ].join('\n'),
      timeout_seconds: timeoutSeconds,
    };
  }
  return {
    shell: 'bash',
    script: `set -euo pipefail\n${command}\n`,
    timeout_seconds: timeoutSeconds,
  };
}

function deriveJobName(command: string): string {
  const compact = command.replace(/\s+/g, ' ').trim();
  if (compact.length <= 72) {
    return compact;
  }
  return `${compact.slice(0, 69)}...`;
}

/** Map job_run MCP args → canonical JobRequest (Controller owns shell wrapping). */
export function buildJobRunRequest(
  input: JobRunInput,
  platform: NodeJS.Platform = process.platform,
): JobRequest {
  if (!input.command || !input.project_root) {
    throw RboError.validation('job_run requires command and project_root unless job_id is set');
  }
  const timeoutSeconds = input.timeout_seconds ?? 3600;
  return JobRequestSchema.parse({
    client_request_id: input.client_request_id ?? generateId('req'),
    name: input.name ?? deriveJobName(input.command),
    source: {
      project_root: input.project_root,
      cwd: input.cwd ?? '.',
    },
    execution: wrapCommandAsExecution(input.command, timeoutSeconds, platform),
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

function resolveSliceSeconds(rawInput: JobRunInput): number {
  const slice = rawInput.mcp_wait_slice_seconds ?? DEFAULT_MCP_WAIT_SLICE_SECONDS;
  return Math.min(55, Math.max(1, slice));
}

function resolveWaitBudget(rawInput: JobRunInput): number {
  const timeoutSeconds = rawInput.timeout_seconds ?? 3600;
  const requested = rawInput.wait_seconds ?? timeoutSeconds;
  return Math.min(requested, resolveSliceSeconds(rawInput));
}

async function finishJobRunResponse(
  ctx: SubmitJobContext,
  jobId: string,
  waitResult: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if ('error' in waitResult && waitResult.error) {
    return waitResult;
  }
  const job = waitResult.job as JobRow | undefined;
  const terminal = job ? isTerminalJobState(job.state) : false;
  const artifacts =
    terminal && job ? ((handleJobArtifacts(ctx.db, jobId).artifacts as unknown[]) ?? []) : [];
  return {
    job_id: jobId,
    ...summarizeJob(job),
    resume: !terminal,
    log_tail: waitResult.log_tail ?? null,
    artifacts,
  };
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
  const includeLogTailLines = rawInput.include_log_tail_lines ?? 80;
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
      return {
        job_id: jobId,
        ...summarizeJob(existing),
        resume: false,
        confirmation_required: true,
        log_tail: null,
        artifacts: [],
      };
    }
    if (isTerminalJobState(existing.state)) {
      const artifactsResult = handleJobArtifacts(ctx.db, jobId);
      return {
        job_id: jobId,
        ...summarizeJob(existing),
        resume: false,
        log_tail: null,
        artifacts: Array.isArray(artifactsResult.artifacts) ? artifactsResult.artifacts : [],
      };
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

  const waitResult = await waitForJob(ctx, jobId, waitBudget, includeLogTailLines, { onTick });
  return finishJobRunResponse(ctx, jobId, waitResult);
}
