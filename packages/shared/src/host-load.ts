/**
 * Cross-platform host CPU load sampling and a rough machine capacity score, for
 * host-aware local-fallback scheduling: a job should prefer a machine with more
 * *available* throughput (raw power minus current load), not just the least busy
 * one — a strong machine at moderate load can still out-perform a weak idle one.
 */

import { cpus } from 'node:os';

export interface CpuCoreSnapshot {
  model: string;
  speed: number;
  times: {
    user: number;
    nice: number;
    sys: number;
    idle: number;
    irq: number;
  };
}

/**
 * Busy fraction in [0, 1] from two os.cpus()-shaped snapshots taken apart in time.
 * Works identically on win32/linux/darwin — unlike `os.loadavg()`, which is always
 * `[0, 0, 0]` on Windows (Node doesn't emulate a POSIX load average there).
 */
export function computeCpuBusyFraction(
  before: readonly CpuCoreSnapshot[],
  after: readonly CpuCoreSnapshot[],
): number {
  const coreCount = Math.min(before.length, after.length);
  if (coreCount === 0) {
    return 0;
  }

  let idleDelta = 0;
  let totalDelta = 0;
  for (let i = 0; i < coreCount; i++) {
    const b = before[i]?.times;
    const a = after[i]?.times;
    if (!b || !a) {
      continue;
    }
    const beforeTotal = b.user + b.nice + b.sys + b.idle + b.irq;
    const afterTotal = a.user + a.nice + a.sys + a.idle + a.irq;
    idleDelta += a.idle - b.idle;
    totalDelta += afterTotal - beforeTotal;
  }

  if (totalDelta <= 0) {
    return 0;
  }
  const busy = 1 - idleDelta / totalDelta;
  return Math.min(1, Math.max(0, busy));
}

/**
 * Samples real CPU busy fraction by taking two os.cpus() snapshots `intervalMs` apart.
 * `cpusSource` is injectable so callers/tests never depend on real machine load or timing.
 */
export async function sampleCpuBusyFraction(
  intervalMs = 200,
  cpusSource: () => CpuCoreSnapshot[] = () => cpus(),
): Promise<number> {
  const before = cpusSource();
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
  const after = cpusSource();
  return computeCpuBusyFraction(before, after);
}

/** Reference free-memory amount (MB) above which memory stops discounting capacity score. */
export const DEFAULT_CAPACITY_MEMORY_REFERENCE_MB = 4096;

/**
 * Reference "average machine" capacity score — an 8-core, 3 GHz host (8 * 3000). A host at or
 * below this power gets no special treatment (identical to pre-feature behavior); a host stronger
 * than this baseline earns headroom past the flat CPU-busy threshold, since it processes the same
 * job faster than an average machine would. See computeEffectiveMaxHostCpuBusyFraction in
 * apps/controller/src/scheduler/index.ts, which is where this baseline is actually applied.
 */
export const DEFAULT_REFERENCE_CAPACITY_SCORE = 8 * 3000;

/**
 * Rough "how powerful is this machine" proxy: cores * clock speed, discounted when free
 * memory is scarce (a fast CPU starved for RAM still thrashes). Not a real benchmark —
 * a literal CPU-model lookup table isn't practical/portable — just cheap and monotonic.
 */
export function computeCapacityScore(input: {
  cpuLogical: number;
  cpuSpeedMhz: number;
  memoryFreeMb?: number;
  memoryReferenceMb?: number;
}): number {
  const raw = input.cpuLogical * input.cpuSpeedMhz;
  if (input.memoryFreeMb === undefined) {
    return raw;
  }
  const referenceMb = input.memoryReferenceMb ?? DEFAULT_CAPACITY_MEMORY_REFERENCE_MB;
  if (referenceMb <= 0) {
    return raw;
  }
  const memoryFactor = Math.min(1, input.memoryFreeMb / referenceMb);
  return raw * memoryFactor;
}

const DEFAULT_HISTORY_SIZE = 3;

/**
 * Keeps a short rolling average of real CPU busy-fraction samples, so a single momentary spike
 * doesn't flap a host-aware-fallback decision. Reports a pessimistic `1` (fully busy) before any
 * sample has landed yet — same "unknown is treated as busy" convention as the scheduler's
 * `resolveCpuLoadForScoring` for a missing Agent-reported `cpu_load`.
 */
export class HostCpuMonitor {
  private readonly samples: number[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly sampleFn: () => Promise<number> = () => sampleCpuBusyFraction(),
    private readonly historySize: number = DEFAULT_HISTORY_SIZE,
  ) {}

  /** Takes one sample and folds it into the rolling average. Never throws — a failed probe is
   * silently skipped, leaving the existing average (or the pessimistic default) unchanged. */
  async sampleOnce(): Promise<number> {
    try {
      const value = await this.sampleFn();
      this.samples.push(value);
      if (this.samples.length > this.historySize) {
        this.samples.shift();
      }
    } catch {
      // Swallowed deliberately: a failed probe should not crash the caller or corrupt the average.
    }
    return this.currentBusyFraction();
  }

  currentBusyFraction(): number {
    if (this.samples.length === 0) {
      return 1;
    }
    const sum = this.samples.reduce((a, b) => a + b, 0);
    return sum / this.samples.length;
  }

  /** Samples immediately, then again every `intervalMs`. Idempotent — a second call is a no-op. */
  start(intervalMs: number): void {
    if (this.timer) {
      return;
    }
    void this.sampleOnce();
    this.timer = setInterval(() => {
      void this.sampleOnce();
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
