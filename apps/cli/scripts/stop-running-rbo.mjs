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
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
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
  const match = /(?:^|[\\/\s"'])rbo\.js["']?\s+(controller|agent)\s+start(?:\s|$)/i.exec(
    commandLine,
  );
  return match?.[1].toLowerCase() === 'controller' ? 'controller' : match ? 'agent' : null;
}

/** @param {string} commandLine @param {'controller' | 'agent'} role */
function matchesRegisteredCommand(commandLine, role) {
  // Unix npm bins can run the entrypoint through the symlink named "rbo".
  const match = /(?:^|[\\/\s"'])rbo(?:\.js)?["']?\s+(controller|agent)(?:\s|$)/i.exec(commandLine);
  return match?.[1].toLowerCase() === role;
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
  const dataDir = physicalPath(
    options.dataDir?.trim() || env.RBO_DATA_DIR?.trim() || join(home, '.rbo'),
  );
  const agentStateDir = physicalPath(
    options.stateDir?.trim() || env.RBO_AGENT_STATE_DIR?.trim() || join(dataDir, 'agent'),
  );
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
 * A foreground instance records its own scope. Keep these registrations
 * separate from the launcher's numeric PID file used during daemon startup.
 *
 * @param {'controller' | 'agent'} role
 * @param {Parameters<typeof resolveRolePidFile>[1] & {
 *   listProcesses?: () => Promise<ProcessIdentity[]>;
 * }} [options]
 * @returns {Promise<() => void>}
 */
export async function registerRoleInstance(role, options = {}) {
  const listProcesses = options.listProcesses ?? listNodeProcesses;
  const current = (await listProcesses()).find((proc) => proc.pid === process.pid);
  if (!current?.startedAt || !matchesRegisteredCommand(current.commandLine, role)) return () => {};

  const pidFile = resolve(resolveRolePidFile(role, options));
  const path = instancePath(pidFile, current.pid);
  const candidate = `${path}.${randomUUID()}.tmp`;
  const record = JSON.stringify({
    pid: current.pid,
    startedAt: current.startedAt,
    commandHash: hashCommandLine(current.commandLine),
    directory: pathKey(dirname(dirname(pidFile))),
  });
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(candidate, record, { flag: 'wx', mode: 0o600 });
    renameSync(candidate, path);
  } catch (error) {
    removeFile(candidate);
    throw error;
  }
  return () => removeFile(path);
}

/** @param {string} pidFile @param {number} pid */
function instancePath(pidFile, pid) {
  return `${pidFile}.${pid}.instance`;
}

/** @param {string} commandLine */
function hashCommandLine(commandLine) {
  return createHash('sha256').update(commandLine).digest('hex');
}

/** @param {string} path */
function removeFile(path) {
  try {
    unlinkSync(path);
  } catch {
    // Another lifecycle operation or a manual cleanup already removed it.
  }
}

/** @param {string} pidFile @param {ProcessIdentity} proc @param {string} targetDir */
function matchesRoleInstance(pidFile, proc, targetDir) {
  if (!proc.startedAt) return false;
  try {
    const record = JSON.parse(readFileSync(instancePath(pidFile, proc.pid), 'utf8'));
    return (
      record?.pid === proc.pid &&
      record.startedAt === proc.startedAt &&
      record.commandHash === hashCommandLine(proc.commandLine) &&
      record.directory === pathKey(targetDir)
    );
  } catch {
    return false;
  }
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
 * @typedef {{ pid: number; commandLine: string; startedAt?: string }} ProcessIdentity
 */

/**
 * @returns {Promise<ProcessIdentity[]>}
 */
export async function listNodeProcesses() {
  if (process.platform === 'win32') {
    return listNodeProcessesWindows();
  }
  return listNodeProcessesUnix();
}

function listNodeProcessesWindows() {
  const script =
    'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Select-Object ProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress';
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
      startedAt: typeof row.CreationDate === 'string' ? row.CreationDate : undefined,
    }))
    .filter((row) => Number.isInteger(row.pid) && row.pid > 0 && row.startedAt);
}

function listNodeProcessesUnix() {
  let out;
  let bootId;
  try {
    if (process.platform === 'linux') {
      bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      if (!bootId) return [];
    }
    out = execFileSync('ps', ['-ax', '-o', 'pid=', '-o', 'lstart=', '-o', 'args='], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
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
    const match = /^(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.*)$/.exec(trimmed);
    if (!match) {
      continue;
    }
    const pid = Number.parseInt(match[1], 10);
    const commandLine = match[3] ?? '';
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }
    if (!/\bnode(\.exe)?\b/i.test(commandLine) && !commandLine.includes('rbo.js')) {
      continue;
    }
    const ticks = bootId ? linuxProcessStartTicks(pid) : undefined;
    const startedAt = bootId ? ticks && `${bootId}:${ticks}` : match[2];
    if (startedAt) rows.push({ pid, commandLine, startedAt });
  }
  return rows;
}

/** @param {number} pid */
function linuxProcessStartTicks(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const closeParen = stat.lastIndexOf(')');
    const ticks = closeParen >= 0 && stat.slice(closeParen + 2).split(' ')[19];
    return ticks && /^\d+$/.test(ticks) ? ticks : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Soft then hard stop.
 * @param {number} pid
 * @param {{ platform?: NodeJS.Platform; isAlive?: (pid: number) => boolean; isCurrent?: () => Promise<boolean>; sleepMs?: (ms: number) => Promise<void> }} [options]
 */
export async function stopPid(pid, options = {}) {
  const platform = options.platform ?? process.platform;
  const alive = options.isAlive ?? isProcessAlive;
  const isCurrent = options.isCurrent ?? (async () => alive(pid));
  const sleepMs = options.sleepMs ?? ((ms) => delay(ms));
  if (!(await isCurrent())) return;

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
    if (!(await isCurrent())) {
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
  if (!(await isCurrent())) {
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return;
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleepMs(100);
    if (!alive(pid)) {
      return;
    }
  }
}

/**
 * Discover live processes for the selected Controller/Agent data directory.
 * Never includes `selfPid` (defaults to `process.pid`).
 *
 * @param {'controller' | 'agent'} role
 * @param {{
 *   env?: NodeJS.ProcessEnv;
 *   home?: string;
 *   dataDir?: string;
 *   stateDir?: string;
 *   listProcesses?: () => Promise<ProcessIdentity[]>;
 *   isAlive?: (pid: number) => boolean;
 *   selfPid?: number;
 * }} [options]
 * @returns {Promise<ProcessIdentity[]>}
 */
async function findLiveRoleProcesses(role, options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const listProcesses = options.listProcesses ?? listNodeProcesses;
  const alive = options.isAlive ?? isProcessAlive;
  const selfPid = options.selfPid ?? process.pid;
  const pidFile = resolveRolePidFile(role, {
    env,
    home,
    dataDir: options.dataDir,
    stateDir: options.stateDir,
  });
  clearStalePidFile(pidFile, alive);
  const targetDir = dirname(dirname(pidFile));
  const flag = role === 'controller' ? '--data-dir' : '--state-dir';
  const directoryPattern = new RegExp(
    `(?:^|\\s)${flag}\\s+(?:"([^"]+)"|'([^']+)'|(.+?)(?=\\s+--[\\w-]+(?:[=\\s]|$)|$))`,
    'g',
  );

  const processes = await listProcesses();
  return processes.filter((proc) => {
    if (proc.pid === selfPid || !alive(proc.pid)) {
      return false;
    }
    if (
      matchesRegisteredCommand(proc.commandLine, role) &&
      matchesRoleInstance(pidFile, proc, targetDir)
    ) {
      return true;
    }
    if (
      matchRboDaemonRole(proc.commandLine) !== role ||
      /(?:^|\s)--daemon(?:\s|$)/.test(proc.commandLine)
    ) {
      return false;
    }

    // A legacy command line with an explicit absolute directory establishes
    // scope. Relative paths and unflagged launches need their own record.
    const directories = [...proc.commandLine.matchAll(directoryPattern)];
    if (directories.length !== 1) return false;
    const [directory] = directories;
    const configuredDir = directory?.[1] ?? directory?.[2] ?? directory?.[3];
    return (
      configuredDir !== undefined &&
      isAbsolute(configuredDir) &&
      pathKey(configuredDir) === pathKey(targetDir)
    );
  });
}

/** @param {string} path */
function pathKey(path) {
  const physical = physicalPath(path);
  try {
    const info = statSync(physical, { bigint: true });
    if (info.isDirectory() && info.ino !== 0n) {
      return `directory:${info.dev}:${info.ino}`;
    }
  } catch {
    // Fall back to the canonical or lexical path below.
  }
  return process.platform === 'win32' ? physical.toLowerCase() : physical;
}

/** @param {string} path */
function physicalPath(path) {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    // Keep a lexical key for paths that do not exist yet. Existing aliases
    // resolve to the same physical directory before they are compared.
    return absolute;
  }
}

/**
 * @param {ProcessIdentity} expected
 * @param {() => Promise<ProcessIdentity[]>} listProcesses
 * @param {(pid: number) => boolean} alive
 */
function currentProcessCheck(expected, listProcesses, alive) {
  return async () => {
    if (!alive(expected.pid)) return false;
    const actual = (await listProcesses()).find((proc) => proc.pid === expected.pid);
    return actual?.commandLine === expected.commandLine && actual.startedAt === expected.startedAt;
  };
}

/**
 * @param {'controller' | 'agent'} role
 * @param {Parameters<typeof findLiveRoleProcesses>[1]} [options]
 */
export async function findLiveRolePids(role, options) {
  return (await findLiveRoleProcesses(role, options)).map((proc) => proc.pid).sort((a, b) => a - b);
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
 *   listProcesses?: () => Promise<ProcessIdentity[]>;
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
  const listProcesses = options.listProcesses ?? listNodeProcesses;
  const log = options.log ?? ((msg) => console.error(`[rbo] ${msg}`));
  const warn = options.warn ?? ((msg) => console.error(`[rbo] ${msg}`));
  const strict = options.strict === true;

  const targets = (await findLiveRoleProcesses(role, options)).sort((a, b) => a.pid - b.pid);
  const stopped = [];

  for (const target of targets) {
    const { pid } = target;
    const isCurrent = currentProcessCheck(target, listProcesses, alive);
    if (!(await isCurrent())) continue;
    try {
      log(`stopping ${role} process pid=${pid}`);
      if (options.stopPid) await options.stopPid(pid);
      else await stopPid(pid, { isAlive: alive, isCurrent });
    } catch (error) {
      const message = `failed to stop pid=${pid} (${role}): ${error instanceof Error ? error.message : String(error)}`;
      if (strict) {
        throw new Error(message);
      }
      warn(`${message}; continuing`);
      continue;
    }
    if (await isCurrent()) {
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

  return { stopped, alreadyStopped: targets.length === 0 };
}

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv;
 *   home?: string;
 *   listProcesses?: () => Promise<ProcessIdentity[]>;
 *   isAlive?: (pid: number) => boolean;
 *   stopPid?: (pid: number) => Promise<void>;
 *   log?: (msg: string) => void;
 *   warn?: (msg: string) => void;
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
  const log = options.log ?? ((msg) => console.error(`[rbo] ${msg}`));
  const warn = options.warn ?? ((msg) => console.error(`[rbo] ${msg}`));

  for (const { path } of resolveDaemonPidFiles({ env, home })) {
    clearStalePidFile(path, alive);
  }

  for (const target of await listProcesses()) {
    const { pid, commandLine } = target;
    const role = matchRboDaemonRole(commandLine);
    if (pid === process.pid || !role) continue;
    const isCurrent = currentProcessCheck(target, listProcesses, alive);
    try {
      if (!(await isCurrent())) continue;
      log(`stopping ${role} process pid=${pid} for package install/uninstall`);
      if (options.stopPid) await options.stopPid(pid);
      else await stopPid(pid, { isAlive: alive, isCurrent });
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
