import { followJobLogsRemote, runJobRemote } from './jobs.js';
import type { JobRunInput } from './run.js';

export interface RunToTerminalOptions {
  follow?: boolean;
  onChunk?: (stream: 'stdout' | 'stderr', text: string) => void;
  signal?: AbortSignal;
  pollMs?: number;
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
  let result = await runJobRemote(baseUrl, initialInput);
  if (!needsResume(result)) {
    return result;
  }

  const jobId = jobIdFromResult(result);
  if (options.follow) {
    await followJobLogsRemote(baseUrl, jobId, {
      onChunk: options.onChunk,
      signal: options.signal,
      pollMs: options.pollMs,
    });
    return runJobRemote(baseUrl, { job_id: jobId });
  }

  while (needsResume(result)) {
    result = await runJobRemote(baseUrl, { job_id: jobId });
  }
  return result;
}
