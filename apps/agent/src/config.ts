import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BuildCacheKind, RiskLevel } from '@rbo/protocol';
import { BuildCacheKindSchema } from '@rbo/protocol';
import { type GitUrlAllowlist, resolveAgentStateDir } from '@rbo/shared';
import { z } from 'zod';
import { type BuildCacheConfig, DEFAULT_BUILD_CACHE_CONFIG } from './build-cache/index.js';
import { DEFAULT_REPO_CACHE_CONFIG, type RepoCacheConfig } from './repos/mirror.js';

export type { BuildCacheConfig };

export interface AgentConfig {
  controllerUrl: string;
  controllerFingerprint: string;
  displayName: string;
  maxJobs: number;
  stateDir: string;
  /**
   * Disposable mirror cache root (§2.8). Defaults to a sibling of stateDir
   * (`{parent}/repo-cache`) or RBO_REPO_CACHE_DIR — not inside identity tree.
   */
  repoCacheDir?: string;
  /** Maps store ref name → environment variable that holds the secret value. */
  secretMap?: Record<string, string>;
  /** Git remote allowlist enforced before clone/fetch/bundle import (§10.4). */
  gitAllowlist: GitUrlAllowlist;
  /** On-disk bare mirror cache limits (§10.10). */
  repoCache: RepoCacheConfig;
  /** Named build-cache quotas and risk policy (Phase 7). */
  buildCache: BuildCacheConfig;
  /** Max bytes for attempt log spool (stdout+stderr). Breach → log_spool_limit. */
  logSpoolMaxBytes: number;
  /** Max in-memory pending log_chunk send queue depth. */
  logSendQueueMax: number;
  /** Disconnect grace before orphaning (Phase 6). Default 60. */
  disconnectGraceSeconds: number;
  /** Orphan timeout before local cleanup eligibility (Phase 6). Default 300. */
  orphanTimeoutSeconds: number;
  /** Controller restart wait mirror (Agent may use for local deadlines). Default 120. */
  reconcileDeadlineSeconds: number;
  /**
   * Minimum free disk bytes before admission control refuses new leases (§31.4).
   * Defaults from RBO_DISK_MIN_FREE_BYTES or repo-cache min_free_disk_gb.
   */
  diskMinFreeBytes: number;
  /**
   * Optional §19.2 configured_priority override. When unset, the Agent advertises
   * no value and the Controller applies OS-family defaults.
   */
  configuredPriority?: number;
}

/** Default disk admission floor: 1 GiB when RBO_DISK_MIN_FREE_BYTES unset. */
export const DEFAULT_DISK_MIN_FREE_BYTES = 1_073_741_824;

/** Default max spool size: 512 MiB. */
export const DEFAULT_LOG_SPOOL_MAX_BYTES = 536_870_912;

/** Default bounded send queue depth. */
export const DEFAULT_LOG_SEND_QUEUE_MAX = 64;

/** Default Git schemes when RBO_GIT_ALLOWLIST_SCHEMES is unset. */
export const DEFAULT_GIT_ALLOWLIST_SCHEMES = ['https', 'ssh'] as const;

/** Default Git hosts when RBO_GIT_ALLOWLIST_HOSTS is unset. */
export const DEFAULT_GIT_ALLOWLIST_HOSTS = ['github.com'] as const;

/** Operator config basename under the agent state dir. */
export const AGENT_CONFIG_FILENAME = 'agent.json';

/** Schema version written into `agent.json` by `rbo agent init`. */
export const AGENT_CONFIG_SCHEMA_VERSION = 1;

const RiskLevelSchema = z.enum(['safe', 'normal', 'destructive', 'hardware']);

const GitAllowlistFileSchema = z.object({
  schemes: z.array(z.string().min(1)).optional(),
  hosts: z.array(z.string().min(1)).optional(),
  repository_prefixes: z.array(z.string().min(1)).optional(),
});

const RepoCacheFileSchema = z.object({
  max_size_gb: z.number().positive().optional(),
  min_free_disk_gb: z.number().nonnegative().optional(),
  retention_days: z.number().nonnegative().optional(),
});

const BuildCacheFileSchema = z.object({
  enabled_kinds: z.array(BuildCacheKindSchema).optional(),
  max_size_gb: z.number().positive().optional(),
  min_free_disk_gb: z.number().nonnegative().optional(),
  retention_days: z.number().nonnegative().optional(),
  allow_read_risk_levels: z.array(RiskLevelSchema).optional(),
  allow_write_risk_levels: z.array(RiskLevelSchema).optional(),
});

/** Zod schema for `agent.json` (operator-facing snake_case). */
export const AgentConfigFileSchema = z
  .object({
    schema_version: z.number().int().positive().optional(),
    initialized_at: z.string().min(1).optional(),
    controller_url: z.string().optional(),
    controller_fingerprint: z.string().optional(),
    display_name: z.string().min(1).optional(),
    max_jobs: z.number().int().positive().optional(),
    repo_cache_dir: z.string().min(1).nullable().optional(),
    secret_map: z.record(z.string()).nullable().optional(),
    git_allowlist: GitAllowlistFileSchema.optional(),
    repo_cache: RepoCacheFileSchema.optional(),
    build_cache: BuildCacheFileSchema.optional(),
    log_spool_max_bytes: z.number().int().positive().optional(),
    log_send_queue_max: z.number().int().positive().optional(),
    disconnect_grace_seconds: z.number().int().nonnegative().optional(),
    orphan_timeout_seconds: z.number().int().nonnegative().optional(),
    reconcile_deadline_seconds: z.number().int().nonnegative().optional(),
    disk_min_free_bytes: z.number().int().nonnegative().nullable().optional(),
    configured_priority: z.number().nullable().optional(),
  })
  .strict();

export type AgentConfigFile = z.infer<typeof AgentConfigFileSchema>;

export type LoadAgentConfigOptions = Partial<AgentConfig> & {
  /**
   * Path to `agent.json`. Default: `{stateDir}/agent.json`.
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
  file: AgentConfigFile['git_allowlist'] | undefined,
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

function parseBuildCacheKinds(raw: string | undefined): BuildCacheKind[] | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  const kinds: BuildCacheKind[] = [];
  for (const part of parseCsv(raw)) {
    const parsed = BuildCacheKindSchema.safeParse(part);
    if (!parsed.success) {
      throw new Error(
        `Invalid RBO_BUILD_CACHE_ENABLED_KINDS entry '${part}' — expected ccache|sccache|npm|pnpm|pip`,
      );
    }
    kinds.push(parsed.data);
  }
  return kinds;
}

function parseRiskLevels(raw: string | undefined): RiskLevel[] | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  const allowed = new Set(['safe', 'normal', 'destructive', 'hardware']);
  const levels: RiskLevel[] = [];
  for (const part of parseCsv(raw)) {
    if (!allowed.has(part)) {
      throw new Error(`Invalid risk level '${part}' — expected safe|normal|destructive|hardware`);
    }
    levels.push(part as RiskLevel);
  }
  return levels;
}

function mergeRepoCache(
  file: AgentConfigFile['repo_cache'] | undefined,
  override: RepoCacheConfig | undefined,
): RepoCacheConfig {
  if (override) {
    return override;
  }
  const maxSize = envSet('RBO_REPO_CACHE_MAX_SIZE_GB')
    ? parseEnvNumber('RBO_REPO_CACHE_MAX_SIZE_GB', process.env.RBO_REPO_CACHE_MAX_SIZE_GB)
    : (file?.max_size_gb ?? DEFAULT_REPO_CACHE_CONFIG.max_size_gb);
  const minFree = envSet('RBO_REPO_CACHE_MIN_FREE_DISK_GB')
    ? parseEnvNumber('RBO_REPO_CACHE_MIN_FREE_DISK_GB', process.env.RBO_REPO_CACHE_MIN_FREE_DISK_GB)
    : (file?.min_free_disk_gb ?? DEFAULT_REPO_CACHE_CONFIG.min_free_disk_gb);
  const retention = envSet('RBO_REPO_CACHE_RETENTION_DAYS')
    ? parseEnvNumber('RBO_REPO_CACHE_RETENTION_DAYS', process.env.RBO_REPO_CACHE_RETENTION_DAYS)
    : (file?.retention_days ?? DEFAULT_REPO_CACHE_CONFIG.retention_days);
  return {
    max_size_gb: maxSize,
    min_free_disk_gb: minFree,
    retention_days: retention,
  };
}

function mergeBuildCache(
  file: AgentConfigFile['build_cache'] | undefined,
  override: BuildCacheConfig | undefined,
): BuildCacheConfig {
  if (override) {
    return override;
  }
  return {
    enabledKinds: (envSet('RBO_BUILD_CACHE_ENABLED_KINDS')
      ? parseBuildCacheKinds(process.env.RBO_BUILD_CACHE_ENABLED_KINDS)
      : undefined) ??
      file?.enabled_kinds ?? [...DEFAULT_BUILD_CACHE_CONFIG.enabledKinds],
    maxSizeGb: envSet('RBO_BUILD_CACHE_MAX_SIZE_GB')
      ? parseEnvNumber('RBO_BUILD_CACHE_MAX_SIZE_GB', process.env.RBO_BUILD_CACHE_MAX_SIZE_GB)
      : (file?.max_size_gb ?? DEFAULT_BUILD_CACHE_CONFIG.maxSizeGb),
    minFreeDiskGb: envSet('RBO_BUILD_CACHE_MIN_FREE_DISK_GB')
      ? parseEnvNumber(
          'RBO_BUILD_CACHE_MIN_FREE_DISK_GB',
          process.env.RBO_BUILD_CACHE_MIN_FREE_DISK_GB,
        )
      : (file?.min_free_disk_gb ?? DEFAULT_BUILD_CACHE_CONFIG.minFreeDiskGb),
    retentionDays: envSet('RBO_BUILD_CACHE_RETENTION_DAYS')
      ? parseEnvNumber('RBO_BUILD_CACHE_RETENTION_DAYS', process.env.RBO_BUILD_CACHE_RETENTION_DAYS)
      : (file?.retention_days ?? DEFAULT_BUILD_CACHE_CONFIG.retentionDays),
    allowReadRiskLevels: (envSet('RBO_BUILD_CACHE_ALLOW_READ_RISKS')
      ? parseRiskLevels(process.env.RBO_BUILD_CACHE_ALLOW_READ_RISKS)
      : undefined) ??
      file?.allow_read_risk_levels ?? [...DEFAULT_BUILD_CACHE_CONFIG.allowReadRiskLevels],
    allowWriteRiskLevels: (envSet('RBO_BUILD_CACHE_ALLOW_WRITE_RISKS')
      ? parseRiskLevels(process.env.RBO_BUILD_CACHE_ALLOW_WRITE_RISKS)
      : undefined) ??
      file?.allow_write_risk_levels ?? [...DEFAULT_BUILD_CACHE_CONFIG.allowWriteRiskLevels],
  };
}

function parseSecretMap(raw: string | undefined): Record<string, string> | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('RBO_SECRET_MAP must be a JSON object');
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        throw new Error(`RBO_SECRET_MAP value for '${key}' must be a string env var name`);
      }
      out[key] = value;
    }
    return out;
  } catch (error) {
    throw new Error(
      `Invalid RBO_SECRET_MAP: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Sensible defaults written by `rbo agent init` into `agent.json`.
 * `controller_url` / `controller_fingerprint` are empty until the operator fills them
 * (or sets `RBO_CONTROLLER_URL` / `RBO_CONTROLLER_FINGERPRINT`).
 */
export function defaultAgentConfigFile(
  options: {
    initializedAt?: string;
  } = {},
): AgentConfigFile {
  return {
    schema_version: AGENT_CONFIG_SCHEMA_VERSION,
    initialized_at: options.initializedAt ?? new Date().toISOString(),
    controller_url: '',
    controller_fingerprint: '',
    display_name: 'rbo-agent',
    max_jobs: 1,
    repo_cache_dir: null,
    secret_map: null,
    git_allowlist: {
      schemes: [...DEFAULT_GIT_ALLOWLIST_SCHEMES],
      hosts: [...DEFAULT_GIT_ALLOWLIST_HOSTS],
    },
    repo_cache: {
      max_size_gb: DEFAULT_REPO_CACHE_CONFIG.max_size_gb,
      min_free_disk_gb: DEFAULT_REPO_CACHE_CONFIG.min_free_disk_gb,
      retention_days: DEFAULT_REPO_CACHE_CONFIG.retention_days,
    },
    build_cache: {
      enabled_kinds: [...DEFAULT_BUILD_CACHE_CONFIG.enabledKinds],
      max_size_gb: DEFAULT_BUILD_CACHE_CONFIG.maxSizeGb,
      min_free_disk_gb: DEFAULT_BUILD_CACHE_CONFIG.minFreeDiskGb,
      retention_days: DEFAULT_BUILD_CACHE_CONFIG.retentionDays,
      allow_read_risk_levels: [...DEFAULT_BUILD_CACHE_CONFIG.allowReadRiskLevels],
      allow_write_risk_levels: [...DEFAULT_BUILD_CACHE_CONFIG.allowWriteRiskLevels],
    },
    log_spool_max_bytes: DEFAULT_LOG_SPOOL_MAX_BYTES,
    log_send_queue_max: DEFAULT_LOG_SEND_QUEUE_MAX,
    disconnect_grace_seconds: 60,
    orphan_timeout_seconds: 300,
    reconcile_deadline_seconds: 120,
    disk_min_free_bytes: null,
    configured_priority: null,
  };
}

export function resolveAgentConfigPath(stateDir: string): string {
  return join(stateDir, AGENT_CONFIG_FILENAME);
}

export function readAgentConfigFile(configPath: string): AgentConfigFile | undefined {
  if (!existsSync(configPath)) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid agent config JSON at ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = AgentConfigFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid agent config at ${configPath}: ${parsed.error.message}`);
  }
  return parsed.data;
}

/**
 * Write a complete default `agent.json` if missing (or when `force`).
 * Returns the path, whether a write occurred, and metadata for CLI reporting.
 */
export function writeDefaultAgentConfigFile(
  stateDir: string,
  options: { force?: boolean; initializedAt?: string } = {},
): { path: string; written: boolean; initialized_at: string; schema_version: number } {
  mkdirSync(stateDir, { recursive: true });
  const path = resolveAgentConfigPath(stateDir);
  if (existsSync(path) && !options.force) {
    // Mirror controller init: do not throw on corrupt JSON when skipping rewrite.
    // Operators can pass --force to replace a broken agent.json.
    let initialized_at = new Date(0).toISOString();
    let schema_version = AGENT_CONFIG_SCHEMA_VERSION;
    try {
      const existing = readAgentConfigFile(path);
      initialized_at = existing?.initialized_at ?? initialized_at;
      schema_version = existing?.schema_version ?? schema_version;
    } catch {
      // leave epoch / default schema_version; CLI reports written:false
    }
    return {
      path,
      written: false,
      initialized_at,
      schema_version,
    };
  }
  const initialized_at = options.initializedAt ?? new Date().toISOString();
  const body = `${JSON.stringify(defaultAgentConfigFile({ initializedAt: initialized_at }), null, 2)}\n`;
  writeFileSync(path, body, 'utf8');
  return {
    path,
    written: true,
    initialized_at,
    schema_version: AGENT_CONFIG_SCHEMA_VERSION,
  };
}

export function resolveDefaultStateDir(): string {
  return resolveAgentStateDir();
}

/**
 * Load Agent config.
 *
 * Precedence (highest wins): programmatic overrides → environment variables →
 * `agent.json` → built-in defaults.
 *
 * Operators edit `~/.rbo/agent/agent.json` (or `$RBO_AGENT_STATE_DIR/agent.json`).
 * Env vars remain available for CI/scripts and override the file.
 */
export function loadAgentConfig(overrides: LoadAgentConfigOptions = {}): AgentConfig {
  const { configPath: configPathOption, ...fieldOverrides } = overrides;
  const stateDir = fieldOverrides.stateDir ?? resolveAgentStateDir();
  const configPath =
    configPathOption === undefined ? resolveAgentConfigPath(stateDir) : configPathOption;
  const file = configPath === null ? undefined : readAgentConfigFile(configPath);

  const controllerUrl =
    fieldOverrides.controllerUrl ??
    (envSet('RBO_CONTROLLER_URL') ? process.env.RBO_CONTROLLER_URL : undefined) ??
    (file?.controller_url?.trim() ? file.controller_url.trim() : undefined);
  const controllerFingerprint =
    fieldOverrides.controllerFingerprint ??
    (envSet('RBO_CONTROLLER_FINGERPRINT') ? process.env.RBO_CONTROLLER_FINGERPRINT : undefined) ??
    (file?.controller_fingerprint?.trim() ? file.controller_fingerprint.trim() : undefined);

  if (!controllerUrl) {
    throw new Error(
      'controller_url is required — set it in agent.json (or RBO_CONTROLLER_URL=wss://<host>:7411/agent)',
    );
  }
  if (!controllerFingerprint) {
    throw new Error(
      'controller_fingerprint is required — set it in agent.json (or RBO_CONTROLLER_FINGERPRINT from `rbo controller fingerprint`)',
    );
  }

  const repoCache = mergeRepoCache(file?.repo_cache, fieldOverrides.repoCache);

  let secretMap = fieldOverrides.secretMap;
  if (secretMap === undefined) {
    if (envSet('RBO_SECRET_MAP')) {
      secretMap = parseSecretMap(process.env.RBO_SECRET_MAP);
    } else if (file?.secret_map !== undefined) {
      secretMap = file.secret_map ?? undefined;
    }
  }

  let repoCacheDir = fieldOverrides.repoCacheDir;
  if (repoCacheDir === undefined) {
    if (envSet('RBO_REPO_CACHE_DIR') && process.env.RBO_REPO_CACHE_DIR?.trim()) {
      repoCacheDir = process.env.RBO_REPO_CACHE_DIR.trim();
    } else if (file?.repo_cache_dir) {
      repoCacheDir = file.repo_cache_dir;
    }
  }

  let configuredPriority = fieldOverrides.configuredPriority;
  if (configuredPriority === undefined) {
    if (envSet('RBO_CONFIGURED_PRIORITY')) {
      configuredPriority = parseEnvNumber(
        'RBO_CONFIGURED_PRIORITY',
        process.env.RBO_CONFIGURED_PRIORITY,
      );
    } else if (file?.configured_priority !== undefined && file.configured_priority !== null) {
      configuredPriority = file.configured_priority;
    }
  }

  let diskMinFreeBytes = fieldOverrides.diskMinFreeBytes;
  if (diskMinFreeBytes === undefined) {
    if (envSet('RBO_DISK_MIN_FREE_BYTES')) {
      diskMinFreeBytes = parseEnvInt(
        'RBO_DISK_MIN_FREE_BYTES',
        process.env.RBO_DISK_MIN_FREE_BYTES,
      );
    } else if (file?.disk_min_free_bytes !== undefined && file.disk_min_free_bytes !== null) {
      diskMinFreeBytes = file.disk_min_free_bytes;
    } else {
      diskMinFreeBytes = Math.max(
        DEFAULT_DISK_MIN_FREE_BYTES,
        Math.floor(repoCache.min_free_disk_gb * 1024 ** 3),
      );
    }
  }

  return {
    controllerUrl,
    controllerFingerprint,
    displayName:
      fieldOverrides.displayName ??
      (envSet('RBO_AGENT_NAME') ? process.env.RBO_AGENT_NAME : undefined) ??
      file?.display_name ??
      'rbo-agent',
    maxJobs:
      fieldOverrides.maxJobs ??
      (envSet('RBO_MAX_JOBS')
        ? parseEnvInt('RBO_MAX_JOBS', process.env.RBO_MAX_JOBS)
        : undefined) ??
      file?.max_jobs ??
      1,
    stateDir,
    repoCacheDir,
    secretMap,
    gitAllowlist: mergeGitAllowlist(
      file?.git_allowlist,
      parseGitAllowlistFromEnv(),
      fieldOverrides.gitAllowlist,
    ),
    repoCache,
    buildCache: mergeBuildCache(file?.build_cache, fieldOverrides.buildCache),
    logSpoolMaxBytes:
      fieldOverrides.logSpoolMaxBytes ??
      (envSet('RBO_LOG_SPOOL_MAX_BYTES')
        ? parseEnvInt('RBO_LOG_SPOOL_MAX_BYTES', process.env.RBO_LOG_SPOOL_MAX_BYTES)
        : undefined) ??
      file?.log_spool_max_bytes ??
      DEFAULT_LOG_SPOOL_MAX_BYTES,
    logSendQueueMax:
      fieldOverrides.logSendQueueMax ??
      (envSet('RBO_LOG_SEND_QUEUE_MAX')
        ? parseEnvInt('RBO_LOG_SEND_QUEUE_MAX', process.env.RBO_LOG_SEND_QUEUE_MAX)
        : undefined) ??
      file?.log_send_queue_max ??
      DEFAULT_LOG_SEND_QUEUE_MAX,
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
    diskMinFreeBytes,
    configuredPriority,
  };
}

/** Disposable mirror cache root outside the identity state dir (§2.8). */
export function resolveRepoCacheRoot(
  config: Pick<AgentConfig, 'stateDir' | 'repoCacheDir'>,
): string {
  if (config.repoCacheDir) {
    return config.repoCacheDir;
  }
  return join(dirname(config.stateDir), 'repo-cache');
}

/** Resolved path for bare repository mirrors (§10.1). */
export function resolveReposDir(config: Pick<AgentConfig, 'stateDir' | 'repoCacheDir'>): string {
  return join(resolveRepoCacheRoot(config), 'repos');
}

/** Resolved path for named build caches (Phase 7). */
export function resolveBuildCachesDir(config: AgentConfig): string {
  return join(config.stateDir, 'build-caches');
}

export function ensureStateDir(config: AgentConfig): void {
  mkdirSync(config.stateDir, { recursive: true });
}
