import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { GitUrlAllowlist } from '@rbo/shared';

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
  /** Max git bundle bytes for local-only base commits (Phase 5). Default 512 MiB. */
  maxGitBundleBytes: number;
}

/** Default max git bundle size when RBO_MAX_GIT_BUNDLE_BYTES is unset (512 MiB). */
export const DEFAULT_MAX_GIT_BUNDLE_BYTES = 512 * 1024 * 1024;

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

export function resolveDefaultDataDir(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (process.platform === 'win32' && localAppData) {
    return join(localAppData, 'RBO');
  }
  return join(homedir(), '.rbo');
}

export function loadControllerConfig(overrides: Partial<ControllerConfig> = {}): ControllerConfig {
  const dataDir = overrides.dataDir ?? process.env.RBO_DATA_DIR ?? resolveDefaultDataDir();
  return {
    mcpHost: overrides.mcpHost ?? process.env.RBO_MCP_HOST ?? '127.0.0.1',
    mcpPort: overrides.mcpPort ?? Number(process.env.RBO_MCP_PORT ?? 7410),
    agentPlanePort: overrides.agentPlanePort ?? Number(process.env.RBO_AGENT_PORT ?? 7411),
    controllerPublicHost:
      overrides.controllerPublicHost ?? process.env.RBO_CONTROLLER_PUBLIC_HOST ?? '127.0.0.1',
    dataPlaneBaseUrl: overrides.dataPlaneBaseUrl ?? process.env.RBO_DATA_PLANE_BASE_URL,
    dataDir,
    databasePath: overrides.databasePath ?? join(dataDir, 'controller.db'),
    allowedProjectRoots:
      overrides.allowedProjectRoots ?? parseCsv(process.env.RBO_ALLOWED_PROJECT_ROOTS),
    allowedArtifactDestinations:
      overrides.allowedArtifactDestinations ??
      parseCsv(process.env.RBO_ALLOWED_ARTIFACT_DESTINATIONS),
    gitAllowlist: parseGitAllowlist(overrides.gitAllowlist),
    localExecutor: {
      maxConcurrentJobs:
        overrides.localExecutor?.maxConcurrentJobs ??
        Number(process.env.RBO_LOCAL_MAX_CONCURRENT_JOBS ?? 1),
    },
    disconnectGraceSeconds:
      overrides.disconnectGraceSeconds ?? Number(process.env.RBO_DISCONNECT_GRACE_SECONDS ?? 60),
    orphanTimeoutSeconds:
      overrides.orphanTimeoutSeconds ?? Number(process.env.RBO_ORPHAN_TIMEOUT_SECONDS ?? 300),
    reconcileDeadlineSeconds:
      overrides.reconcileDeadlineSeconds ??
      Number(process.env.RBO_RECONCILE_DEADLINE_SECONDS ?? 120),
    allowLocalFallback:
      overrides.allowLocalFallback ?? process.env.RBO_ALLOW_LOCAL_FALLBACK !== 'false',
    maxGitBundleBytes:
      overrides.maxGitBundleBytes ??
      Number(process.env.RBO_MAX_GIT_BUNDLE_BYTES ?? DEFAULT_MAX_GIT_BUNDLE_BYTES),
  };
}

export function ensureDataDir(config: ControllerConfig): void {
  mkdirSync(config.dataDir, { recursive: true });
}
