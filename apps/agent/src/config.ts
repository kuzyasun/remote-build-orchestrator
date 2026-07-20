import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AgentConfig {
  controllerUrl: string;
  controllerFingerprint: string;
  displayName: string;
  maxJobs: number;
  stateDir: string;
  /** Maps store ref name → environment variable that holds the secret value. */
  secretMap?: Record<string, string>;
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
  };
}

export function ensureStateDir(config: AgentConfig): void {
  mkdirSync(config.stateDir, { recursive: true });
}
