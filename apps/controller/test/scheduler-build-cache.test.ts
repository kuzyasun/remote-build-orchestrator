import type { AgentCapabilityReport, JobRequest } from '@rbo/protocol';
import { describe, expect, it } from 'vitest';
import {
  SCHEDULER_SCORE_BUILD_CACHE_HIT,
  SCHEDULER_SCORE_REPOSITORY_CACHE_HIT,
  type SchedulerAgent,
  agentHasBuildCacheHit,
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
        shells: ['powershell', 'cmd', 'bash'],
        supports_tty: false,
        supports_process_tree_kill: true,
      },
      tools: {},
      toolchain_profiles: [],
      labels: {},
      secret_refs: ['MY_SECRET'],
      ...overrides,
    },
  };
}

function makeRequest(overrides: Partial<JobRequest> = {}): JobRequest {
  return {
    client_request_id: 'req_1',
    source: { project_root: 'C:/project', cwd: '.' },
    execution: { script: 'echo test' },
    queue_policy: 'local_fallback',
    risk_level: 'normal',
    ...overrides,
  };
}

const WARM_KEY = 'npm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('Scheduler build_cache_hit preference (+250)', () => {
  it('applies build_cache_hit bonus (+250) after hard filters when agent advertises matching key', () => {
    const cold = makeAgent('agt_cold_bc', {
      build_caches: [],
      resources: {
        cpu_logical: 8,
        memory_total_mb: 16384,
        memory_free_mb: 9000,
        disk_free_mb: 50000,
      },
    });
    const warm = makeAgent('agt_warm_bc', {
      build_caches: [{ kind: 'npm', keys: [WARM_KEY] }],
      resources: {
        cpu_logical: 8,
        memory_total_mb: 16384,
        memory_free_mb: 1000,
        disk_free_mb: 50000,
      },
    });

    const req = makeRequest({ preferences: { prefer_build_cache: true } });
    const decision = selectAgentForJob([cold, warm], req, {
      buildCacheKeys: [{ kind: 'npm', key: WARM_KEY }],
    });

    expect(decision.action).toBe('remote');
    expect(decision.selectedAgent?.agentId).toBe('agt_warm_bc');
  });

  it('does not apply bonus when prefer_build_cache is false', () => {
    const cold = makeAgent('agt_cold_pref', {
      build_caches: [],
      resources: {
        cpu_logical: 8,
        memory_total_mb: 16384,
        memory_free_mb: 9000,
        disk_free_mb: 50000,
      },
    });
    const warm = makeAgent('agt_warm_pref', {
      build_caches: [{ kind: 'npm', keys: [WARM_KEY] }],
      resources: {
        cpu_logical: 8,
        memory_total_mb: 16384,
        memory_free_mb: 1000,
        disk_free_mb: 50000,
      },
    });

    const req = makeRequest({ preferences: { prefer_build_cache: false } });
    const decision = selectAgentForJob([cold, warm], req, {
      buildCacheKeys: [{ kind: 'npm', key: WARM_KEY }],
    });

    expect(decision.selectedAgent?.agentId).toBe('agt_cold_pref');
  });

  it('does not let build cache affinity bypass hard filters', () => {
    const warmWrongOs = makeAgent('agt_warm_linux_bc', {
      os: { family: 'linux', version: '6', arch: 'x64' },
      build_caches: [{ kind: 'npm', keys: [WARM_KEY] }],
    });
    const coldWin = makeAgent('agt_cold_win_bc', {
      os: { family: 'windows', version: '10', arch: 'x64' },
      build_caches: [],
    });

    const req = makeRequest({
      requirements: { os: ['windows'] },
      preferences: { prefer_build_cache: true },
    });
    const decision = selectAgentForJob([warmWrongOs, coldWin], req, {
      buildCacheKeys: [{ kind: 'npm', key: WARM_KEY }],
    });

    expect(decision.selectedAgent?.agentId).toBe('agt_cold_win_bc');
  });

  it('agentHasBuildCacheHit requires kind + key equality for at least one entry', () => {
    const caps = makeAgent('agt_x', {
      build_caches: [{ kind: 'npm', keys: [WARM_KEY] }],
    }).capabilities;

    expect(agentHasBuildCacheHit(caps, [{ kind: 'npm', key: WARM_KEY }])).toBe(true);
    expect(agentHasBuildCacheHit(caps, [{ kind: 'pnpm', key: WARM_KEY }])).toBe(false);
    expect(
      agentHasBuildCacheHit(caps, [{ kind: 'npm', key: 'npm_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }]),
    ).toBe(false);
  });

  it('documents build_cache_hit (+250) next to repository_cache_hit (+500)', () => {
    expect(SCHEDULER_SCORE_BUILD_CACHE_HIT).toBe(250);
    expect(SCHEDULER_SCORE_REPOSITORY_CACHE_HIT).toBe(500);
  });
});
