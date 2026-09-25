import { homedir as osHomedir } from 'node:os';
import { join } from 'node:path';

export interface RboLayoutOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
}

function resolveHome(options?: RboLayoutOptions): string {
  return options?.home ?? osHomedir();
}

function resolveEnv(options?: RboLayoutOptions): NodeJS.ProcessEnv {
  return options?.env ?? process.env;
}

export function resolveDefaultRboRoot(options?: RboLayoutOptions): string {
  return join(resolveHome(options), '.rbo');
}

export function resolveControllerDataDir(options?: RboLayoutOptions): string {
  const dataDir = resolveEnv(options).RBO_DATA_DIR?.trim();
  if (dataDir) {
    return dataDir;
  }
  return resolveDefaultRboRoot(options);
}

export function resolveAgentStateDir(options?: RboLayoutOptions): string {
  const agentStateDir = resolveEnv(options).RBO_AGENT_STATE_DIR?.trim();
  if (agentStateDir) {
    return agentStateDir;
  }
  return join(resolveControllerDataDir(options), 'agent');
}

/** Live connection snapshot written by the agent process and read by `rbo agent status`. */
export function agentRuntimeStatusPath(stateDir: string): string {
  return join(stateDir, 'run', 'agent-status.json');
}
