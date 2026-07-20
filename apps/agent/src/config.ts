import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AgentConfig {
  controllerUrl: string;
  controllerFingerprint: string;
  displayName: string;
  maxJobs: number;
  stateDir: string;
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
  };
}

export function ensureStateDir(config: AgentConfig): void {
  mkdirSync(config.stateDir, { recursive: true });
}
