import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BuildCacheKind, RiskLevel } from '@rbo/protocol';
import { BuildCacheKindSchema } from '@rbo/protocol';
import type { GitUrlAllowlist } from '@rbo/shared';
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

function parseCsv(raw: string | undefined): string[] {
  if (!raw?.trim()) {
    return [];
  }
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseGitAllowlist(overrides?: GitUrlAllowlist): GitUrlAllowlist {
  if (overrides) {
    return overrides;
  }
  const schemes = parseCsv(process.env.RBO_GIT_ALLOWLIST_SCHEMES);
  const hosts = parseCsv(process.env.RBO_GIT_ALLOWLIST_HOSTS);
  const prefixesRaw = process.env.RBO_GIT_ALLOWLIST_PREFIXES?.trim();
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

function parseRepoCache(overrides?: RepoCacheConfig): RepoCacheConfig {
  if (overrides) {
    return overrides;
  }
  const maxSize = Number(
    process.env.RBO_REPO_CACHE_MAX_SIZE_GB ?? DEFAULT_REPO_CACHE_CONFIG.max_size_gb,
  );
  const minFree = Number(
    process.env.RBO_REPO_CACHE_MIN_FREE_DISK_GB ?? DEFAULT_REPO_CACHE_CONFIG.min_free_disk_gb,
  );
  const retention = Number(
    process.env.RBO_REPO_CACHE_RETENTION_DAYS ?? DEFAULT_REPO_CACHE_CONFIG.retention_days,
  );
  return {
    max_size_gb: maxSize,
    min_free_disk_gb: minFree,
    retention_days: retention,
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

function parseBuildCache(overrides?: BuildCacheConfig): BuildCacheConfig {
  if (overrides) {
    return overrides;
  }
  return {
    enabledKinds: parseBuildCacheKinds(process.env.RBO_BUILD_CACHE_ENABLED_KINDS) ?? [
      ...DEFAULT_BUILD_CACHE_CONFIG.enabledKinds,
    ],
    maxSizeGb: Number(
      process.env.RBO_BUILD_CACHE_MAX_SIZE_GB ?? DEFAULT_BUILD_CACHE_CONFIG.maxSizeGb,
    ),
    minFreeDiskGb: Number(
      process.env.RBO_BUILD_CACHE_MIN_FREE_DISK_GB ?? DEFAULT_BUILD_CACHE_CONFIG.minFreeDiskGb,
    ),
    retentionDays: Number(
      process.env.RBO_BUILD_CACHE_RETENTION_DAYS ?? DEFAULT_BUILD_CACHE_CONFIG.retentionDays,
    ),
    allowReadRiskLevels: parseRiskLevels(process.env.RBO_BUILD_CACHE_ALLOW_READ_RISKS) ?? [
      ...DEFAULT_BUILD_CACHE_CONFIG.allowReadRiskLevels,
    ],
    allowWriteRiskLevels: parseRiskLevels(process.env.RBO_BUILD_CACHE_ALLOW_WRITE_RISKS) ?? [
      ...DEFAULT_BUILD_CACHE_CONFIG.allowWriteRiskLevels,
    ],
  };
}

export function resolveDefaultStateDir(): string {
  if (process.platform === 'win32' && process.env.ProgramData) {
    return join(process.env.ProgramData, 'RBO');
  }
  if (process.platform === 'darwin') {
    return '/Library/Application Support/RBO';
  }
  return join(homedir(), '.rbo-agent');
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

export function loadAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const controllerUrl = overrides.controllerUrl ?? process.env.RBO_CONTROLLER_URL;
  const controllerFingerprint =
    overrides.controllerFingerprint ?? process.env.RBO_CONTROLLER_FINGERPRINT;
  if (!controllerUrl) {
    throw new Error('RBO_CONTROLLER_URL is required (wss://<host>:7411/agent)');
  }
  if (!controllerFingerprint) {
    throw new Error(
      'RBO_CONTROLLER_FINGERPRINT is required — run `rbo controller fingerprint` on the Controller and copy the value here',
    );
  }
  return {
    controllerUrl,
    controllerFingerprint,
    displayName: overrides.displayName ?? process.env.RBO_AGENT_NAME ?? 'rbo-agent',
    maxJobs: overrides.maxJobs ?? Number(process.env.RBO_MAX_JOBS ?? 1),
    stateDir: overrides.stateDir ?? process.env.RBO_AGENT_STATE_DIR ?? resolveDefaultStateDir(),
    repoCacheDir:
      overrides.repoCacheDir ??
      (process.env.RBO_REPO_CACHE_DIR?.trim() ? process.env.RBO_REPO_CACHE_DIR.trim() : undefined),
    secretMap: overrides.secretMap ?? parseSecretMap(process.env.RBO_SECRET_MAP),
    gitAllowlist: parseGitAllowlist(overrides.gitAllowlist),
    repoCache: parseRepoCache(overrides.repoCache),
    buildCache: parseBuildCache(overrides.buildCache),
    logSpoolMaxBytes:
      overrides.logSpoolMaxBytes ??
      Number(process.env.RBO_LOG_SPOOL_MAX_BYTES ?? DEFAULT_LOG_SPOOL_MAX_BYTES),
    logSendQueueMax:
      overrides.logSendQueueMax ??
      Number(process.env.RBO_LOG_SEND_QUEUE_MAX ?? DEFAULT_LOG_SEND_QUEUE_MAX),
    disconnectGraceSeconds:
      overrides.disconnectGraceSeconds ?? Number(process.env.RBO_DISCONNECT_GRACE_SECONDS ?? 60),
    orphanTimeoutSeconds:
      overrides.orphanTimeoutSeconds ?? Number(process.env.RBO_ORPHAN_TIMEOUT_SECONDS ?? 300),
    reconcileDeadlineSeconds:
      overrides.reconcileDeadlineSeconds ??
      Number(process.env.RBO_RECONCILE_DEADLINE_SECONDS ?? 120),
    diskMinFreeBytes: (() => {
      if (overrides.diskMinFreeBytes !== undefined) {
        return overrides.diskMinFreeBytes;
      }
      if (process.env.RBO_DISK_MIN_FREE_BYTES) {
        return Number(process.env.RBO_DISK_MIN_FREE_BYTES);
      }
      const repoCache = parseRepoCache(overrides.repoCache);
      return Math.max(
        DEFAULT_DISK_MIN_FREE_BYTES,
        Math.floor(repoCache.min_free_disk_gb * 1024 ** 3),
      );
    })(),
    configuredPriority: (() => {
      if (overrides.configuredPriority !== undefined) {
        return overrides.configuredPriority;
      }
      if (process.env.RBO_CONFIGURED_PRIORITY) {
        return Number(process.env.RBO_CONFIGURED_PRIORITY);
      }
      return undefined;
    })(),
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
