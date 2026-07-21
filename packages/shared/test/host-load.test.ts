import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CAPACITY_MEMORY_REFERENCE_MB,
  DEFAULT_REFERENCE_CAPACITY_SCORE,
  HostCpuMonitor,
  computeCapacityScore,
  computeCpuBusyFraction,
  sampleCpuBusyFraction,
} from '../src/host-load.js';

function cpu(
  idle: number,
  user: number,
): { model: string; speed: number; times: Record<string, number> } {
  return {
    model: 'test-cpu',
    speed: 3000,
    times: { user, nice: 0, sys: 0, idle, irq: 0 },
  };
}

describe('computeCpuBusyFraction', () => {
  it('is 0 when idle time grows exactly as fast as total time (fully idle)', () => {
    const before = [cpu(1000, 0)];
    const after = [cpu(2000, 0)];
    expect(computeCpuBusyFraction(before, after)).toBe(0);
  });

  it('is 1 when idle time does not grow at all while total time does (fully busy)', () => {
    const before = [cpu(1000, 1000)];
    const after = [cpu(1000, 2000)];
    expect(computeCpuBusyFraction(before, after)).toBe(1);
  });

  it('is 0.5 when idle grows at half the rate of total time', () => {
    const before = [cpu(1000, 1000)];
    const after = [cpu(1500, 2000)]; // idle delta 500, user delta 1000 -> total delta 1500, busy = 1000/1500
    expect(computeCpuBusyFraction(before, after)).toBeCloseTo(2 / 3, 5);
  });

  it('averages across multiple cores', () => {
    const before = [cpu(1000, 0), cpu(1000, 1000)];
    const after = [cpu(2000, 0), cpu(1000, 2000)]; // core 0 fully idle, core 1 fully busy
    expect(computeCpuBusyFraction(before, after)).toBeCloseTo(0.5, 5);
  });

  it('returns 0 (not NaN/Infinity) when no time elapsed between snapshots', () => {
    const snap = [cpu(1000, 1000)];
    expect(computeCpuBusyFraction(snap, snap)).toBe(0);
  });

  it('clamps to [0, 1] even with pathological input (fewer after-cores than before)', () => {
    const before = [cpu(1000, 1000), cpu(1000, 1000)];
    const after = [cpu(2000, 2000)];
    const result = computeCpuBusyFraction(before, after);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(1);
  });
});

describe('sampleCpuBusyFraction', () => {
  it('calls the injected cpus() source twice, delay in between, and computes from both snapshots', async () => {
    const snapshots = [
      [cpu(1000, 1000)],
      [cpu(1500, 2000)], // matches the 2/3 case above
    ];
    let call = 0;
    const fraction = await sampleCpuBusyFraction(1, () => snapshots[call++] as never);
    expect(call).toBe(2);
    expect(fraction).toBeCloseTo(2 / 3, 5);
  });
});

describe('computeCapacityScore', () => {
  it('is cpuLogical * cpuSpeedMhz when memory is not provided', () => {
    expect(computeCapacityScore({ cpuLogical: 8, cpuSpeedMhz: 3000 })).toBe(24000);
  });

  it('is unaffected by memory at or above the reference amount', () => {
    const score = computeCapacityScore({
      cpuLogical: 8,
      cpuSpeedMhz: 3000,
      memoryFreeMb: DEFAULT_CAPACITY_MEMORY_REFERENCE_MB * 2,
    });
    expect(score).toBe(24000);
  });

  it('scales down proportionally when memory is below the reference amount', () => {
    const score = computeCapacityScore({
      cpuLogical: 8,
      cpuSpeedMhz: 3000,
      memoryFreeMb: DEFAULT_CAPACITY_MEMORY_REFERENCE_MB / 2,
    });
    expect(score).toBeCloseTo(12000, 5);
  });

  it('DEFAULT_REFERENCE_CAPACITY_SCORE matches an 8-core/3GHz machine exactly', () => {
    // This is the baseline computeEffectiveMaxHostCpuBusyFraction (scheduler/index.ts) compares
    // a real host against — a machine at exactly this score gets no threshold boost at all.
    expect(DEFAULT_REFERENCE_CAPACITY_SCORE).toBe(
      computeCapacityScore({ cpuLogical: 8, cpuSpeedMhz: 3000 }),
    );
  });
});

describe('HostCpuMonitor', () => {
  it('reports a pessimistic 1 (fully busy) before any sample has landed', () => {
    const monitor = new HostCpuMonitor(async () => 0);
    expect(monitor.currentBusyFraction()).toBe(1);
  });

  it('reports the sampled value after one sample', async () => {
    const monitor = new HostCpuMonitor(async () => 0.3);
    await monitor.sampleOnce();
    expect(monitor.currentBusyFraction()).toBeCloseTo(0.3, 5);
  });

  it('keeps a rolling average over the configured history size', async () => {
    const values = [0.2, 0.4, 0.6, 0.8];
    let i = 0;
    const monitor = new HostCpuMonitor(async () => values[i++] as number, 3);
    for (const _ of values) {
      await monitor.sampleOnce();
    }
    // last 3 samples: 0.4, 0.6, 0.8 -> average 0.6 (oldest 0.2 dropped)
    expect(monitor.currentBusyFraction()).toBeCloseTo(0.6, 5);
  });

  it('start() samples immediately and again on each interval tick; stop() halts it', async () => {
    vi.useFakeTimers();
    try {
      const sampleFn = vi.fn(async () => 0.5);
      const monitor = new HostCpuMonitor(sampleFn);
      monitor.start(1000);
      await vi.advanceTimersByTimeAsync(0);
      expect(sampleFn).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(sampleFn).toHaveBeenCalledTimes(2);

      monitor.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(sampleFn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a rejected sample is swallowed, not thrown, and does not corrupt the rolling average', async () => {
    let call = 0;
    const monitor = new HostCpuMonitor(async () => {
      call++;
      if (call === 2) throw new Error('probe failed');
      return 0.4;
    });
    await monitor.sampleOnce();
    await expect(monitor.sampleOnce()).resolves.not.toThrow();
    expect(monitor.currentBusyFraction()).toBeCloseTo(0.4, 5);
  });
});
