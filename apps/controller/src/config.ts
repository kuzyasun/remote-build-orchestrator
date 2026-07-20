import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
  localExecutor: LocalExecutorConfig;
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
    allowedProjectRoots: overrides.allowedProjectRoots ?? [],
    allowedArtifactDestinations: overrides.allowedArtifactDestinations ?? [],
    localExecutor: {
      maxConcurrentJobs:
        overrides.localExecutor?.maxConcurrentJobs ??
        Number(process.env.RBO_LOCAL_MAX_CONCURRENT_JOBS ?? 1),
    },
  };
}

export function ensureDataDir(config: ControllerConfig): void {
  mkdirSync(config.dataDir, { recursive: true });
}
