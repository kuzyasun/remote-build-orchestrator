import { z } from 'zod';
import { JobRequestSchema, ShellIdSchema } from './schemas.js';

// Shared MCP tool registry (§4.3, §23). Both transport adapters (Streamable
// HTTP inside the Controller and the rbo mcp-stdio proxy) register exactly
// these tools with exactly these input schemas.

export const JOB_SUBMIT_INPUT = JobRequestSchema.shape;

export const JOB_CONFIRM_INPUT = {
  job_id: z.string().min(1),
  confirmation_token: z.string().min(1),
};

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
  attempt_id: z.string().nullable().default(null),
  cursor: z.string().max(512).nullable().default(null),
  mode: z.enum(['logs', 'events']),
  max_bytes: z
    .number()
    .int()
    .min(4)
    .max(1024 * 1024)
    .default(65536),
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

/**
 * Interactive AI primary path: submit + wait + summary.
 * Prefer short MCP wait slices + resume (see 2026-07-22 job_run resume design).
 * Resume: pass `job_id` alone (command/project_root optional). Fresh run: both required.
 */
export const JOB_RUN_INPUT = {
  command: z.string().min(1).optional(),
  project_root: z.string().min(1).optional(),
  job_id: z.string().min(1).optional(),
  shell: ShellIdSchema.optional(),
  target_os: z.array(z.enum(['macos', 'windows', 'linux'])).min(1).optional(),
  cwd: z.string().default('.'),
  timeout_seconds: z.number().positive().max(3600).default(3600),
  wait_seconds: z.number().int().min(0).max(3600).optional(),
  /** Max seconds this MCP response blocks; default keeps typical 60s clients safe. */
  mcp_wait_slice_seconds: z.number().int().min(1).max(55).default(50),
  artifacts: JobRequestSchema.shape.artifacts,
  risk_level: JobRequestSchema.shape.risk_level,
  client_request_id: z.string().min(1).optional(),
  name: z.string().optional(),
  log_cursor: z.string().max(512).nullable().default(null),
  max_output_bytes: z
    .number()
    .int()
    .min(4)
    .max(1024 * 1024)
    .default(16384),
};

export type McpToolName =
  | 'agents_list'
  | 'job_submit'
  | 'job_run'
  | 'job_confirm'
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
    name: 'job_submit',
    description: 'Submit a build/test job and capture an immutable workspace snapshot.',
    inputShape: JOB_SUBMIT_INPUT,
  },
  {
    name: 'job_run',
    description:
      'Run a command remotely (snapshot + execute). Waits up to mcp_wait_slice_seconds (default 50). If still running, returns resume:true — call again with the same job_id. Preferred for interactive AI clients.',
    inputShape: JOB_RUN_INPUT,
  },
  {
    name: 'job_confirm',
    description: 'Confirm a destructive or hardware-risk job after snapshot capture.',
    inputShape: JOB_CONFIRM_INPUT,
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
