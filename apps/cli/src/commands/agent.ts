import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_CONFIG_FILENAME, writeDefaultAgentConfigFile } from '@rbo/agent/config';
import { runAgent } from '@rbo/agent/run';
import { resolveAgentStateDir } from '@rbo/shared';
import { agentLogPath, agentPidPath, spawnDetachedDaemon } from './daemon.js';
import { ensureNotRunningOrReplace, stopRoleForCli } from './process-lifecycle.js';

export interface AgentInitOptions {
  stateDir?: string;
  /** Rewrite `agent.json` even if it already exists. */
  force?: boolean;
}

export interface AgentInitResult {
  stateDir: string;
  initialized_at: string;
  schema_version: number;
  /** Operator config path loaded at runtime (`agent.json`). */
  configPath: string;
  /** Whether init wrote (or rewrote) the operator config. */
  configWritten: boolean;
  /** Present when an existing agent.json was left untouched. */
  hint?: string;
}

export function isAgentInitialized(stateDir: string): boolean {
  return existsSync(join(stateDir, AGENT_CONFIG_FILENAME));
}

export async function runAgentInit(options: AgentInitOptions = {}): Promise<AgentInitResult> {
  const stateDir = options.stateDir ?? resolveAgentStateDir();
  const result = writeDefaultAgentConfigFile(stateDir, { force: options.force });
  return {
    stateDir,
    initialized_at: result.initialized_at,
    schema_version: result.schema_version,
    configPath: result.path,
    configWritten: result.written,
    ...(result.written
      ? {}
      : { hint: 'agent.json already exists; pass --force to rewrite defaults' }),
  };
}

export interface AgentStartOptions {
  stateDir?: string;
  daemon?: boolean;
  /** Restart a live Agent after TTY confirm or when true. */
  replace?: boolean;
  /** CLI script path (`process.argv[1]`) for daemon re-exec. */
  cliScriptPath?: string;
}

function assertAgentInitialized(stateDir: string): void {
  if (!isAgentInitialized(stateDir)) {
    throw new Error('Agent is not initialized. Run `rbo agent init` first.');
  }
}

/** @returns `undefined` when started in foreground, pid when daemon, or `null` when operator declined restart. */
export async function runAgentStart(
  options: AgentStartOptions = {},
): Promise<number | undefined | null> {
  const stateDir = options.stateDir ?? resolveAgentStateDir();
  assertAgentInitialized(stateDir);

  const shouldStart = await ensureNotRunningOrReplace('agent', {
    stateDir,
    replace: options.replace,
  });
  if (!shouldStart) {
    return null;
  }

  if (options.daemon) {
    const cliScript = options.cliScriptPath;
    if (!cliScript) {
      throw new Error('cliScriptPath is required for daemon start');
    }
    const pid = await spawnDetachedDaemon({
      command: process.execPath,
      args: [cliScript, 'agent', 'start', '--state-dir', stateDir],
      pidFile: agentPidPath(stateDir),
      logFile: agentLogPath(stateDir),
      label: 'Agent',
    });
    return pid;
  }

  await runAgent({ stateDir });
}

export async function runAgentStopProcess(options: AgentInitOptions = {}): Promise<{
  stopped: number[];
  alreadyStopped: boolean;
}> {
  const stateDir = options.stateDir ?? resolveAgentStateDir();
  return stopRoleForCli('agent', { stateDir });
}
