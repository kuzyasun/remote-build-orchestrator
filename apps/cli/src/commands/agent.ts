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
  /** Custom input stream for testing interactive selection. */
  input?: NodeJS.ReadableStream;
  /** Custom output stream for testing interactive selection. */
  output?: NodeJS.WritableStream;
  /** TTY override for testing interactive selection. */
  isTTY?: boolean;
  /** Optional cancellation signal. */
  signal?: AbortSignal;
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
 * Prioritizes the responder address that actually delivered the advertisement packet
 * (when routable IPv4), then private LAN IPv4 (192.168.x.x, 10.x.x.x, 172.16-31.x.x),
 * avoids APIPA (169.254.x.x) and loopback, and handles IPv6 cleanly.
 */
export function selectBestAddress(
  addresses: string[],
  fallbackHost: string,
  responderAddress?: string,
): string {
  const normalizedResponder = responderAddress?.replace(/^::ffff:/i, '');

  // Filter out loopback and link-local (APIPA / fe80)
  const isLoopbackOrLinkLocal = (a: string) =>
    a === '0.0.0.0' ||
    a === '::' ||
    a.startsWith('127.') ||
    a === '::1' ||
    a.startsWith('169.254.') ||
    a.toLowerCase().startsWith('fe80:');

  // If the packet's responder IP is a routable address (IPv4 or non-link-local IPv6),
  // prefer it above all else: it came over the physical interface that delivered the mDNS packet.
  // Loopback (127.*, ::1) and link-local (169.254.*, fe80:*) are excluded because
  // fe80 requires a zone index not provided by mDNS referer.
  if (normalizedResponder && !isLoopbackOrLinkLocal(normalizedResponder)) {
    return normalizedResponder;
  }

  if (!addresses || addresses.length === 0) {
    return fallbackHost;
  }

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

/** Strip or escape ANSI control sequences and control characters for terminal safety. */
export function sanitizeTerminalOutput(str: string): string {
  if (typeof str !== 'string') return '';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional terminal CSI escape sequence sanitization
  const noCsi = str.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional terminal OSC escape sequence sanitization
  const noAnsi = noCsi.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, '');
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional terminal control character replacement
  return noAnsi.replace(/[\x00-\x1f\x7f-\x9f]/g, '?');
}

/**
 * Format the interactive controller selection list. Returns lines to print.
 */
export function formatControllerList(controllers: DiscoveredController[]): string {
  const lines: string[] = [];
  for (let i = 0; i < controllers.length; i++) {
    const c = controllers[i];
    const rawAddr = selectBestAddress(c.addresses, c.host, c.responderAddress);
    const safeAddr = sanitizeTerminalOutput(rawAddr);
    const displayAddr =
      safeAddr.includes(':') && !safeAddr.startsWith('[') ? `[${safeAddr}]` : safeAddr;
    const safeName = sanitizeTerminalOutput(c.name);
    const safeId = sanitizeTerminalOutput(c.controllerId);
    const safeFp = sanitizeTerminalOutput(c.fingerprint);
    lines.push(`  ${i + 1}) ${safeName} (${displayAddr}:${c.port})`);
    lines.push(`     ${safeId}  fingerprint: ${safeFp}`);
  }
  lines.push('  0) Skip — configure manually later');
  return lines.join('\n');
}

export interface PromptControllerOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  isTTY?: boolean;
  signal?: AbortSignal;
}

/**
 * Prompt the user to select a controller from the discovered list.
 * Returns the selected controller, or `null` if explicitly skipped (0) or non-TTY.
 * Throws if cancelled/aborted (e.g. SIGINT or uncorrected invalid input) so initialization aborts without writing config.
 */
export async function promptControllerSelection(
  controllers: DiscoveredController[],
  options: PromptControllerOptions = {},
): Promise<DiscoveredController | null> {
  console.error(`\nFound ${controllers.length} controller(s):`);
  console.error(formatControllerList(controllers));
  console.error(
    '\nWarning: On an untrusted or shared network, verify the fingerprint matches `rbo controller fingerprint` on the Controller before connecting.',
  );

  const isTTY =
    options.isTTY ??
    Boolean((options.input as { isTTY?: boolean } | undefined)?.isTTY ?? process.stdin.isTTY);

  if (!isTTY) {
    console.error(
      '\nNon-interactive terminal detected. Edit agent.json manually or set RBO_CONTROLLER_URL.',
    );
    return null;
  }

  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (options.signal) {
    if (options.signal.aborted) {
      ac.abort();
    } else {
      options.signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  const rl = createInterface({
    input: options.input ?? process.stdin,
    output: options.output ?? process.stderr,
  });
  rl.on('SIGINT', onAbort);

  const onSigint = () => ac.abort();
  const customInput =
    options.input && options.input !== process.stdin
      ? (options.input as NodeJS.EventEmitter)
      : null;
  if (customInput) {
    customInput.on('SIGINT', onSigint);
  }

  try {
    const max = controllers.length;
    const maxRetries = 10;
    let attempts = 0;
    while (!ac.signal.aborted && attempts < maxRetries) {
      attempts += 1;
      const answer = await rl.question(`\nSelect controller [1-${max}, 0 to skip]: `, {
        signal: ac.signal,
      });
      const trimmed = answer.trim();
      if (!/^\d+$/.test(trimmed)) {
        console.error(
          `Invalid selection "${sanitizeTerminalOutput(trimmed)}". Enter a number from 1 to ${max}, or 0 to skip.`,
        );
        continue;
      }
      const num = Number.parseInt(trimmed, 10);
      if (num < 0 || num > max) {
        console.error(
          `Selection ${num} is out of range. Enter a number from 1 to ${max}, or 0 to skip.`,
        );
        continue;
      }
      if (num === 0) {
        return null;
      }
      return controllers[num - 1];
    }
    throw new Error('Invalid selection — aborted without writing configuration.');
  } catch (error) {
    if (
      ac.signal.aborted ||
      options.signal?.aborted ||
      (error instanceof Error && (error.name === 'AbortError' || error.message === 'SIGINT'))
    ) {
      throw new Error('Controller selection cancelled by operator');
    }
    if (error instanceof Error && error.message.includes('readline was closed')) {
      throw new Error('Invalid selection — aborted without writing configuration.');
    }
    throw error;
  } finally {
    rl.close();
    if (options.signal) {
      options.signal.removeEventListener('abort', onAbort);
    }
    if (customInput) {
      customInput.off('SIGINT', onSigint);
    }
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
    const controllers = await discoverControllers({ signal: options.signal });

    if (controllers.length === 0) {
      console.error(
        'No controllers found on local network. Edit agent.json manually or set RBO_CONTROLLER_URL.',
      );
    } else {
      selectedController = await promptControllerSelection(controllers, {
        input: options.input,
        output: options.output,
        isTTY: options.isTTY,
        signal: options.signal,
      });
      if (selectedController) {
        const rawAddr = selectBestAddress(
          selectedController.addresses,
          selectedController.host,
          selectedController.responderAddress,
        );
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
