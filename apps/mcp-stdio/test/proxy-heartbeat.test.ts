import { afterEach, describe, expect, it, vi } from 'vitest';
import { STDIO_JOB_RUN_HEARTBEAT_MS, startProgressHeartbeat } from '../src/proxy.js';

describe('startProgressHeartbeat', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('no-ops when progressToken is missing', () => {
    const sendNotification = vi.fn(async () => undefined);
    const hb = startProgressHeartbeat({
      progressToken: undefined,
      sendNotification,
      intervalMs: 10,
    });
    hb.stop();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('emits increasing progress notifications on an interval', async () => {
    vi.useFakeTimers();
    const sendNotification = vi.fn(async () => undefined);
    const hb = startProgressHeartbeat({
      progressToken: 'tok-1',
      sendNotification,
      intervalMs: STDIO_JOB_RUN_HEARTBEAT_MS,
      messagePrefix: 'job_run',
    });

    await vi.advanceTimersByTimeAsync(STDIO_JOB_RUN_HEARTBEAT_MS);
    await vi.advanceTimersByTimeAsync(STDIO_JOB_RUN_HEARTBEAT_MS);
    hb.stop();

    expect(sendNotification).toHaveBeenCalledTimes(2);
    expect(sendNotification.mock.calls[0]?.[0]).toMatchObject({
      method: 'notifications/progress',
      params: { progressToken: 'tok-1', progress: 1 },
    });
    expect(sendNotification.mock.calls[1]?.[0]).toMatchObject({
      params: { progress: 2 },
    });
  });
});
