import type { ExecutionConfig } from '@rbo/protocol';
import type { AttemptLogPaths } from './logs.js';
import type { ManagedChildProcess } from './script.js';

export type CompletionResult =
  | { type: 'exit'; exitCode: number | null; signal: NodeJS.Signals | null }
  | { type: 'timeout' }
  | { type: 'duration_complete' }
  | { type: 'log_success' }
  | { type: 'log_failure' };

export class NativeExecutorResultTimeoutError extends Error {
  constructor() {
    super('Windows executor did not deliver its result by the result deadline');
    this.name = 'NativeExecutorResultTimeoutError';
  }
}

function patternMatches(haystack: string, pattern: string): boolean {
  try {
    return new RegExp(pattern, 'm').test(haystack);
  } catch {
    return haystack.includes(pattern);
  }
}

const LOG_MATCH_WINDOW_BYTES = 64 * 1024;
const LOG_MATCH_POLL_MS = 100;

async function readLogDelta(
  path: string,
  offset: number,
): Promise<{ text: string; nextOffset: number }> {
  const { open } = await import('node:fs/promises');
  try {
    const handle = await open(path, 'r');
    try {
      const stat = await handle.stat();
      if (stat.size <= offset) {
        return { text: '', nextOffset: offset };
      }
      const length = stat.size - offset;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return {
        text: buffer.subarray(0, bytesRead).toString('utf8'),
        nextOffset: offset + bytesRead,
      };
    } finally {
      await handle.close();
    }
  } catch {
    return { text: '', nextOffset: offset };
  }
}

function createCancellableTimer<T>(
  ms: number,
  value: T,
): {
  promise: Promise<T>;
  cancel: () => void;
} {
  let handle: NodeJS.Timeout | undefined;
  let settled = false;
  const promise = new Promise<T>((resolvePromise) => {
    handle = setTimeout(() => {
      settled = true;
      handle = undefined;
      resolvePromise(value);
    }, ms);
  });
  return {
    promise,
    cancel: () => {
      if (!settled && handle) {
        clearTimeout(handle);
        handle = undefined;
      }
    },
  };
}

/**
 * Serial log-match poller: one in-flight read at a time so offsets never race.
 */
function watchLogMatch(
  logs: AttemptLogPaths,
  completion: Extract<ExecutionConfig['completion'], { type: 'run_until_log_match' }>,
  signal: { cancelled: boolean },
): { promise: Promise<'log_success' | 'log_failure'>; stop: () => void } {
  let stopped = false;
  let settle: ((value: 'log_success' | 'log_failure') => void) | undefined;
  const promise = new Promise<'log_success' | 'log_failure'>((resolvePromise) => {
    settle = resolvePromise;
  });

  const stop = () => {
    stopped = true;
  };

  void (async () => {
    let stdoutOffset = 0;
    let stderrOffset = 0;
    let window = '';
    while (!stopped && !signal.cancelled) {
      await new Promise<void>((r) => setTimeout(r, LOG_MATCH_POLL_MS));
      if (stopped || signal.cancelled) {
        return;
      }
      const stdoutDelta = await readLogDelta(logs.stdoutPath, stdoutOffset);
      if (stopped || signal.cancelled) {
        return;
      }
      stdoutOffset = stdoutDelta.nextOffset;
      const stderrDelta = await readLogDelta(logs.stderrPath, stderrOffset);
      if (stopped || signal.cancelled) {
        return;
      }
      stderrOffset = stderrDelta.nextOffset;
      if (!stdoutDelta.text && !stderrDelta.text) {
        continue;
      }
      window = `${window}${stdoutDelta.text}${stderrDelta.text}`;
      if (window.length > LOG_MATCH_WINDOW_BYTES) {
        window = window.slice(-LOG_MATCH_WINDOW_BYTES);
      }
      if (completion.failure_pattern && patternMatches(window, completion.failure_pattern)) {
        stop();
        settle?.('log_failure');
        return;
      }
      if (patternMatches(window, completion.success_pattern)) {
        stop();
        settle?.('log_success');
        return;
      }
    }
  })();

  return { promise, stop };
}

/**
 * Wait for job completion according to execution.completion policy
 * (run_to_exit, run_for_duration, run_until_log_match) plus hard timeout.
 */
export async function waitForCompletion(input: {
  child: Pick<ManagedChildProcess, 'waitForExit' | 'nativeResultDelivery'> &
    Partial<Pick<ManagedChildProcess, 'waitForStart'>>;
  execution: ExecutionConfig;
  logs: AttemptLogPaths;
  signal: { cancelled: boolean };
}): Promise<CompletionResult> {
  const timers: Array<{ cancel: () => void }> = [];
  const cancelAllTimers = () => {
    for (const timer of timers) {
      timer.cancel();
    }
  };

  try {
    const exitP = input.child
      .waitForExit()
      .then(({ exitCode, signal, timedOut }) =>
        timedOut ? ({ type: 'timeout' } as const) : ({ type: 'exit', exitCode, signal } as const),
      );
    type RaceResult = CompletionResult | 'native_result_timeout';
    const native = input.child.nativeResultDelivery;
    const hardTimeout = createCancellableTimer<RaceResult>(
      input.execution.timeout_seconds * 1000 + (native?.graceMs ?? 0),
      native ? 'native_result_timeout' : { type: 'timeout' },
    );
    timers.push(hardTimeout);
    const start = await Promise.race([
      input.child.waitForStart?.() ?? { started: true },
      hardTimeout.promise,
    ]);
    if (start === 'native_result_timeout') {
      native?.abort();
      throw new NativeExecutorResultTimeoutError();
    }
    if ('type' in start) return start;

    const pending: Array<Promise<RaceResult>> = [exitP, hardTimeout.promise];
    const completion = start.started ? input.execution.completion : undefined;

    if (
      completion?.type === 'run_for_duration' &&
      completion.duration_seconds < input.execution.timeout_seconds
    ) {
      const duration = createCancellableTimer<CompletionResult>(
        completion.duration_seconds * 1000,
        { type: 'duration_complete' },
      );
      timers.push(duration);
      pending.push(duration.promise);
    }

    if (completion?.type === 'run_until_log_match') {
      const watcher = watchLogMatch(input.logs, completion, input.signal);
      timers.push({ cancel: watcher.stop });
      pending.push(watcher.promise.then((type) => ({ type })));
      if (completion.max_duration_seconds <= input.execution.timeout_seconds) {
        const maxDuration = createCancellableTimer<CompletionResult>(
          completion.max_duration_seconds * 1000,
          { type: 'timeout' },
        );
        timers.push(maxDuration);
        pending.push(maxDuration.promise);
      } else if (native) {
        // The extra window is only for delivery of the native outcome.
        const stopLogMatch = setTimeout(watcher.stop, input.execution.timeout_seconds * 1000);
        timers.push({ cancel: () => clearTimeout(stopLogMatch) });
      }
    }

    const result = await Promise.race(pending);
    if (result === 'native_result_timeout') {
      native?.abort();
      throw new NativeExecutorResultTimeoutError();
    }
    return result;
  } finally {
    cancelAllTimers();
  }
}
