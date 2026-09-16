import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  AGENT_CONFIG_FILENAME,
  type AgentDiscoveryResult,
  writeDefaultAgentConfigFile,
} from '@rbo/agent/config';
import { runAgent } from '@rbo/agent/run';
import { type DiscoveredController, discoverControllers } from '@rbo/discovery';
import { resolveAgentStateDir } from '@rbo/shared';
import { agentLogPath, agentPidPath, spawnDetachedDaemon } from './daemon.js';
import { ensureNotRunningOrReplace, stopRoleForCli } from './process-lifecycle.js';

export interface AgentInitOptions {
  stateDir?: string;
  /** Rewrite `agent.json` even if it already exists. */
  force?: boolean;
  /** Skip mDNS discovery (for programmatic / test use). */
  skipDiscovery?: boolean;
}

export interface AgentInitResult {
  stateDir: string;
  initialized_at: string;
  schema_version: number;
  /** Operator config path loaded at runtime (`agent.json`). */
  configPath: string;
  /** Whether init wrote (or rewrote) the operator config. */
  configWritten: boolean;
  /** Whether a controller was discovered and selected. */
  discovered?: boolean;
  /** Display name of the discovered controller, if any. */
  controllerName?: string;
  /** Present when an existing agent.json was left untouched. */
  hint?: string;
}

export function isAgentInitialized(stateDir: string): boolean {
  return existsSync(join(stateDir, AGENT_CONFIG_FILENAME));
}

/**
 * Select the best routable IP address from discovered addresses.
 * Prioritizes private LAN IPv4 (192.168.x.x, 10.x.x.x, 172.16-31.x.x),
 * avoids APIPA (169.254.x.x) and loopback, and handles IPv6 cleanly.
 */
export function selectBestAddress(addresses: string[], fallbackHost: string): string {
  if (!addresses || addresses.length === 0) {
    return fallbackHost;
  }

  // Filter out loopback and link-local (APIPA)
  const isLoopbackOrLinkLocal = (a: string) =>
    a === '127.0.0.1' ||
    a === '::1' ||
    a.startsWith('169.254.') ||
    a.toLowerCase().startsWith('fe80:');

  const routable = addresses.filter((a) => !isLoopbackOrLinkLocal(a));
  if (routable.length === 0) {
    return fallbackHost;
  }

  // 1. Home / Office LAN (192.168.x.x)
  const lan192 = routable.find((a) => a.startsWith('192.168.'));
  if (lan192) return lan192;

  // 2. Class A LAN (10.x.x.x)
  const lan10 = routable.find((a) => a.startsWith('10.'));
  if (lan10) return lan10;

  // 3. Class B LAN (172.16.x.x - 172.31.x.x, avoid 172.17.0.1 docker0 if another exists)
  const lan172 = routable.filter((a) => /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(a));
  const nonDocker172 = lan172.find((a) => a !== '172.17.0.1');
  if (nonDocker172) return nonDocker172;
  if (lan172.length > 0) return lan172[0];

  // 4. Any IPv4 address
  const anyIpv4 = routable.find((a) => !a.includes(':'));
  if (anyIpv4) return anyIpv4;

  // 5. Any routable IPv6 or fallback
  return routable[0] ?? fallbackHost;
}

/**
 * Format the interactive controller selection list. Returns lines to print.
 */
export function formatControllerList(controllers: DiscoveredController[]): string {
  const lines: string[] = [];
  for (let i = 0; i < controllers.length; i++) {
    const c = controllers[i];
    const rawAddr = selectBestAddress(c.addresses, c.host);
    const displayAddr =
      rawAddr.includes(':') && !rawAddr.startsWith('[') ? `[${rawAddr}]` : rawAddr;
    lines.push(`  ${i + 1}) ${c.name} (${displayAddr}:${c.port})`);
    lines.push(`     ${c.controllerId}  fingerprint: ${c.fingerprint}`);
  }
  lines.push('  0) Skip — configure manually later');
  return lines.join('\n');
}

/**
 * Prompt the user to select a controller from the discovered list.
 * Returns the selected controller, or `null` if skipped / non-TTY.
 */
async function promptControllerSelection(
  controllers: DiscoveredController[],
): Promise<DiscoveredController | null> {
  console.error(`\nFound ${controllers.length} controller(s):`);
  console.error(formatControllerList(controllers));

  if (!process.stdin.isTTY) {
    console.error(
      '\nNon-interactive terminal detected. Edit agent.json manually or set RBO_CONTROLLER_URL.',
    );
    return null;
  }

  const ac = new AbortController();
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  rl.on('SIGINT', () => {
    ac.abort();
  });
  try {
    const max = controllers.length;
    const answer = await rl.question(`\nSelect controller [1-${max}, 0 to skip]: `, {
      signal: ac.signal,
    });
    const num = Number.parseInt(answer.trim(), 10);
    if (Number.isNaN(num) || num < 0 || num > max) {
      console.error('Invalid selection — skipping.');
      return null;
    }
    if (num === 0) {
      return null;
    }
    return controllers[num - 1];
  } catch {
    return null;
  } finally {
    rl.close();
  }
}

export async function runAgentInit(options: AgentInitOptions = {}): Promise<AgentInitResult> {
  const stateDir = options.stateDir ?? resolveAgentStateDir();
  const configPath = join(stateDir, AGENT_CONFIG_FILENAME);

  let existingInitializedAt: string | undefined;
  let existingSchemaVersion = 1;
  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as {
        initialized_at?: string;
        schema_version?: number;
      };
      if (typeof parsed.initialized_at === 'string') {
        existingInitializedAt = parsed.initialized_at;
      }
      if (typeof parsed.schema_version === 'number') {
        existingSchemaVersion = parsed.schema_version;
      }
    } catch {
      // Use defaults if unparseable
    }
  }

  // Guard: if config exists and --force is not specified, do not overwrite or scan.
  if (existsSync(configPath) && !options.force) {
    return {
      stateDir,
      initialized_at: existingInitializedAt ?? new Date().toISOString(),
      schema_version: existingSchemaVersion,
      configPath,
      configWritten: false,
      hint: 'agent.json already exists; pass --force to rewrite defaults',
    };
  }

  let discovery: AgentDiscoveryResult | undefined;
  let selectedController: DiscoveredController | null = null;

  if (!options.skipDiscovery) {
    console.error('Scanning for RBO controllers on local network...');
    const controllers = await discoverControllers();

    if (controllers.length === 0) {
      console.error(
        'No controllers found on local network. Edit agent.json manually or set RBO_CONTROLLER_URL.',
      );
    } else {
      selectedController = await promptControllerSelection(controllers);
      if (selectedController) {
        const rawAddr = selectBestAddress(selectedController.addresses, selectedController.host);
        const hostPart =
          rawAddr.includes(':') && !rawAddr.startsWith('[') ? `[${rawAddr}]` : rawAddr;
        discovery = {
          controllerUrl: `wss://${hostPart}:${selectedController.port}/agent`,
          controllerFingerprint: selectedController.fingerprint,
        };
      }
    }
  }

  // Write agent.json ONCE with final config
  const result = writeDefaultAgentConfigFile(stateDir, {
    force: options.force,
    initializedAt: existingInitializedAt,
    discovery,
  });

  if (selectedController && discovery) {
    console.error(
      `\nConfigured controller: ${selectedController.name} (${discovery.controllerUrl})`,
    );
    console.error('Run `rbo agent start` to connect and begin pairing.');
  }

  return {
    stateDir,
    initialized_at: result.initialized_at,
    schema_version: result.schema_version,
    configPath: result.path,
    configWritten: result.written,
    discovered: selectedController ? true : undefined,
    controllerName: selectedController?.name,
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
