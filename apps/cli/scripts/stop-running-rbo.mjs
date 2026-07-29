#!/usr/bin/env node
/**
 * preinstall / preuninstall hook for @gemslibe/rbo.
 *
 * Stops running Controller/Agent processes so Windows can replace locked
 * better-sqlite3 native binaries during global `npm install -g` / uninstall.
 *
 * Runs only when npm_config_global=true (skips monorepo/local installs).
 * Escape: RBO_SKIP_INSTALL_STOP=1
 * Policy: warn and continue if a stop fails (do not fail the install).
 * OS services (sc/systemd/launchd) are out of scope.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function shouldSkipInstallStop(env = process.env) {
  if (env.RBO_SKIP_INSTALL_STOP === '1') {
    return true;
  }
  // Only act on global installs. Workspace `pnpm install` / local dependency installs
  // must not kill an operator's running Controller/Agent.
  return env.npm_config_global !== 'true';
}

/**
 * @param {string | undefined | null} commandLine
 * @returns {'controller' | 'agent' | null}
 */
export function matchRboDaemonRole(commandLine) {
  if (!commandLine) {
    return null;
  }
  // Match the bundled CLI entrypoint, not rbo-mcp-stdio.js.
  if (!/(?:^|[\\/\s"'])rbo\.js(?:["']|\s|$)/i.test(commandLine)) {
    return null;
  }
  if (/\bcontroller\s+start\b/i.test(commandLine)) {
    return 'controller';
  }
  if (/\bagent\s+start\b/i.test(commandLine)) {
    return 'agent';
  }
  return null;
}

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv;
 *   home?: string;
 *   dataDir?: string;
 *   stateDir?: string;
 * }} [options]
 * @returns {{ role: 'controller' | 'agent'; path: string }[]}
 */
export function resolveDaemonPidFiles(options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const dataDir = options.dataDir?.trim() || env.RBO_DATA_DIR?.trim() || join(home, '.rbo');
  const agentStateDir =
    options.stateDir?.trim() || env.RBO_AGENT_STATE_DIR?.trim() || join(dataDir, 'agent');
  return [
    { role: 'controller', path: join(dataDir, 'run', 'controller.pid') },
    { role: 'agent', path: join(agentStateDir, 'run', 'agent.pid') },
  ];
}

/**
 * @param {'controller' | 'agent'} role
 * @param {{
 *   env?: NodeJS.ProcessEnv;
 *   home?: string;
 *   dataDir?: string;
 *   stateDir?: string;
 * }} [options]
 */
export function resolveRolePidFile(role, options = {}) {
  const files = resolveDaemonPidFiles(options);
  const match = files.find((entry) => entry.role === role);
  if (!match) {
    throw new Error(`unknown role: ${role}`);
  }
  return match.path;
}

/**
 * Remove a pid file when it is missing a live process (or unreadable).
 * @param {string} pidFile
 * @param {(pid: number) => boolean} isAlive
 * @returns {boolean} true when the file was removed
 */
export function clearStalePidFile(pidFile, isAlive) {
  if (!existsSync(pidFile)) {
    return false;
  }
  let raw;
  try {
    raw = readFileSync(pidFile, 'utf8').trim();
  } catch {
    return false;
  }
  const pid = Number.parseInt(raw, 10);
  if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
    return false;
  }
  try {
    unlinkSync(pidFile);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} pidFile
 * @param {(pid: number) => boolean} isAlive
 * @returns {number | null}
 */
export function readLivePidFromFile(pidFile, isAlive) {
  if (!existsSync(pidFile)) {
    return null;
  }
  let raw;
  try {
    raw = readFileSync(pidFile, 'utf8').trim();
  } catch {
    return null;
  }
  const pid = Number.parseInt(raw, 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  return isAlive(pid) ? pid : null;
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * @returns {Promise<{ pid: number; commandLine: string }[]>}
 */
export async function listNodeProcesses() {
  if (process.platform === 'win32') {
    return listNodeProcessesWindows();
  }
  return listNodeProcessesUnix();
}

function listNodeProcessesWindows() {
  const script =
    'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress';
  let out;
  try {
    out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  const trimmed = out.trim();
  if (!trimmed) {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .map((row) => ({
      pid: Number(row.ProcessId),
      commandLine: typeof row.CommandLine === 'string' ? row.CommandLine : '',
    }))
    .filter((row) => Number.isInteger(row.pid) && row.pid > 0);
}

function listNodeProcessesUnix() {
  let out;
  try {
    out = execFileSync('ps', ['-ax', '-o', 'pid=', '-o', 'args='], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  const rows = [];
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const match = /^(\d+)\s+(.*)$/.exec(trimmed);
    if (!match) {
      continue;
    }
    const pid = Number.parseInt(match[1], 10);
    const commandLine = match[2] ?? '';
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }
    if (!/\bnode(\.exe)?\b/i.test(commandLine) && !commandLine.includes('rbo.js')) {
      continue;
    }
    rows.push({ pid, commandLine });
  }
  return rows;
}

/**
 * Soft then hard stop.
 * @param {number} pid
 * @param {{ platform?: NodeJS.Platform; isAlive?: (pid: number) => boolean; sleepMs?: (ms: number) => Promise<void> }} [options]
 */
export async function stopPid(pid, options = {}) {
  const platform = options.platform ?? process.platform;
  const alive = options.isAlive ?? isProcessAlive;
  const sleepMs = options.sleepMs ?? ((ms) => delay(ms));

  if (platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(pid)], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      // process may already be gone
    }
    await sleepMs(300);
    if (!alive(pid)) {
      return;
    }
    execFileSync('taskkill', ['/F', '/PID', String(pid)], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await sleepMs(100);
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  await sleepMs(500);
  if (!alive(pid)) {
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // gone
  }
}

/**
 * Discover live PIDs for one Controller/Agent role (pid file + process scan).
 * Never includes `selfPid` (defaults to `process.pid`).
 *
 * @param {'controller' | 'agent'} role
 * @param {{
 *   env?: NodeJS.ProcessEnv;
 *   home?: string;
 *   dataDir?: string;
 *   stateDir?: string;
 *   listProcesses?: () => Promise<{ pid: number; commandLine: string }[]>;
 *   isAlive?: (pid: number) => boolean;
 *   selfPid?: number;
 * }} [options]
 * @returns {Promise<number[]>}
 */
export async function findLiveRolePids(role, options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const listProcesses = options.listProcesses ?? listNodeProcesses;
  const alive = options.isAlive ?? isProcessAlive;
  const selfPid = options.selfPid ?? process.pid;
  /** @type {Set<number>} */
  const pids = new Set();

  const pidFile = resolveRolePidFile(role, {
    env,
    home,
    dataDir: options.dataDir,
    stateDir: options.stateDir,
  });
  clearStalePidFile(pidFile, alive);
  const fromFile = readLivePidFromFile(pidFile, alive);
  if (fromFile !== null && fromFile !== selfPid) {
    pids.add(fromFile);
  }

  for (const proc of await listProcesses()) {
    if (proc.pid === selfPid) {
      continue;
    }
    if (matchRboDaemonRole(proc.commandLine) === role) {
      pids.add(proc.pid);
    }
  }

  return [...pids].sort((a, b) => a - b);
}

/**
 * Stop all live processes for one role. Clears the role pid file when no live pid remains.
 *
 * @param {'controller' | 'agent'} role
 * @param {{
 *   env?: NodeJS.ProcessEnv;
 *   home?: string;
 *   dataDir?: string;
 *   stateDir?: string;
 *   listProcesses?: () => Promise<{ pid: number; commandLine: string }[]>;
 *   isAlive?: (pid: number) => boolean;
 *   stopPid?: (pid: number) => Promise<void>;
 *   log?: (msg: string) => void;
 *   warn?: (msg: string) => void;
 *   selfPid?: number;
 *   strict?: boolean;
 * }} [options]
 * @returns {Promise<{ stopped: number[]; alreadyStopped: boolean }>}
 */
export async function stopRoleProcesses(role, options = {}) {
  const alive = options.isAlive ?? isProcessAlive;
  const doStop = options.stopPid ?? ((pid) => stopPid(pid, { isAlive: alive }));
  const log = options.log ?? ((msg) => console.error(`[rbo] ${msg}`));
  const warn = options.warn ?? ((msg) => console.error(`[rbo] ${msg}`));
  const strict = options.strict === true;

  const pids = await findLiveRolePids(role, options);
  const stopped = [];

  for (const pid of pids) {
    try {
      log(`stopping ${role} process pid=${pid}`);
      await doStop(pid);
    } catch (error) {
      const message = `failed to stop pid=${pid} (${role}): ${error instanceof Error ? error.message : String(error)}`;
      if (strict) {
        throw new Error(message);
      }
      warn(`${message}; continuing`);
      continue;
    }
    if (alive(pid)) {
      const message = `failed to stop ${role} pid=${pid}: process still alive`;
      if (strict) {
        throw new Error(message);
      }
      warn(message);
      continue;
    }
    stopped.push(pid);
  }

  clearStalePidFile(resolveRolePidFile(role, options), alive);

  return { stopped, alreadyStopped: pids.length === 0 };
}

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv;
 *   home?: string;
 *   listProcesses?: () => Promise<{ pid: number; commandLine: string }[]>;
 *   isAlive?: (pid: number) => boolean;
 *   stopPid?: (pid: number) => Promise<void>;
 *   log?: (msg: string) => void;
 *   warn?: (msg: string) => void;
 *   extraPids?: number[];
 * }} [options]
 */
export async function stopRunningRbo(options = {}) {
  const env = options.env ?? process.env;
  if (shouldSkipInstallStop(env)) {
    return;
  }

  const home = options.home ?? homedir();
  const listProcesses = options.listProcesses ?? listNodeProcesses;
  const alive = options.isAlive ?? isProcessAlive;
  const doStop = options.stopPid ?? ((pid) => stopPid(pid, { isAlive: alive }));
  const log = options.log ?? ((msg) => console.error(`[rbo] ${msg}`));
  const warn = options.warn ?? ((msg) => console.error(`[rbo] ${msg}`));

  /** @type {Map<number, string>} */
  const targets = new Map();

  for (const { role, path } of resolveDaemonPidFiles({ env, home })) {
    clearStalePidFile(path, alive);
    const pid = readLivePidFromFile(path, alive);
    if (pid !== null) {
      targets.set(pid, role);
    }
  }

  for (const proc of await listProcesses()) {
    if (proc.pid === process.pid) {
      continue;
    }
    const role = matchRboDaemonRole(proc.commandLine);
    if (role) {
      targets.set(proc.pid, role);
    }
  }

  for (const pid of options.extraPids ?? []) {
    if (!targets.has(pid)) {
      targets.set(pid, 'unknown');
    }
  }

  for (const [pid, role] of targets) {
    try {
      log(`stopping ${role} process pid=${pid} for package install/uninstall`);
      await doStop(pid);
    } catch (error) {
      warn(
        `failed to stop pid=${pid} (${role}): ${error instanceof Error ? error.message : String(error)}; continuing`,
      );
    }
  }
}

const isMain =
  typeof process.argv[1] === 'string' &&
  (process.argv[1].endsWith('stop-running-rbo.mjs') ||
    process.argv[1].replaceAll('\\', '/').endsWith('/scripts/stop-running-rbo.mjs'));

if (isMain) {
  stopRunningRbo().catch((error) => {
    console.error(
      `[rbo] stop-running-rbo failed: ${error instanceof Error ? error.message : String(error)}; continuing`,
    );
    // Never fail install/uninstall because of the stop helper.
    process.exitCode = 0;
  });
}
