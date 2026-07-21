import type { AgentCapabilityReport, JobRequest } from '@rbo/protocol';
import { describe, expect, it } from 'vitest';
import {
  SCHEDULER_SCORE_BUILD_CACHE_HIT,
  SCHEDULER_SCORE_CONFIGURED_PRIORITY_MULTIPLIER,
  SCHEDULER_SCORE_CPU_LOAD_PENALTY,
  SCHEDULER_SCORE_EXACT_TOOLCHAIN_MATCH,
  SCHEDULER_SCORE_PREFERRED_AGENT_UNIT,
  SCHEDULER_SCORE_PREFERRED_OS_UNIT,
  SCHEDULER_SCORE_REPOSITORY_CACHE_HIT,
  SCHEDULER_SCORE_RUNNING_JOBS_PENALTY,
  type SchedulerAgent,
  computeAgentSchedulerScore,
  computeEstimatedTransferMb,
  computeRecentFailurePenalty,
  matchesVersionSpec,
  resolveCpuLoadForScoring,
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

describe('Scheduler Engine (§19.2)', () => {
  it('selects candidate matching OS, Arch, and capabilities', () => {
    const a1 = makeAgent('agt_win', { os: { family: 'windows', version: '10', arch: 'x64' } });
    const a2 = makeAgent('agt_mac', { os: { family: 'macos', version: '13', arch: 'arm64' } });

    const req = makeRequest({ requirements: { os: ['macos'] } });
    const decision = selectAgentForJob([a1, a2], req);

    expect(decision.action).toBe('remote');
    expect(decision.selectedAgent?.agentId).toBe('agt_mac');
  });

  it('filters out agents with active jobs exceeding capacity (capacity=1 in Phase 4)', () => {
    const busy = makeAgent('agt_busy', {}, 1);
    const idle = makeAgent('agt_idle', {}, 0);

    const req = makeRequest();
    const decision = selectAgentForJob([busy, idle], req);

    expect(decision.action).toBe('remote');
    expect(decision.selectedAgent?.agentId).toBe('agt_idle');
  });

  it('filters candidates missing required secret refs', () => {
    const a1 = makeAgent('agt_nosecret', { secret_refs: [] });
    const a2 = makeAgent('agt_hassecret', { secret_refs: ['AWS_KEY'] });

    const req = makeRequest({ requirements: { secret_refs: ['AWS_KEY'] } });
    const decision = selectAgentForJob([a1, a2], req);

    expect(decision.action).toBe('remote');
    expect(decision.selectedAgent?.agentId).toBe('agt_hassecret');
  });

  it('matches execution.secret_refs by store ref values, not env keys', () => {
    const a1 = makeAgent('agt_wrong', { secret_refs: ['GITHUB_TOKEN'] });
    const a2 = makeAgent('agt_right', { secret_refs: ['github-readonly'] });

    const req = makeRequest({
      execution: {
        script: 'echo test',
        secret_refs: { GITHUB_TOKEN: 'github-readonly' },
      },
    });
    const decision = selectAgentForJob([a1, a2], req);

    expect(decision.action).toBe('remote');
    expect(decision.selectedAgent?.agentId).toBe('agt_right');
  });

  it('matches required toolchain profiles and resolves profile ID', () => {
    const profile = {
      id: 'rust-1.93',
      kind: 'cargo',
      version: '1.93.0',
      platform: 'windows-x64',
      activation: { type: 'path_prepend' as const },
      environment_fingerprint: 'fingerprint_rust',
    };
    const a1 = makeAgent('agt_rust', { toolchain_profiles: [profile] });

    const req = makeRequest({ requirements: { tools: { cargo: '1.93' } } });
    const decision = selectAgentForJob([a1], req);

    expect(decision.action).toBe('remote');
    expect(decision.selectedAgent?.agentId).toBe('agt_rust');
    expect(decision.selectedToolchains?.[0]?.id).toBe('rust-1.93');
  });

  it('rejects substring version matches that are not exact or prefix-bounded', () => {
    const profile = {
      id: 'rust-1.93',
      kind: 'cargo',
      version: '1.93.0',
      platform: 'windows-x64',
      activation: { type: 'path_prepend' as const },
      environment_fingerprint: 'fingerprint_rust',
    };
    const a1 = makeAgent('agt_rust', { toolchain_profiles: [profile] });

    // "1.9" must not match "1.93.0" (old substring bug)
    const bad = selectAgentForJob([a1], makeRequest({ requirements: { tools: { cargo: '1.9' } } }));
    expect(bad.action).not.toBe('remote');

    // "1.93" matches "1.93.0" via dot-bounded prefix
    const good = selectAgentForJob(
      [a1],
      makeRequest({ requirements: { tools: { cargo: '1.93' } } }),
    );
    expect(good.action).toBe('remote');
  });

  it('handles version strings with leading/trailing whitespace properly in matchesVersionSpec', () => {
    expect(matchesVersionSpec(' 22.14.0 ', '>=22.14.0')).toBe(true);
    expect(matchesVersionSpec('22.14.0\n', '22.14.0')).toBe(true);
  });

  it('selects a profile per requested tool and persists all of them', () => {
    const cargo = {
      id: 'rust-1.93',
      kind: 'cargo',
      version: '1.93.0',
      platform: 'windows-x64',
      activation: { type: 'path_prepend' as const },
      environment_fingerprint: 'fp_cargo',
    };
    const node = {
      id: 'node-22',
      kind: 'node',
      version: '22.14.0',
      platform: 'windows-x64',
      activation: { type: 'path_prepend' as const },
      environment_fingerprint: 'fp_node',
    };
    const a1 = makeAgent('agt_multi', { toolchain_profiles: [cargo, node] });

    const decision = selectAgentForJob(
      [a1],
      makeRequest({ requirements: { tools: { cargo: '>=1.93.0', node: '22.14.0' } } }),
    );

    expect(decision.action).toBe('remote');
    expect(decision.selectedToolchains?.map((p) => p.id).sort()).toEqual(['node-22', 'rust-1.93']);
  });

  it('applies deterministic agent_id tie-breaker when scores are equal', () => {
    const a2 = makeAgent('agt_b');
    const a1 = makeAgent('agt_a');

    const req = makeRequest();
    const decision = selectAgentForJob([a2, a1], req);

    expect(decision.action).toBe('remote');
    expect(decision.selectedAgent?.agentId).toBe('agt_a');
  });

  it('handles queue_policy fallback table correctly', () => {
    const reqWait = makeRequest({ queue_policy: 'wait', requirements: { os: ['linux'] } });
    expect(selectAgentForJob([], reqWait).action).toBe('wait');

    const reqFail = makeRequest({ queue_policy: 'fail_fast', requirements: { os: ['linux'] } });
    expect(selectAgentForJob([], reqFail).action).toBe('fail_fast');

    const reqFallback = makeRequest({
      queue_policy: 'local_fallback',
      requirements: { os: ['linux'] },
    });
    expect(selectAgentForJob([], reqFallback, { allowLocalFallback: true }).action).toBe(
      'local_fallback',
    );
    expect(selectAgentForJob([], reqFallback, { allowLocalFallback: false }).action).toBe(
      'fail_fast',
    );
  });

  it('supports mocked macOS capability selection as scheduler unit coverage', () => {
    const macAgent = makeAgent('agt_macos_mock', {
      os: { family: 'macos', version: '14.0', arch: 'arm64' },
      toolchain_profiles: [
        {
          id: 'xcode-15',
          kind: 'xcode',
          version: '15.2',
          platform: 'macos-arm64',
          activation: { type: 'path_prepend' as const },
          environment_fingerprint: 'fp_xcode',
        },
      ],
    });

    const req = makeRequest({ requirements: { os: ['macos'], tools: { xcode: '15.2' } } });
    const decision = selectAgentForJob([macAgent], req);

    expect(decision.action).toBe('remote');
    expect(decision.selectedAgent?.agentId).toBe('agt_macos_mock');
    expect(decision.selectedToolchains?.[0]?.id).toBe('xcode-15');
  });

  it('blocks destructive/hardware from local_fallback', () => {
    const reqDestructive = makeRequest({
      queue_policy: 'local_fallback',
      risk_level: 'destructive',
      requirements: { os: ['linux'] },
    });
    expect(selectAgentForJob([], reqDestructive, { allowLocalFallback: true }).action).toBe(
      'fail_fast',
    );

    const reqHardware = makeRequest({
      queue_policy: 'local_fallback',
      risk_level: 'hardware',
      requirements: { os: ['linux'] },
    });
    expect(selectAgentForJob([], reqHardware, { allowLocalFallback: true }).action).toBe(
      'fail_fast',
    );
  });

  it('applies repository_cache_hit bonus (+500) when prefer_repo_cache and agent has repo', () => {
    const cold = makeAgent('agt_cold', {
      repository_cache: [],
      resources: {
        cpu_logical: 8,
        memory_total_mb: 16384,
        memory_free_mb: 9000,
        disk_free_mb: 50000,
      },
    });
    const warm = makeAgent('agt_warm', {
      repository_cache: [
        {
          canonical_id: 'github.com/kuzyasun/esp32-boilerplate',
          commits: ['abc123'],
        },
      ],
      resources: {
        cpu_logical: 8,
        memory_total_mb: 16384,
        memory_free_mb: 1000,
        disk_free_mb: 50000,
      },
    });

    const req = makeRequest({ preferences: { prefer_repo_cache: true } });
    const decision = selectAgentForJob([cold, warm], req, {
      repoCanonicalId: 'github.com/kuzyasun/esp32-boilerplate',
      baseCommit: 'abc123',
    });

    expect(decision.action).toBe('remote');
    expect(decision.selectedAgent?.agentId).toBe('agt_warm');
  });

  it('does not let repo cache affinity bypass hard filters', () => {
    const warmWrongOs = makeAgent('agt_warm_linux', {
      os: { family: 'linux', version: '6', arch: 'x64' },
      repository_cache: [{ canonical_id: 'github.com/kuzyasun/esp32-boilerplate' }],
    });
    const coldWin = makeAgent('agt_cold_win', {
      os: { family: 'windows', version: '10', arch: 'x64' },
      repository_cache: [],
    });

    const req = makeRequest({
      requirements: { os: ['windows'] },
      preferences: { prefer_repo_cache: true },
    });
    const decision = selectAgentForJob([warmWrongOs, coldWin], req, {
      repoCanonicalId: 'github.com/kuzyasun/esp32-boilerplate',
      baseCommit: 'abc123',
    });

    expect(decision.selectedAgent?.agentId).toBe('agt_cold_win');
  });
});

describe('Scheduler §19.2 score terms', () => {
  const baseRequest = makeRequest();

  function scoreFor(
    agent: SchedulerAgent,
    request: JobRequest = baseRequest,
    options: Parameters<typeof selectAgentForJob>[2] = {},
    toolchains: Parameters<typeof computeAgentSchedulerScore>[0]['selectedToolchains'] = [],
    toolsRequested = false,
  ): number {
    return computeAgentSchedulerScore({
      agentId: agent.agentId,
      caps: agent.capabilities,
      runningJobs: agent.activeJobsCount,
      recentFailurePenalty: agent.recentFailurePenalty ?? 0,
      request,
      options,
      selectedToolchains: toolchains,
      toolsRequested,
      toolsMatched: true,
    });
  }

  it('prefers higher configured_priority', () => {
    const low = makeAgent('agt_low', { configured_priority: 10 });
    const high = makeAgent('agt_high', { configured_priority: 30 });
    const decision = selectAgentForJob([low, high], baseRequest);
    expect(decision.selectedAgent?.agentId).toBe('agt_high');
    expect(scoreFor(high) - scoreFor(low)).toBe(
      20 * SCHEDULER_SCORE_CONFIGURED_PRIORITY_MULTIPLIER,
    );
  });

  it('applies preferred_agent_bonus from agent_ids order', () => {
    const first = makeAgent('agt_first');
    const second = makeAgent('agt_second');
    const req = makeRequest({ preferences: { agent_ids: ['agt_first', 'agt_second'] } });
    const decision = selectAgentForJob([second, first], req);
    expect(decision.selectedAgent?.agentId).toBe('agt_first');
    expect(scoreFor(first, req) - scoreFor(second, req)).toBe(SCHEDULER_SCORE_PREFERRED_AGENT_UNIT);
  });

  it('applies preferred_os_bonus from os_order', () => {
    const win = makeAgent('agt_win', {
      configured_priority: 10,
      os: { family: 'windows', version: '10', arch: 'x64' },
    });
    const mac = makeAgent('agt_mac', {
      configured_priority: 10,
      os: { family: 'macos', version: '14', arch: 'arm64' },
    });
    const req = makeRequest({ preferences: { os_order: ['macos', 'windows'] } });
    const decision = selectAgentForJob([win, mac], req);
    expect(decision.selectedAgent?.agentId).toBe('agt_mac');
    expect(scoreFor(mac, req) - scoreFor(win, req)).toBe(SCHEDULER_SCORE_PREFERRED_OS_UNIT);
  });

  it('adds exact_toolchain_match when tools are requested and matched', () => {
    const agent = makeAgent('agt_tools');
    const withoutTools = scoreFor(agent, baseRequest, {}, [], false);
    const withTools = scoreFor(agent, baseRequest, {}, [], true);
    expect(withTools - withoutTools).toBe(SCHEDULER_SCORE_EXACT_TOOLCHAIN_MATCH);
  });

  it('penalizes running_jobs', () => {
    const idle = makeAgent('agt_idle', {}, 0);
    const busy = makeAgent('agt_busy', {}, 1);
    const decision = selectAgentForJob([busy, idle], baseRequest);
    expect(decision.selectedAgent?.agentId).toBe('agt_idle');
    expect(scoreFor(idle) - scoreFor(busy)).toBe(SCHEDULER_SCORE_RUNNING_JOBS_PENALTY);
  });

  it('penalizes higher cpu_load', () => {
    const idleCpu = makeAgent('agt_idle_cpu', {
      resources: {
        cpu_logical: 8,
        memory_total_mb: 8192,
        memory_free_mb: 8192,
        disk_free_mb: 50000,
        cpu_load: 0,
      },
    });
    const busyCpu = makeAgent('agt_busy_cpu', {
      resources: {
        cpu_logical: 8,
        memory_total_mb: 8192,
        memory_free_mb: 8192,
        disk_free_mb: 50000,
        cpu_load: 1,
      },
    });
    const decision = selectAgentForJob([busyCpu, idleCpu], baseRequest);
    expect(decision.selectedAgent?.agentId).toBe('agt_idle_cpu');
    expect(scoreFor(idleCpu) - scoreFor(busyCpu)).toBe(SCHEDULER_SCORE_CPU_LOAD_PENALTY);
  });

  it('treats missing cpu_load as 1 for scoring', () => {
    const caps = makeAgent('agt_x').capabilities;
    expect(resolveCpuLoadForScoring(caps)).toBe(1);
  });

  it('subtracts estimated_transfer_mb from score', () => {
    const agent = makeAgent('agt_xfer');
    const noXfer = scoreFor(agent, baseRequest, { estimatedTransferBytes: 0 });
    const withXfer = scoreFor(agent, baseRequest, { estimatedTransferBytes: 3 * 1024 * 1024 });
    expect(noXfer - withXfer).toBe(computeEstimatedTransferMb(3 * 1024 * 1024));
  });

  it('penalizes recent_failure_penalty per agent', () => {
    const clean = makeAgent('agt_clean', {}, 0);
    const flaky = makeAgent('agt_flaky', {}, 0);
    flaky.recentFailurePenalty = computeRecentFailurePenalty(2);
    const penalties = new Map([[flaky.agentId, flaky.recentFailurePenalty]]);
    const decision = selectAgentForJob([flaky, clean], baseRequest, {
      recentFailurePenalties: penalties,
    });
    expect(decision.selectedAgent?.agentId).toBe('agt_clean');
    expect(
      scoreFor(clean, baseRequest, { recentFailurePenalties: penalties }) -
        scoreFor(flaky, baseRequest, { recentFailurePenalties: penalties }),
    ).toBe(100);
  });

  it('caps recent_failure_penalty at 500', () => {
    expect(computeRecentFailurePenalty(20)).toBe(500);
  });

  it('applies repository_cache_hit bonus of 500', () => {
    const cold = makeAgent('agt_cold_repo', { repository_cache: [] });
    const warm = makeAgent('agt_warm_repo', {
      repository_cache: [{ canonical_id: 'github.com/org/repo', commits: ['abc'] }],
    });
    const req = makeRequest({ preferences: { prefer_repo_cache: true } });
    const options = {
      repoCanonicalId: 'github.com/org/repo',
      baseCommit: 'abc',
    };
    expect(scoreFor(warm, req, options) - scoreFor(cold, req, options)).toBe(
      SCHEDULER_SCORE_REPOSITORY_CACHE_HIT,
    );
  });
});
