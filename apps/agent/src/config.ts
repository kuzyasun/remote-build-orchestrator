import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { GitUrlAllowlist } from '@rbo/shared';
import { DEFAULT_REPO_CACHE_CONFIG, type RepoCacheConfig } from './repos/mirror.js';

export interface AgentConfig {
  controllerUrl: string;
  controllerFingerprint: string;
  displayName: string;
  maxJobs: number;
  stateDir: string;
  /** Maps store ref name → environment variable that holds the secret value. */
  secretMap?: Record<string, string>;
  /** Git remote allowlist enforced before clone/fetch/bundle import (§10.4). */
  gitAllowlist: GitUrlAllowlist;
  /** On-disk bare mirror cache limits (§10.10). */
  repoCache: RepoCacheConfig;
}

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
    secretMap: overrides.secretMap ?? parseSecretMap(process.env.RBO_SECRET_MAP),
    gitAllowlist: parseGitAllowlist(overrides.gitAllowlist),
    repoCache: parseRepoCache(overrides.repoCache),
  };
}

/** Resolved path for bare repository mirrors (§10.1). */
export function resolveReposDir(config: AgentConfig): string {
  return join(config.stateDir, 'repos');
}

export function ensureStateDir(config: AgentConfig): void {
  mkdirSync(config.stateDir, { recursive: true });
}
