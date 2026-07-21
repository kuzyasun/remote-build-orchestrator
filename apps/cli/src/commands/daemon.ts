import { type SpawnOptions, spawn as nodeSpawn } from 'node:child_process';
import { existsSync, openSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function stripDaemonFlag(args: string[]): { daemon: boolean; args: string[] } {
  const daemon = args.includes('--daemon');
  return { daemon, args: args.filter((arg) => arg !== '--daemon') };
}

export function controllerPidPath(dataDir: string): string {
  return join(dataDir, 'run', 'controller.pid');
}

export function controllerLogPath(dataDir: string): string {
  return join(dataDir, 'logs', 'controller.log');
}

export function agentPidPath(stateDir: string): string {
  return join(stateDir, 'run', 'agent.pid');
}

export function agentLogPath(stateDir: string): string {
  return join(stateDir, 'logs', 'agent.log');
}

/** True if `pid` refers to a live process (signal 0 probe). */
export function isProcessAlive(pid: number): boolean {
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
 * If `pidFile` exists and names a live process, throw so `--daemon` cannot
 * stack a second instance on a stale-looking but still-running PID.
 */
export function assertNoLivePid(pidFile: string, label: string): void {
  if (!existsSync(pidFile)) {
    return;
  }
  const raw = readFileSync(pidFile, 'utf8').trim();
  const pid = Number.parseInt(raw, 10);
  if (isProcessAlive(pid)) {
    throw new Error(
      `${label} appears to already be running (pid ${pid} from ${pidFile}). Stop it first.`,
    );
  }
}

export type DetachedSpawn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => {
  pid?: number;
  unref?: () => void;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
};

export interface SpawnDetachedDaemonOptions {
  command: string;
  args: string[];
  pidFile: string;
  logFile: string;
  /** Human label for live-PID conflict errors (e.g. "Controller"). */
  label?: string;
  spawn?: DetachedSpawn;
}

/**
 * Detached child with stdout/stderr redirected to `logFile` and PID persisted.
 * Caller supplies `command` + `args` (typically re-exec of this CLI without `--daemon`).
 * Refuses to start if `pidFile` still points at a live process; rejects on spawn `error`.
 */
export async function spawnDetachedDaemon(options: SpawnDetachedDaemonOptions): Promise<number> {
  const spawn = options.spawn ?? nodeSpawn;
  const label = options.label ?? 'Daemon';
  assertNoLivePid(options.pidFile, label);

  await mkdir(dirname(options.pidFile), { recursive: true });
  await mkdir(dirname(options.logFile), { recursive: true });

  const logFd = openSync(options.logFile, 'a');
  // Keep the FD open for the child's lifetime. The daemon parent exits immediately
  // after spawn, so leaking the handle in the parent is acceptable and safer than
  // closeSync on Windows (which can revoke the child's inherited handle).
  const child = spawn(options.command, options.args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const onError = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    child.on?.('error', onError);
    // Defer success one tick so a synchronous spawn failure can fire `error` first.
    setImmediate(() => {
      if (settled) return;
      settled = true;
      resolve();
    });
  });

  const pid = child.pid;
  if (pid === undefined) {
    throw new Error('Failed to start detached process: no PID assigned');
  }

  await writeFile(options.pidFile, `${pid}\n`, 'utf8');
  child.unref?.();
  return pid;
}
