import type { AgentCapabilityReport } from '@rbo/protocol';
import { generateId } from '@rbo/shared';

export {
  assertGitStateUnchanged,
  captureGitState,
  createGitFixtureRepo,
  type GitFixtureFileSpec,
  type GitFixtureRepo,
  type GitFixtureRepoSpec,
  type GitStateSnapshot,
} from './git-fixtures.js';

export {
  CompatibilityCellSchema,
  CompatibilityMatrixSchema,
  baseSmokeJobRequest,
  longRunningCancelJobRequest,
  renderSmokeEvidence,
  runPhase8SmokeWorkflow,
  textOf,
  type CompatibilityCell,
  type CompatibilityMatrix,
  type Phase8McpClient,
  type Phase8SmokeOptions,
  type Phase8SmokeResult,
  type Phase8SmokeTranscriptEntry,
} from './mcp-smoke.js';

export function createMockAgentCapability(
  overrides?: Partial<AgentCapabilityReport>,
): AgentCapabilityReport {
  return {
    agent_id: generateId('agt'),
    display_name: 'test-agent',
    hostname: 'localhost',
    os: {
      family: 'windows',
      version: '10.0',
      arch: 'x64',
    },
    resources: {
      cpu_logical: 4,
      memory_total_mb: 8192,
      memory_free_mb: 4096,
      disk_free_mb: 50000,
    },
    execution: {
      max_jobs: 1,
      shells: ['powershell', 'cmd'],
      supports_tty: true,
      supports_process_tree_kill: true,
    },
    tools: {},
    toolchain_profiles: [],
    labels: {},
    secret_refs: [],
    ...overrides,
  };
}
