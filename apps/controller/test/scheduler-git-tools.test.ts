import type { AgentCapabilityReport } from '@rbo/protocol';
import { describe, expect, it } from 'vitest';
import { matchJobToolRequirements } from '../src/scheduler/index.js';

function baseCaps(overrides: Partial<AgentCapabilityReport> = {}): AgentCapabilityReport {
  return {
    agent_id: 'agt_1',
    display_name: 'agent',
    hostname: 'host',
    os: { family: 'linux', version: '6.0', arch: 'x64' },
    resources: {
      cpu_logical: 4,
      memory_total_mb: 8192,
      memory_free_mb: 4096,
      disk_free_mb: 10000,
    },
    execution: {
      max_jobs: 1,
      shells: ['bash'],
      supports_tty: true,
      supports_process_tree_kill: false,
    },
    tools: {},
    toolchain_profiles: [],
    labels: {},
    secret_refs: [],
    ...overrides,
  };
}

describe('matchJobToolRequirements probe tools (§11.15)', () => {
  it('requires git-lfs in agent.tools when requested', () => {
    const without = matchJobToolRequirements({ 'git-lfs': '>=0' }, baseCaps());
    expect(without.matches).toBe(false);

    const withLfs = matchJobToolRequirements(
      { 'git-lfs': '>=3.0' },
      baseCaps({ tools: { 'git-lfs': ['3.5.1'] } }),
    );
    expect(withLfs.matches).toBe(true);
  });

  it('requires git in agent.tools when submodules are requested', () => {
    const without = matchJobToolRequirements({ git: '>=2.0' }, baseCaps());
    expect(without.matches).toBe(false);

    const withGit = matchJobToolRequirements(
      { git: '>=2.0' },
      baseCaps({ tools: { git: ['2.45.0'] } }),
    );
    expect(withGit.matches).toBe(true);
  });
});
