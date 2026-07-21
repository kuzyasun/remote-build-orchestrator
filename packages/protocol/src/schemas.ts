import { ErrorCategorySchema, isSafeRelativePath } from '@rbo/shared';
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
export type RiskLevel = z.infer<typeof RiskLevelSchema>;
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
  cleanup_script: z.string().optional(),
  cleanup_timeout_seconds: z.number().positive().default(60),
  tty: z.boolean().default(false),
  completion: CompletionPolicySchema.default({ type: 'run_to_exit' }),
});

// --- Source (§13.1, §11.13) ---

export const JobAdditionalRootSchema = z.object({
  source_path: z.string().min(1),
  mount_path: z
    .string()
    .min(1)
    .refine((value) => isSafeRelativePath(value), {
      message: "mount_path must be a relative path without '..', absolute, or UNC segments",
    }),
  include: z.array(z.string()).default(['**/*']),
  exclude: z.array(z.string()).default([]),
  mode: z.enum(['read_only', 'read_write']).default('read_only'),
});

export const SourceConfigSchema = z.object({
  project_root: z.string().min(1),
  // Relative path only — no absolute paths or `..` segments (§28.2 isolation).
  cwd: z
    .string()
    .default('.')
    .refine((value) => isSafeRelativePath(value, { allowDot: true }), {
      message: "cwd must be a relative path without '..' or absolute segments",
    }),
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
  prefer_build_cache: z.boolean().default(true),
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
export type ExecutionConfig = z.infer<typeof ExecutionConfigSchema>;
export type ArtifactRule = z.infer<typeof ArtifactRuleSchema>;

// --- Job events (§18.1, §21.3) — wire contract for events.jsonl and job_logs ---

const jobEventBase = {
  sequence: z.number().int().positive(),
  created_at: z.string().min(1),
  job_id: z.string().min(1),
  attempt_id: z.string().min(1),
};

export const JobEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('state_transition'),
    ...jobEventBase,
    from_state: JobStateSchema,
    to_state: JobStateSchema,
  }),
  z.object({
    type: z.literal('snapshot_captured'),
    ...jobEventBase,
    snapshot_id: z.string().min(1),
    content_id: z.string().min(1),
  }),
  z.object({
    type: z.literal('materialized'),
    ...jobEventBase,
    workspace: z.string().min(1),
  }),
  z.object({
    type: z.literal('process_started'),
    ...jobEventBase,
    workspace: z.string().min(1),
    pid: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal('artifact_collected'),
    ...jobEventBase,
    artifact_id: z.string().min(1),
    path: z.string().min(1),
    sha256: z.string().min(1),
  }),
  z.object({
    type: z.literal('artifact_skipped'),
    ...jobEventBase,
    path: z.string().min(1),
    reason: z.string().min(1),
  }),
  z.object({
    type: z.literal('artifact_limit_exceeded'),
    ...jobEventBase,
    reason: z.enum(['file_count', 'total_bytes']),
    limit: z.number().int().positive(),
    actual: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('secret_warning'),
    ...jobEventBase,
    path: z.string().min(1),
    reason: z.string().min(1),
  }),
  z.object({
    type: z.literal('env_override_ignored'),
    ...jobEventBase,
    name: z.string().min(1),
    reason: z.string().min(1),
  }),
  z.object({
    type: z.literal('cancel_requested'),
    ...jobEventBase,
    reason: z.string().optional(),
    signalled: z.boolean(),
  }),
  z.object({
    type: z.literal('cleanup_error'),
    ...jobEventBase,
    exit_code: z.number().int().nullable(),
    timed_out: z.boolean(),
    message: z.string().min(1),
  }),
  z.object({
    type: z.literal('error'),
    ...jobEventBase,
    category: ErrorCategorySchema,
    message: z.string().min(1),
  }),
]);

export type JobEvent = z.infer<typeof JobEventSchema>;

export function parseJobEventLine(line: string): JobEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = JobEventSchema.safeParse(JSON.parse(trimmed));
  return parsed.success ? parsed.data : null;
}

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

/** Fixed named build-cache kinds — never arbitrary host paths from JobRequest. */
export const BuildCacheKindSchema = z.enum(['ccache', 'sccache', 'npm', 'pnpm', 'pip']);
export type BuildCacheKind = z.infer<typeof BuildCacheKindSchema>;

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
    /**
     * Agent-reported CPU busy fraction in [0, 1] for §19.2 scheduler scoring.
     * Missing at schedule time is treated as 1 (pessimistic) by the Controller.
     */
    cpu_load: z.number().min(0).max(1).optional(),
    /** Additive Phase 6 capacity fields (bytes). */
    disk_free_bytes: z.number().nonnegative().optional(),
    disk_min_free_bytes: z.number().nonnegative().optional(),
    disk_pressure: z.boolean().optional(),
    /**
     * Primary-core clock speed (MHz) from os.cpus()[0].speed, for host-aware scheduling's
     * capacity score (cpu_logical * cpu_speed_mhz). Optional — missing is treated as an
     * unknown/lowest-priority capacity by the Controller, same spirit as cpu_load's pessimistic
     * default above.
     */
    cpu_speed_mhz: z.number().nonnegative().optional(),
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
  /**
   * Optional Phase 5 repository-cache advertisement for scheduler affinity (§19.2).
   * Agents may report canonical ids (and optionally known commits) present in mirrors.
   */
  repository_cache: z
    .array(
      z.object({
        canonical_id: z.string().min(1),
        /** Optional known commits present in the mirror (best-effort). */
        commits: z.array(z.string().min(1)).optional(),
      }),
    )
    .optional(),
  /**
   * Optional Phase 7 named build-cache advertisement for scheduler affinity.
   * Opaque cache identity keys currently present (hashes only — no secrets).
   */
  build_caches: z
    .array(
      z.object({
        kind: BuildCacheKindSchema,
        keys: z.array(z.string().min(1)).optional(),
      }),
    )
    .optional(),
  /** Phase 6: false under disk/spool pressure — Agent also lease_rejects. */
  accepting_jobs: z.boolean().optional(),
  /**
   * Operator-configured scheduling priority (§19.2 / §19.3). When unset, the
   * Controller applies OS-family defaults at schedule time.
   */
  configured_priority: z.number().optional(),
});

export type AgentCapabilityReport = z.infer<typeof AgentCapabilityReportSchema>;
