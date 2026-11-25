import { ExecutionConfigSchema } from '@rbo/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NativeExecutorResultTimeoutError, waitForCompletion } from '../src/completion.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const logs = { logDir: '', stdoutPath: '', stderrPath: '', eventsPath: '' };
const execution = ExecutionConfigSchema.parse({ script: 'echo done', timeout_seconds: 1 });

it('accepts the native exit reported during the output drain window', async () => {
  const abort = vi.fn();
  const result = waitForCompletion({
    child: {
      nativeResultDelivery: { graceMs: 2_000, abort },
      waitForExit: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ exitCode: 0, signal: null }), 1_500);
        }),
    },
    execution,
    logs,
    signal: { cancelled: false },
  });
  await vi.advanceTimersByTimeAsync(1_500);
  await expect(result).resolves.toEqual({ type: 'exit', exitCode: 0, signal: null });
  expect(abort).not.toHaveBeenCalled();
});

it('bounds missing native results with a transport failure and aborts the helper', async () => {
  const abort = vi.fn();
  const result = waitForCompletion({
    child: {
      nativeResultDelivery: { graceMs: 2_000, abort },
      waitForExit: () => new Promise(() => undefined),
      waitForStart: () => new Promise(() => undefined),
    },
    execution,
    logs,
    signal: { cancelled: false },
  });
  const rejected = expect(result).rejects.toBeInstanceOf(NativeExecutorResultTimeoutError);
  await vi.advanceTimersByTimeAsync(2_999);
  expect(abort).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await rejected;
  expect(abort).toHaveBeenCalledOnce();
});

it('does not report duration success when the helper denies startup', async () => {
  const started = Promise.withResolvers<{ started: false }>();
  const exited = Promise.withResolvers<{ exitCode: null; signal: null }>();
  const result = waitForCompletion({
    child: {
      nativeResultDelivery: { graceMs: 2_000, abort: vi.fn() },
      waitForStart: () => started.promise,
      waitForExit: () => exited.promise,
    },
    execution: { ...execution, completion: { type: 'run_for_duration', duration_seconds: 0.2 } },
    logs,
    signal: { cancelled: false },
  });
  await vi.advanceTimersByTimeAsync(500);
  started.resolve({ started: false });
  exited.resolve({ exitCode: null, signal: null });
  await expect(result).resolves.toEqual({ type: 'exit', exitCode: null, signal: null });
});

it('does not count the native drain window toward a requested duration', async () => {
  const result = waitForCompletion({
    child: {
      nativeResultDelivery: { graceMs: 2_000, abort: vi.fn() },
      waitForExit: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ exitCode: null, signal: null, timedOut: true }), 1_750);
        }),
    },
    execution: { ...execution, completion: { type: 'run_for_duration', duration_seconds: 1.5 } },
    logs,
    signal: { cancelled: false },
  });
  await vi.advanceTimersByTimeAsync(1_750);
  await expect(result).resolves.toEqual({ type: 'timeout' });
});
