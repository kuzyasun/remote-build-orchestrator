import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ControllerConfig {
  mcpHost: string;
  mcpPort: number;
  agentPlanePort: number;
  dataDir: string;
  databasePath: string;
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
    dataDir,
    databasePath: overrides.databasePath ?? join(dataDir, 'controller.db'),
  };
}

export function ensureDataDir(config: ControllerConfig): void {
  mkdirSync(config.dataDir, { recursive: true });
}
