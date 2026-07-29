import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { type QueuePolicy, QueuePolicySchema } from '@rbo/protocol';
import { type GitUrlAllowlist, resolveControllerDataDir } from '@rbo/shared';
import { z } from 'zod';

export interface LocalExecutorConfig {
  maxConcurrentJobs: number;
}

export interface ControllerConfig {
  mcpHost: string;
  mcpPort: number;
  agentPlanePort: number;
  /** Host/IP Agents use for data-plane HTTPS URLs. Defaults to 127.0.0.1. */
  controllerPublicHost: string;
  /** Optional full data-plane base URL override (wins over host+port). */
  dataPlaneBaseUrl?: string;
  dataDir: string;
  databasePath: string;
  allowedProjectRoots: string[];
  allowedArtifactDestinations: string[];
  /** Git remote allowlist for overlay capture (§10.4). */
  gitAllowlist: GitUrlAllowlist;
  localExecutor: LocalExecutorConfig;
  /** Disconnect grace before orphaning (Phase 6). Default 60. */
  disconnectGraceSeconds: number;
  /** Orphan timeout before outcome=lost (Phase 6). Default 300. */
  orphanTimeoutSeconds: number;
  /** Controller restart wait for Agent recovery_report (Phase 6). Default 120. */
  reconcileDeadlineSeconds: number;
  /** Allow local executor fallback when no remote agent matches (§19.5). Default true. */
  allowLocalFallback: boolean;
  /**
   * Allow falling back to a FULL working-tree snapshot when git-overlay capture is
   * not possible (§10.4). Default false: overlay only ships the dirty diff, so a
   * silent fallback can turn a config mistake (e.g. an SSH host alias missing from
   * `git_allowlist.hosts`) into a multi-hundred-MB upload that looks like a hang.
   */
  allowFullSnapshotFallback: boolean;
  /** Max git bundle bytes for local-only base commits (Phase 5). Default 512 MiB. */
  maxGitBundleBytes: number;
  /**
   * Host-aware local fallback (docs/dev/host-aware-local-fallback-plan.md): CPU busy-fraction
   * [0,1] above which the host is excluded from local-fallback consideration (unless it's still
   * the least-loaded option available — see `decideLocalFallback`). Default 0.8.
   */
  maxHostCpuBusyFraction: number;
  /**
   * Queue policy applied to a job whose `JobRequest.queue_policy` was not explicitly set by the
   * client. `wait` (default) keeps such jobs in the `queued` backlog until an eligible Agent has
   * capacity; `local_fallback` runs them on the Controller host; `fail_fast` fails immediately.
   */
  defaultQueuePolicy: QueuePolicy;
}

/** Default max git bundle size when RBO_MAX_GIT_BUNDLE_BYTES is unset (512 MiB). */
export const DEFAULT_MAX_GIT_BUNDLE_BYTES = 512 * 1024 * 1024;

/** Default Git schemes when RBO_GIT_ALLOWLIST_SCHEMES is unset. */
export const DEFAULT_GIT_ALLOWLIST_SCHEMES = ['https', 'ssh'] as const;

/** Default Git hosts when RBO_GIT_ALLOWLIST_HOSTS is unset. */
export const DEFAULT_GIT_ALLOWLIST_HOSTS = ['github.com'] as const;

/** Operator config basename under the controller data dir. */
export const CONTROLLER_CONFIG_FILENAME = 'controller.json';

const GitAllowlistFileSchema = z.object({
  schemes: z.array(z.string().min(1)).optional(),
  hosts: z.array(z.string().min(1)).optional(),
  repository_prefixes: z.array(z.string().min(1)).optional(),
});

/**
 * Allowlist path entry: non-empty, no surrounding whitespace, absolute.
 * Rejects `""`, `"."`, and relatives so they cannot realpath to process cwd.
 */
export const AbsoluteAllowlistPathSchema = z
  .string()
  .refine((value) => value.length > 0 && value === value.trim() && isAbsolute(value), {
    message: 'must be a non-empty absolute path (relative paths, ".", and whitespace are rejected)',
  });
/** Zod schema for `controller.json` (operator-facing snake_case). */
export const ControllerConfigFileSchema = z
  .object({
    mcp_host: z.string().min(1).optional(),
    mcp_port: z.number().int().positive().optional(),
    agent_plane_port: z.number().int().positive().optional(),
    controller_public_host: z.string().min(1).optional(),
    data_plane_base_url: z.string().min(1).nullable().optional(),
    allowed_project_roots: z.array(AbsoluteAllowlistPathSchema).optional(),
    allowed_artifact_destinations: z.array(AbsoluteAllowlistPathSchema).optional(),
    git_allowlist: GitAllowlistFileSchema.optional(),
    local_max_concurrent_jobs: z.number().int().positive().optional(),
    disconnect_grace_seconds: z.number().int().nonnegative().optional(),
    orphan_timeout_seconds: z.number().int().nonnegative().optional(),
    reconcile_deadline_seconds: z.number().int().nonnegative().optional(),
    allow_local_fallback: z.boolean().optional(),
    allow_full_snapshot_fallback: z.boolean().optional(),
    max_git_bundle_bytes: z.number().int().positive().optional(),
    local_fallback_max_host_cpu_percent: z.number().min(0).max(100).optional(),
    default_queue_policy: QueuePolicySchema.optional(),
  })
  .strict();

export type ControllerConfigFile = z.infer<typeof ControllerConfigFileSchema>;

export type LoadControllerConfigOptions = Partial<ControllerConfig> & {
  /**
   * Path to `controller.json`. Default: `{dataDir}/controller.json`.
   * Pass `null` to skip file load (tests / programmatic-only).
   */
  configPath?: string | null;
};

function parseCsv(raw: string | undefined): string[] {
  if (!raw?.trim()) {
    return [];
  }
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function envSet(key: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return env[key] !== undefined;
}

/** Parse a finite env number; throw instead of returning NaN. */
export function parseEnvNumber(key: string, raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid ${key}=${JSON.stringify(raw)}: expected a finite number`);
  }
  return n;
}

/** Parse an integer env number; throw instead of returning NaN. */
export function parseEnvInt(key: string, raw: string | undefined): number {
  const n = parseEnvNumber(key, raw);
  if (!Number.isInteger(n)) {
    throw new Error(`Invalid ${key}=${JSON.stringify(raw)}: expected an integer`);
  }
  return n;
}

/**
 * Validate allowlist path entries (env CSV / programmatic overrides).
 * Empty and whitespace-only entries are rejected; paths must be absolute.
 */
export function assertAbsoluteAllowlistPaths(paths: string[], label: string): string[] {
  return paths.map((path, index) => {
    const parsed = AbsoluteAllowlistPathSchema.safeParse(path);
    if (!parsed.success) {
      throw new Error(
        `Invalid ${label}[${index}]=${JSON.stringify(path)}: must be a non-empty absolute path`,
      );
    }
    return parsed.data;
  });
}

function parseGitAllowlistFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GitUrlAllowlist | undefined {
  if (
    !envSet('RBO_GIT_ALLOWLIST_SCHEMES', env) &&
    !envSet('RBO_GIT_ALLOWLIST_HOSTS', env) &&
    !envSet('RBO_GIT_ALLOWLIST_PREFIXES', env)
  ) {
    return undefined;
  }
  const schemes = parseCsv(env.RBO_GIT_ALLOWLIST_SCHEMES);
  const hosts = parseCsv(env.RBO_GIT_ALLOWLIST_HOSTS);
  const prefixesRaw = env.RBO_GIT_ALLOWLIST_PREFIXES?.trim();
  let repository_prefixes: string[] | undefined;
  if (prefixesRaw) {
    try {
      const parsed = JSON.parse(prefixesRaw) as unknown;
      if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
        throw new Error('must be a JSON string array');
      }
      repository_prefixes = parsed;
    } catch (error) {
      throw new Error(
        `Invalid RBO_GIT_ALLOWLIST_PREFIXES: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    schemes: schemes.length > 0 ? schemes : [...DEFAULT_GIT_ALLOWLIST_SCHEMES],
    hosts: hosts.length > 0 ? hosts : [...DEFAULT_GIT_ALLOWLIST_HOSTS],
    ...(repository_prefixes ? { repository_prefixes } : {}),
  };
}

function mergeGitAllowlist(
  file: ControllerConfigFile['git_allowlist'] | undefined,
  fromEnv: GitUrlAllowlist | undefined,
  override: GitUrlAllowlist | undefined,
): GitUrlAllowlist {
  if (override) {
    return override;
  }
  if (fromEnv) {
    return fromEnv;
  }
  if (file) {
    return {
      schemes:
        file.schemes && file.schemes.length > 0 ? file.schemes : [...DEFAULT_GIT_ALLOWLIST_SCHEMES],
      hosts: file.hosts && file.hosts.length > 0 ? file.hosts : [...DEFAULT_GIT_ALLOWLIST_HOSTS],
      ...(file.repository_prefixes ? { repository_prefixes: file.repository_prefixes } : {}),
    };
  }
  return {
    schemes: [...DEFAULT_GIT_ALLOWLIST_SCHEMES],
    hosts: [...DEFAULT_GIT_ALLOWLIST_HOSTS],
  };
}

/**
 * Sensible defaults written by `rbo controller init` into `controller.json`.
 * `allowed_project_roots` / `allowed_artifact_destinations` stay empty until the operator fills them.
 */
export function defaultControllerConfigFile(): ControllerConfigFile {
  return {
    mcp_host: '127.0.0.1',
    mcp_port: 7410,
    agent_plane_port: 7411,
    controller_public_host: '127.0.0.1',
    data_plane_base_url: null,
    allowed_project_roots: [],
    allowed_artifact_destinations: [],
    git_allowlist: {
      schemes: [...DEFAULT_GIT_ALLOWLIST_SCHEMES],
      hosts: [...DEFAULT_GIT_ALLOWLIST_HOSTS],
    },
    local_max_concurrent_jobs: 1,
    disconnect_grace_seconds: 60,
    orphan_timeout_seconds: 300,
    reconcile_deadline_seconds: 120,
    allow_local_fallback: true,
    allow_full_snapshot_fallback: false,
    max_git_bundle_bytes: DEFAULT_MAX_GIT_BUNDLE_BYTES,
    local_fallback_max_host_cpu_percent: 80,
    default_queue_policy: 'wait',
  };
}

export function resolveControllerConfigPath(dataDir: string): string {
  return join(dataDir, CONTROLLER_CONFIG_FILENAME);
}

export function readControllerConfigFile(configPath: string): ControllerConfigFile | undefined {
  if (!existsSync(configPath)) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid controller config JSON at ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = ControllerConfigFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid controller config at ${configPath}: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Write a complete default `controller.json` if missing (or when `force`).
 * Returns the path and whether a write occurred.
 */
export function writeDefaultControllerConfigFile(
  dataDir: string,
  options: { force?: boolean } = {},
): { path: string; written: boolean } {
  mkdirSync(dataDir, { recursive: true });
  const path = resolveControllerConfigPath(dataDir);
  if (existsSync(path) && !options.force) {
    return { path, written: false };
  }
  const body = `${JSON.stringify(defaultControllerConfigFile(), null, 2)}\n`;
  writeFileSync(path, body, 'utf8');
  return { path, written: true };
}

export function resolveDefaultDataDir(): string {
  return resolveControllerDataDir();
}

/**
 * Load Controller config.
 *
 * Precedence (highest wins): programmatic overrides → environment variables →
 * `controller.json` → built-in defaults.
 *
 * Operators edit `~/.rbo/controller.json` (or `$RBO_DATA_DIR/controller.json`).
 * Env vars remain available for CI/scripts and override the file.
 */
export function loadControllerConfig(
  overrides: LoadControllerConfigOptions = {},
): ControllerConfig {
  const { configPath: configPathOption, ...fieldOverrides } = overrides;
  const dataDir = fieldOverrides.dataDir ?? resolveControllerDataDir();
  const configPath =
    configPathOption === undefined ? resolveControllerConfigPath(dataDir) : configPathOption;
  const file = configPath === null ? undefined : readControllerConfigFile(configPath);

  const mcpHost =
    fieldOverrides.mcpHost ??
    (envSet('RBO_MCP_HOST') ? process.env.RBO_MCP_HOST : undefined) ??
    file?.mcp_host ??
    '127.0.0.1';
  const mcpPort =
    fieldOverrides.mcpPort ??
    (envSet('RBO_MCP_PORT') ? parseEnvInt('RBO_MCP_PORT', process.env.RBO_MCP_PORT) : undefined) ??
    file?.mcp_port ??
    7410;
  const agentPlanePort =
    fieldOverrides.agentPlanePort ??
    (envSet('RBO_AGENT_PORT')
      ? parseEnvInt('RBO_AGENT_PORT', process.env.RBO_AGENT_PORT)
      : undefined) ??
    file?.agent_plane_port ??
    7411;
  const controllerPublicHost =
    fieldOverrides.controllerPublicHost ??
    (envSet('RBO_CONTROLLER_PUBLIC_HOST') ? process.env.RBO_CONTROLLER_PUBLIC_HOST : undefined) ??
    file?.controller_public_host ??
    '127.0.0.1';

  let dataPlaneBaseUrl = fieldOverrides.dataPlaneBaseUrl;
  if (dataPlaneBaseUrl === undefined) {
    if (envSet('RBO_DATA_PLANE_BASE_URL')) {
      dataPlaneBaseUrl = process.env.RBO_DATA_PLANE_BASE_URL;
    } else if (file?.data_plane_base_url !== undefined) {
      dataPlaneBaseUrl = file.data_plane_base_url ?? undefined;
    }
  }

  const allowedProjectRoots = assertAbsoluteAllowlistPaths(
    fieldOverrides.allowedProjectRoots ??
      (envSet('RBO_ALLOWED_PROJECT_ROOTS')
        ? parseCsv(process.env.RBO_ALLOWED_PROJECT_ROOTS)
        : undefined) ??
      file?.allowed_project_roots ??
      [],
    'allowed_project_roots',
  );
  const allowedArtifactDestinations = assertAbsoluteAllowlistPaths(
    fieldOverrides.allowedArtifactDestinations ??
      (envSet('RBO_ALLOWED_ARTIFACT_DESTINATIONS')
        ? parseCsv(process.env.RBO_ALLOWED_ARTIFACT_DESTINATIONS)
        : undefined) ??
      file?.allowed_artifact_destinations ??
      [],
    'allowed_artifact_destinations',
  );

  const allowLocalFallback =
    fieldOverrides.allowLocalFallback ??
    (envSet('RBO_ALLOW_LOCAL_FALLBACK')
      ? process.env.RBO_ALLOW_LOCAL_FALLBACK !== 'false'
      : undefined) ??
    file?.allow_local_fallback ??
    true;

  const defaultQueuePolicy =
    fieldOverrides.defaultQueuePolicy ??
    (envSet('RBO_DEFAULT_QUEUE_POLICY')
      ? (QueuePolicySchema.parse(process.env.RBO_DEFAULT_QUEUE_POLICY) as QueuePolicy)
      : undefined) ??
    file?.default_queue_policy ??
    'wait';

  const allowFullSnapshotFallback =
    fieldOverrides.allowFullSnapshotFallback ??
    (envSet('RBO_ALLOW_FULL_SNAPSHOT_FALLBACK')
      ? process.env.RBO_ALLOW_FULL_SNAPSHOT_FALLBACK === 'true'
      : undefined) ??
    file?.allow_full_snapshot_fallback ??
    false;

  const maxHostCpuBusyFraction =
    fieldOverrides.maxHostCpuBusyFraction ??
    (envSet('RBO_LOCAL_FALLBACK_MAX_HOST_CPU_PERCENT')
      ? parseEnvNumber(
          'RBO_LOCAL_FALLBACK_MAX_HOST_CPU_PERCENT',
          process.env.RBO_LOCAL_FALLBACK_MAX_HOST_CPU_PERCENT,
        ) / 100
      : undefined) ??
    (file?.local_fallback_max_host_cpu_percent !== undefined
      ? file.local_fallback_max_host_cpu_percent / 100
      : undefined) ??
    0.8;

  return {
    mcpHost,
    mcpPort,
    agentPlanePort,
    controllerPublicHost,
    dataPlaneBaseUrl,
    dataDir,
    databasePath: fieldOverrides.databasePath ?? join(dataDir, 'controller.db'),
    allowedProjectRoots,
    allowedArtifactDestinations,
    gitAllowlist: mergeGitAllowlist(
      file?.git_allowlist,
      parseGitAllowlistFromEnv(),
      fieldOverrides.gitAllowlist,
    ),
    localExecutor: {
      maxConcurrentJobs:
        fieldOverrides.localExecutor?.maxConcurrentJobs ??
        (envSet('RBO_LOCAL_MAX_CONCURRENT_JOBS')
          ? parseEnvInt('RBO_LOCAL_MAX_CONCURRENT_JOBS', process.env.RBO_LOCAL_MAX_CONCURRENT_JOBS)
          : undefined) ??
        file?.local_max_concurrent_jobs ??
        1,
    },
    disconnectGraceSeconds:
      fieldOverrides.disconnectGraceSeconds ??
      (envSet('RBO_DISCONNECT_GRACE_SECONDS')
        ? parseEnvInt('RBO_DISCONNECT_GRACE_SECONDS', process.env.RBO_DISCONNECT_GRACE_SECONDS)
        : undefined) ??
      file?.disconnect_grace_seconds ??
      60,
    orphanTimeoutSeconds:
      fieldOverrides.orphanTimeoutSeconds ??
      (envSet('RBO_ORPHAN_TIMEOUT_SECONDS')
        ? parseEnvInt('RBO_ORPHAN_TIMEOUT_SECONDS', process.env.RBO_ORPHAN_TIMEOUT_SECONDS)
        : undefined) ??
      file?.orphan_timeout_seconds ??
      300,
    reconcileDeadlineSeconds:
      fieldOverrides.reconcileDeadlineSeconds ??
      (envSet('RBO_RECONCILE_DEADLINE_SECONDS')
        ? parseEnvInt('RBO_RECONCILE_DEADLINE_SECONDS', process.env.RBO_RECONCILE_DEADLINE_SECONDS)
        : undefined) ??
      file?.reconcile_deadline_seconds ??
      120,
    allowLocalFallback,
    allowFullSnapshotFallback,
    maxGitBundleBytes:
      fieldOverrides.maxGitBundleBytes ??
      (envSet('RBO_MAX_GIT_BUNDLE_BYTES')
        ? parseEnvInt('RBO_MAX_GIT_BUNDLE_BYTES', process.env.RBO_MAX_GIT_BUNDLE_BYTES)
        : undefined) ??
      file?.max_git_bundle_bytes ??
      DEFAULT_MAX_GIT_BUNDLE_BYTES,
    maxHostCpuBusyFraction,
    defaultQueuePolicy,
  };
}

export function ensureDataDir(config: ControllerConfig): void {
  mkdirSync(config.dataDir, { recursive: true });
}
