import type { AgentCapabilityReport, JobRequest } from '@rbo/protocol';
import { DEFAULT_REFERENCE_CAPACITY_SCORE } from '@rbo/shared';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_HOST_CPU_BUSY_FRACTION,
  type SchedulerAgent,
  computeEffectiveMaxHostCpuBusyFraction,
  decideLocalFallback,
  selectAgentForJob,
} from '../src/scheduler/index.js';

function makeAgent(
  id: string,
  overrides: Partial<AgentCapabilityReport> = {},
  activeJobsCount = 0,
): SchedulerAgent {
  return {
    agentId: id,
    activeJobsCount,
    capabilities: {
      agent_id: id,
      display_name: `agent-${id}`,
      hostname: `host-${id}`,
      os: { family: 'windows', version: '10.0', arch: 'x64' },
      resources: {
        cpu_logical: 8,
        memory_total_mb: 16384,
        memory_free_mb: 8192,
        disk_free_mb: 50000,
      },
      execution: {
        max_jobs: 1,
        shells: ['powershell'],
        supports_tty: true,
        supports_process_tree_kill: true,
      },
      tools: {},
      toolchain_profiles: [],
      labels: {},
      secret_refs: [],
      ...overrides,
    },
  };
}

function baseRequest(overrides: Partial<JobRequest> = {}): JobRequest {
  return {
    client_request_id: 'req_1',
    source: { project_root: 'C:/proj', cwd: '.' },
    execution: { shell: 'powershell', script: 'echo hi' },
    risk_level: 'normal',
    ...overrides,
  } as JobRequest;
}

describe('decideLocalFallback (pure)', () => {
  it('is ineligible when local fallback is disallowed by policy, regardless of load', () => {
    const decision = decideLocalFallback({
      allowLocalFallback: false,
      riskLevel: 'safe',
      host: { cpuBusyFraction: 0, capacityScore: 100, runningJobs: 0 },
      maxHostCpuBusyFraction: DEFAULT_MAX_HOST_CPU_BUSY_FRACTION,
      busyAgentRunningJobs: [],
    });
    expect(decision.eligible).toBe(false);
  });

  it.each(['destructive', 'hardware'] as const)(
    'is ineligible for %s risk regardless of host load (safety rule unchanged)',
    (riskLevel) => {
      const decision = decideLocalFallback({
        allowLocalFallback: true,
        riskLevel,
        host: { cpuBusyFraction: 0, capacityScore: 100, runningJobs: 0 },
        maxHostCpuBusyFraction: DEFAULT_MAX_HOST_CPU_BUSY_FRACTION,
        busyAgentRunningJobs: [],
      });
      expect(decision.eligible).toBe(false);
    },
  );

  it('is eligible with no reason when host is under the CPU threshold', () => {
    const decision = decideLocalFallback({
      allowLocalFallback: true,
      riskLevel: 'safe',
      host: { cpuBusyFraction: 0.2, capacityScore: 100, runningJobs: 0 },
      maxHostCpuBusyFraction: 0.8,
      busyAgentRunningJobs: [],
    });
    expect(decision).toEqual({ eligible: true });
  });

  it('is ineligible (queue instead) when host is over threshold and a busy Agent has fewer running jobs', () => {
    const decision = decideLocalFallback({
      allowLocalFallback: true,
      riskLevel: 'safe',
      host: { cpuBusyFraction: 0.95, capacityScore: 100, runningJobs: 2 },
      maxHostCpuBusyFraction: 0.8,
      busyAgentRunningJobs: [1], // an Agent at capacity, but with fewer running jobs than the host
    });
    expect(decision).toEqual({ eligible: false, reason: 'host_busy' });
  });

  it('is eligible anyway (least-bad option) when host is over threshold but no busy Agent beats it', () => {
    const decision = decideLocalFallback({
      allowLocalFallback: true,
      riskLevel: 'safe',
      host: { cpuBusyFraction: 0.95, capacityScore: 100, runningJobs: 0 },
      maxHostCpuBusyFraction: 0.8,
      busyAgentRunningJobs: [1, 1], // every known Agent already has more running jobs than the host
    });
    expect(decision).toEqual({ eligible: true, reason: 'host_busy' });
  });

  it('is eligible anyway when host is over threshold and there are no other candidates at all', () => {
    // This is the case that used to mean "queued forever" — the host is the only option, so
    // running it anyway beats never running the job.
    const decision = decideLocalFallback({
      allowLocalFallback: true,
      riskLevel: 'safe',
      host: { cpuBusyFraction: 0.99, capacityScore: 100, runningJobs: 0 },
      maxHostCpuBusyFraction: 0.8,
      busyAgentRunningJobs: [],
    });
    expect(decision).toEqual({ eligible: true, reason: 'host_busy' });
  });

  it('ties (host running jobs == least busy agent) resolve in favor of the host', () => {
    const decision = decideLocalFallback({
      allowLocalFallback: true,
      riskLevel: 'safe',
      host: { cpuBusyFraction: 0.95, capacityScore: 100, runningJobs: 1 },
      maxHostCpuBusyFraction: 0.8,
      busyAgentRunningJobs: [1],
    });
    expect(decision).toEqual({ eligible: true, reason: 'host_busy' });
  });

  it('treats the exact threshold value as "busy" (boundary is strict "<", not "<=")', () => {
    // Distinguishes the two branches concretely: if the comparison were "<=", the host would pass
    // straight through with no reason and the less-loaded busy Agent below would never be
    // consulted. Getting `false`/`host_busy` here proves the boundary really is exclusive.
    const decision = decideLocalFallback({
      allowLocalFallback: true,
      riskLevel: 'safe',
      host: {
        cpuBusyFraction: 0.8,
        capacityScore: DEFAULT_REFERENCE_CAPACITY_SCORE,
        runningJobs: 5,
      },
      maxHostCpuBusyFraction: 0.8,
      busyAgentRunningJobs: [1],
    });
    expect(decision).toEqual({ eligible: false, reason: 'host_busy' });
  });

  it('a host stronger than the reference machine gets real headroom past the flat threshold', () => {
    // This is the core, previously-missing requirement: a powerful host can still take a job at a
    // busy fraction that would exclude an average machine, because it has more headroom (capacity
    // score) to spend. Without computeEffectiveMaxHostCpuBusyFraction actually being consulted,
    // this would incorrectly report `eligible: false` at 0.85 with a 0.8 base threshold.
    const decision = decideLocalFallback({
      allowLocalFallback: true,
      riskLevel: 'safe',
      host: {
        cpuBusyFraction: 0.85, // above the 0.8 base threshold...
        capacityScore: DEFAULT_REFERENCE_CAPACITY_SCORE * 1.5, // ...but 50% more powerful than baseline
        runningJobs: 0,
      },
      maxHostCpuBusyFraction: 0.8,
      busyAgentRunningJobs: [],
    });
    expect(decision).toEqual({ eligible: true });
  });

  it('a host at or below reference power gets no boost — same busy fraction is still excluded (no regression)', () => {
    const decision = decideLocalFallback({
      allowLocalFallback: true,
      riskLevel: 'safe',
      host: {
        cpuBusyFraction: 0.85,
        capacityScore: DEFAULT_REFERENCE_CAPACITY_SCORE, // exactly average — no boost
        runningJobs: 2,
      },
      maxHostCpuBusyFraction: 0.8,
      busyAgentRunningJobs: [1], // a less-loaded Agent exists, so the host loses the tie-break too
    });
    expect(decision).toEqual({ eligible: false, reason: 'host_busy' });
  });
});

describe('computeEffectiveMaxHostCpuBusyFraction', () => {
  it('returns the base fraction unchanged at or below reference power (no regression for typical hosts)', () => {
    expect(
      computeEffectiveMaxHostCpuBusyFraction(
        DEFAULT_REFERENCE_CAPACITY_SCORE,
        0.8,
        DEFAULT_REFERENCE_CAPACITY_SCORE,
      ),
    ).toBe(0.8);
    expect(
      computeEffectiveMaxHostCpuBusyFraction(
        DEFAULT_REFERENCE_CAPACITY_SCORE / 2,
        0.8,
        DEFAULT_REFERENCE_CAPACITY_SCORE,
      ),
    ).toBe(0.8);
  });

  it('scales the ceiling up proportionally for a more powerful host', () => {
    const result = computeEffectiveMaxHostCpuBusyFraction(
      DEFAULT_REFERENCE_CAPACITY_SCORE * 1.1,
      0.8,
      DEFAULT_REFERENCE_CAPACITY_SCORE,
    );
    expect(result).toBeCloseTo(0.88, 5);
  });

  it('caps the ceiling so an extremely powerful host is never treated as having no limit at all', () => {
    const result = computeEffectiveMaxHostCpuBusyFraction(
      DEFAULT_REFERENCE_CAPACITY_SCORE * 100,
      0.8,
      DEFAULT_REFERENCE_CAPACITY_SCORE,
    );
    expect(result).toBe(0.97);
  });

  it('falls back to the base fraction if referenceCapacityScore is not positive (avoid divide-by-zero)', () => {
    expect(computeEffectiveMaxHostCpuBusyFraction(50000, 0.8, 0)).toBe(0.8);
  });
});

describe('selectAgentForJob — host CPU load wired into the fallback decision', () => {
  it('still falls back to local when no hostLoad option is supplied (backward compatible)', () => {
    const decision = selectAgentForJob([], baseRequest(), { allowLocalFallback: true });
    expect(decision).toEqual({ action: 'local_fallback' });
  });

  it('falls back to local when the host is under its CPU threshold', () => {
    const decision = selectAgentForJob([], baseRequest(), {
      allowLocalFallback: true,
      hostLoad: { cpuBusyFraction: 0.1, capacityScore: 100, runningJobs: 0 },
      maxHostCpuBusyFraction: 0.8,
    });
    expect(decision).toEqual({ action: 'local_fallback' });
  });

  it('waits instead of running locally when the host is over threshold and a busy Agent is less loaded', () => {
    const busyAgent = makeAgent('agt_busy', {}, 1); // at capacity (max_jobs defaults to 1 in makeAgent)
    const decision = selectAgentForJob([busyAgent], baseRequest(), {
      allowLocalFallback: true,
      hostLoad: { cpuBusyFraction: 0.95, capacityScore: 100, runningJobs: 2 },
      maxHostCpuBusyFraction: 0.8,
    });
    expect(decision).toEqual({ action: 'wait', reason: 'host_busy' });
  });

  it('still runs locally despite being over threshold when it is the only candidate at all', () => {
    const decision = selectAgentForJob([], baseRequest(), {
      allowLocalFallback: true,
      hostLoad: { cpuBusyFraction: 0.95, capacityScore: 100, runningJobs: 0 },
      maxHostCpuBusyFraction: 0.8,
    });
    expect(decision).toEqual({ action: 'local_fallback' });
  });

  it('never lets host load override the destructive/hardware local-fallback safety rule', () => {
    const decision = selectAgentForJob([], baseRequest({ risk_level: 'destructive' }), {
      allowLocalFallback: true,
      hostLoad: { cpuBusyFraction: 0, capacityScore: 100, runningJobs: 0 },
      maxHostCpuBusyFraction: 0.8,
    });
    expect(decision.action).not.toBe('local_fallback');
  });
});
