import { z } from 'zod';

// Shared MCP tool registry (§4.3, §23). Both transport adapters (Streamable
// HTTP inside the Controller and the rbo mcp-stdio proxy) register exactly
// these tools with exactly these input schemas.

export const AGENTS_LIST_INPUT = {
  include_offline: z.boolean().default(false),
};

export const JOB_GET_INPUT = {
  job_id: z.string().min(1),
};

export const JOB_WAIT_INPUT = {
  job_id: z.string().min(1),
  wait_seconds: z.number().int().min(0).max(300).default(30),
  include_log_tail_lines: z.number().int().min(0).max(1000).default(0),
};

export const JOB_LOGS_INPUT = {
  job_id: z.string().min(1),
  // null means "current active attempt, or terminal attempt for a terminal job" (§23.5)
  attempt_id: z.string().nullable().default(null),
  cursor: z.number().int().min(0).default(0),
  max_bytes: z
    .number()
    .int()
    .positive()
    .max(1024 * 1024)
    .default(65536),
  streams: z.array(z.enum(['stdout', 'stderr'])).default(['stdout', 'stderr']),
};

export const JOB_CANCEL_INPUT = {
  job_id: z.string().min(1),
  reason: z.string().optional(),
};

export const JOB_ARTIFACTS_INPUT = {
  job_id: z.string().min(1),
};

export const ARTIFACT_MATERIALIZE_INPUT = {
  artifact_id: z.string().min(1),
  destination_path: z.string().min(1),
  overwrite: z.boolean().default(false),
};

export const AGENT_PROBE_INPUT = {
  agent_id: z.string().min(1),
};

export type McpToolName =
  | 'agents_list'
  | 'job_get'
  | 'job_wait'
  | 'job_logs'
  | 'job_cancel'
  | 'job_artifacts'
  | 'artifact_materialize'
  | 'agent_probe';

export interface McpToolDef {
  name: McpToolName;
  description: string;
  inputShape: z.ZodRawShape;
}

export const MCP_TOOL_DEFS: readonly McpToolDef[] = [
  {
    name: 'agents_list',
    description: 'List registered worker agents and their capabilities.',
    inputShape: AGENTS_LIST_INPUT,
  },
  {
    name: 'job_get',
    description: 'Get current state and metadata of a job.',
    inputShape: JOB_GET_INPUT,
  },
  {
    name: 'job_wait',
    description:
      'Wait up to wait_seconds for a job to reach a terminal state; returns current state otherwise.',
    inputShape: JOB_WAIT_INPUT,
  },
  {
    name: 'job_logs',
    description: 'Read incremental job logs from an attempt-scoped cursor.',
    inputShape: JOB_LOGS_INPUT,
  },
  {
    name: 'job_cancel',
    description: 'Cancel a running or queued job.',
    inputShape: JOB_CANCEL_INPUT,
  },
  {
    name: 'job_artifacts',
    description: 'List collected artifacts of a job, grouped by attempt.',
    inputShape: JOB_ARTIFACTS_INPUT,
  },
  {
    name: 'artifact_materialize',
    description:
      'Copy one stored artifact into an allowed local destination path on the development PC.',
    inputShape: ARTIFACT_MATERIALIZE_INPUT,
  },
  {
    name: 'agent_probe',
    description: 'Trigger a capability re-probe of one agent.',
    inputShape: AGENT_PROBE_INPUT,
  },
];

export function getMcpToolDef(name: string): McpToolDef | undefined {
  return MCP_TOOL_DEFS.find((def) => def.name === name);
}
