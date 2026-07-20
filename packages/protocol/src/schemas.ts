import { ErrorCategorySchema } from '@rbo/shared';
import { z } from 'zod';

// Re-export from shared — single source of truth (§35.1 rule 3)
export { ErrorCategorySchema };

export const StructuredErrorSchema = z.object({
  category: ErrorCategorySchema,
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});

// --- Job lifecycle (§18.1) ---

/** Job states — exact match to §18.1 state machine */
export const JobStateSchema = z.enum([
  'created',
  'awaiting_confirmation',
  'queued',
  'matching',
  'leased',
  'preparing_source',
  'transferring_source',
  'materializing',
  'starting',
  'running',
  'orphaned',
  'collecting_artifacts',
  'cleaning',
  'completed',
]);

/** Job outcome — immutable execution result (§18.1) */
export const JobOutcomeSchema = z.enum(['succeeded', 'failed', 'timed_out', 'cancelled', 'lost']);

// --- Risk / queue policy ---

export const RiskLevelSchema = z.enum(['safe', 'normal', 'destructive', 'hardware']);
export const QueuePolicySchema = z.enum(['local_fallback', 'wait', 'fail_fast']);

// --- Execution (§13.1) ---

export const CompletionPolicySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('run_to_exit') }),
  z.object({ type: z.literal('run_for_duration'), duration_seconds: z.number().positive() }),
  z.object({
    type: z.literal('run_until_log_match'),
    success_pattern: z.string().min(1),
    failure_pattern: z.string().min(1).optional(),
    max_duration_seconds: z.number().positive(),
  }),
]);

export const ShellIdSchema = z.enum(['bash', 'zsh', 'sh', 'powershell', 'pwsh', 'cmd', 'direct']);

export const ExecutionConfigSchema = z.object({
  shell: ShellIdSchema.default('bash'),
  script: z.string().min(1),
  env: z.record(z.string(), z.string()).default({}),
  // §13.4: values come from the Agent-side named secret store, never through MCP.
  secret_refs: z.record(z.string(), z.string()).optional(),
  timeout_seconds: z.number().positive().default(3600),
  idle_timeout_seconds: z.number().positive().optional(),
  cancel_grace_seconds: z.number().positive().default(10),
  tty: z.boolean().default(false),
  completion: CompletionPolicySchema.default({ type: 'run_to_exit' }),
});

// --- Source (§13.1, §11.13) ---

export const JobAdditionalRootSchema = z.object({
  source_path: z.string().min(1),
  mount_path: z.string().min(1),
  include: z.array(z.string()).default(['**/*']),
  exclude: z.array(z.string()).default([]),
  mode: z.enum(['read_only', 'read_write']).default('read_only'),
});

export const SourceConfigSchema = z.object({
  project_root: z.string().min(1),
  cwd: z.string().default('.'),
  additional_roots: z.array(JobAdditionalRootSchema).default([]),
});

export const SourcePolicySchema = z.object({
  include_untracked: z.boolean().default(true),
  include_ignored: z.array(z.string()).default([]),
  secret_policy: z.enum(['block', 'warn', 'allow']).default('block'),
});

// --- Requirements & preferences (§9.5, §9.6) ---

export const RequirementsConfigSchema = z.object({
  os: z.array(z.string()).optional(),
  arch: z.array(z.string()).optional(),
  tools: z.record(z.string(), z.string()).optional(),
  labels: z.record(z.string(), z.string()).optional(),
  secret_refs: z.array(z.string()).optional(),
  min_memory_mb: z.number().positive().optional(),
  min_disk_mb: z.number().positive().optional(),
});

export const PreferencesConfigSchema = z.object({
  agent_ids: z.array(z.string()).optional(),
  os_order: z.array(z.string()).optional(),
  prefer_repo_cache: z.boolean().default(true),
  allow_local_fallback: z.boolean().default(true),
});

// --- Artifacts ---

export const ArtifactRuleSchema = z.object({
  glob: z.string().min(1),
  required: z.boolean().default(false),
});

// --- Canonical JobRequest (§13.1) ---

export const JobRequestSchema = z.object({
  client_request_id: z.string().min(1),
  name: z.string().optional(),
  source: SourceConfigSchema,
  execution: ExecutionConfigSchema,
  requirements: RequirementsConfigSchema.optional(),
  preferences: PreferencesConfigSchema.optional(),
  queue_policy: QueuePolicySchema.default('local_fallback'),
  risk_level: RiskLevelSchema.default('normal'),
  intent: z.string().nullable().optional(),
  source_policy: SourcePolicySchema.optional(),
  artifacts: z.array(ArtifactRuleSchema).optional(),
});

export type JobRequest = z.infer<typeof JobRequestSchema>;

// --- Agent capabilities (§9.1) ---

export const ToolchainProfileSchema = z.object({
  id: z.string(),
  kind: z.string(),
  version: z.string(),
  platform: z.string(),
  activation: z.object({
    type: z.enum(['source_script', 'environment_variables', 'path_prepend']),
    path: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
  }),
  environment_fingerprint: z.string(),
});

export const AgentCapabilityReportSchema = z.object({
  agent_id: z.string(),
  display_name: z.string(),
  hostname: z.string(),
  os: z.object({
    family: z.enum(['macos', 'windows', 'linux']),
    version: z.string(),
    arch: z.string(),
  }),
  resources: z.object({
    cpu_logical: z.number(),
    memory_total_mb: z.number(),
    memory_free_mb: z.number(),
    disk_free_mb: z.number(),
  }),
  execution: z.object({
    max_jobs: z.number(),
    shells: z.array(z.string()),
    supports_tty: z.boolean(),
    supports_process_tree_kill: z.boolean(),
  }),
  tools: z.record(z.string(), z.array(z.string())),
  toolchain_profiles: z.array(ToolchainProfileSchema),
  labels: z.record(z.string(), z.string()),
  secret_refs: z.array(z.string()),
});

export type AgentCapabilityReport = z.infer<typeof AgentCapabilityReportSchema>;
