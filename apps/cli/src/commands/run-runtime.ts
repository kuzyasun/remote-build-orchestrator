import {
  cancelJobRemote,
  confirmJobRemote,
  followJobLogsRemote,
  getJobRemote,
  runJobRemote,
} from './jobs.js';
import type { JobRunInput } from './run.js';

const DEFAULT_CANCEL_CONFIRMATION_MS = 10_000;

export interface RunToTerminalOptions {
  follow?: boolean;
  onChunk?: (stream: 'stdout' | 'stderr', text: string) => void;
  signal?: AbortSignal;
  pollMs?: number;
  onJobId?: (jobId: string) => void;
}

export interface RunTerminalIo {
  isTTY: boolean;
  writeStderr: (text: string) => void;
  confirm: (prompt: string, signal: AbortSignal | undefined) => Promise<boolean>;
}

export interface RunLifecycleOptions extends RunToTerminalOptions {
  io: RunTerminalIo;
}

export class ConfirmationRequiredError extends Error {
  readonly category = 'confirmation_required';

  constructor(readonly jobId: string) {
    super(
      `Job ${jobId} requires interactive confirmation. Use a TTY-enabled client to call \`job_confirm\` for this job.`,
    );
    this.name = 'ConfirmationRequiredError';
  }
}

export class ConfirmationDeclinedError extends Error {
  constructor(readonly jobId: string) {
    super(`Job ${jobId} was not confirmed and remains awaiting confirmation.`);
    this.name = 'ConfirmationDeclinedError';
  }
}

export class RunInterruptedError extends Error {
  constructor(readonly jobId: string | null) {
    super(
      jobId
        ? `Interrupted while waiting for job ${jobId}`
        : 'Interrupted before job ID was received',
    );
    this.name = 'RunInterruptedError';
  }
}

/** Only recognize the CLI flag before the shell-command separator. */
export function takeRunFollowFlag(args: string[]): { follow: boolean; args: string[] } {
  const separator = args.indexOf('--');
  if (separator === -1) return { follow: false, args };
  let follow = false;
  const options = args.slice(0, separator).filter((arg) => {
    if (arg === '--follow') {
      follow = true;
      return false;
    }
    return true;
  });
  return { follow, args: [...options, ...args.slice(separator)] };
}

function jobIdFromResult(result: Record<string, unknown>): string {
  if (typeof result.job_id !== 'string' || result.job_id.length === 0) {
    throw new Error('Malformed job_run response: expected job_id');
  }
  return result.job_id;
}

function needsResume(result: Record<string, unknown>): boolean {
  return result.resume === true;
}

function interrupted(signal: AbortSignal | undefined, jobId: string | null): void {
  if (signal?.aborted) throw new RunInterruptedError(jobId);
}

async function requestJobRun(
  baseUrl: string,
  input: JobRunInput,
  signal: AbortSignal | undefined,
  jobId: string | null,
): Promise<Record<string, unknown>> {
  try {
    return await runJobRemote(baseUrl, input, { signal });
  } catch (error) {
    if (signal?.aborted) throw new RunInterruptedError(jobId);
    throw error;
  }
}

/**
 * Complete the compact job_run resume protocol without imposing a CLI-wide wait deadline.
 * `--follow` uses the separate, numeric SSE event sequence and obtains one final job_run result
 * after the stream reports completion.
 */
export async function runJobToTerminal(
  baseUrl: string,
  initialInput: JobRunInput,
  options: RunToTerminalOptions = {},
): Promise<Record<string, unknown>> {
  interrupted(options.signal, null);
  let result = await requestJobRun(baseUrl, initialInput, options.signal, null);
  const initialJobId = jobIdFromResult(result);
  options.onJobId?.(initialJobId);
  interrupted(options.signal, initialJobId);
  if (!needsResume(result)) return result;

  if (options.follow) {
    await followJobLogsRemote(baseUrl, initialJobId, {
      onChunk: options.onChunk,
      signal: options.signal,
      pollMs: options.pollMs,
    });
    interrupted(options.signal, initialJobId);
    return requestJobRun(baseUrl, { job_id: initialJobId }, options.signal, initialJobId);
  }

  while (needsResume(result)) {
    interrupted(options.signal, initialJobId);
    result = await requestJobRun(baseUrl, { job_id: initialJobId }, options.signal, initialJobId);
  }
  interrupted(options.signal, initialJobId);
  return result;
}

function confirmationToken(result: Record<string, unknown>): string {
  if (typeof result.confirmation_token !== 'string' || result.confirmation_token.length === 0) {
    throw new Error('Malformed job_run confirmation response: expected confirmation_token');
  }
  return result.confirmation_token;
}

function formatConfirmationSummary(result: Record<string, unknown>, jobId: string): string {
  const lines = [`Job ${jobId} requires confirmation.`];
  if (typeof result.snapshot_id === 'string' && result.snapshot_id.length > 0) {
    lines.push(`Snapshot: ${result.snapshot_id}`);
  }
  if (Array.isArray(result.secret_warnings) && result.secret_warnings.length > 0) {
    lines.push(`Warnings: ${result.secret_warnings.map(String).join(', ')}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Run the compact protocol and explicitly confirm a destructive/hardware job when needed.
 * The confirmation token remains Controller-owned; the CLI only presents it to job_confirm.
 */
export async function runJobWithLifecycle(
  baseUrl: string,
  initialInput: JobRunInput,
  options: RunLifecycleOptions,
): Promise<Record<string, unknown>> {
  const first = await runJobToTerminal(baseUrl, initialInput, options);
  if (first.state !== 'awaiting_confirmation') return first;

  const jobId = jobIdFromResult(first);
  options.io.writeStderr(formatConfirmationSummary(first, jobId));
  if (!options.io.isTTY) throw new ConfirmationRequiredError(jobId);
  let accepted: boolean;
  try {
    accepted = await options.io.confirm(
      `Confirm execution of job ${jobId}? [y/N] `,
      options.signal,
    );
  } catch (error) {
    if (options.signal?.aborted) throw new RunInterruptedError(jobId);
    throw error;
  }
  if (!accepted) throw new ConfirmationDeclinedError(jobId);
  interrupted(options.signal, jobId);
  try {
    await confirmJobRemote(baseUrl, jobId, confirmationToken(first), { signal: options.signal });
  } catch (error) {
    if (options.signal?.aborted) throw new RunInterruptedError(jobId);
    throw error;
  }
  return runJobToTerminal(baseUrl, { job_id: jobId }, options);
}

function isTerminalCancelled(result: Record<string, unknown>): boolean {
  return result.outcome === 'cancelled' || result.failure_category === 'cancelled';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Best-effort cancellation followed by a bounded confirmation wait. */
export async function cancelAndAwaitJob(
  baseUrl: string,
  jobId: string,
  options: { confirmationMs?: number; pollMs?: number; writeStderr: (text: string) => void },
): Promise<boolean> {
  const confirmationMs = options.confirmationMs ?? DEFAULT_CANCEL_CONFIRMATION_MS;
  const pollMs = options.pollMs ?? 250;
  const deadline = Date.now() + confirmationMs;
  try {
    await cancelJobRemote(baseUrl, jobId, 'Interrupted by CLI', {
      timeoutMs: Math.max(1, Math.min(2_000, deadline - Date.now())),
    });
  } catch {
    options.writeStderr(
      `Could not confirm cancellation request for job ${jobId}; continuing to check.\n`,
    );
  }

  while (Date.now() < deadline) {
    try {
      const status = await getJobRemote(baseUrl, jobId, {
        timeoutMs: Math.max(1, Math.min(2_000, deadline - Date.now())),
      });
      const job = status.job;
      if (job && typeof job === 'object' && isTerminalCancelled(job as Record<string, unknown>)) {
        return true;
      }
    } catch {
      // A transient Controller failure does not extend the fixed cancellation window.
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await sleep(Math.min(pollMs, remaining));
  }
  options.writeStderr(
    `Cancellation was not confirmed within 10 seconds for job ${jobId}; it may still be stopping.\n`,
  );
  return false;
}

/** Map terminal Controller data to the documented CLI process status. */
export function terminalExitCode(result: Record<string, unknown>): number {
  const remoteExit = result.exit_code;
  if (
    typeof remoteExit === 'number' &&
    Number.isInteger(remoteExit) &&
    remoteExit >= 0 &&
    remoteExit <= 255
  ) {
    return remoteExit;
  }
  if (remoteExit !== null && remoteExit !== undefined) return 125;
  if (result.outcome === 'timed_out' || result.failure_category === 'timeout') return 124;
  if (isTerminalCancelled(result)) return 130;
  return result.outcome === 'succeeded' ? 0 : 1;
}

/** Map local lifecycle decisions which happen before a terminal Controller result exists. */
export function runLifecycleErrorExitCode(error: unknown): number | null {
  if (error instanceof ConfirmationRequiredError) return 125;
  if (error instanceof ConfirmationDeclinedError) return 1;
  return null;
}

/** Keep machine-readable output isolated from human diagnostics and live log streams. */
export function writeRunResult(
  result: Record<string, unknown>,
  options: {
    json: boolean;
    writeStdout: (text: string) => void;
    writeStderr: (text: string) => void;
  },
): void {
  if (options.json) {
    options.writeStdout(`${JSON.stringify(result)}\n`);
    return;
  }
  options.writeStderr(`${JSON.stringify(result, null, 2)}\n`);
}
