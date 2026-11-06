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
  off?: (event: string, listener: (...args: unknown[]) => void) => void;
  connected?: boolean;
  disconnect?: () => void;
};

export interface SpawnDetachedDaemonOptions {
  command: string;
  args: string[];
  pidFile: string;
  logFile: string;
  /** Human label for live-PID conflict errors (e.g. "Controller"). */
  label?: string;
  spawn?: DetachedSpawn;
  /** Wait for this private IPC message from the newly spawned process. */
  readyMessage?: string;
  readyTimeoutMs?: number;
}

export function isDaemonChild(): boolean {
  return process.connected === true && process.env.RBO_DAEMON_PARENT_PID === String(process.ppid);
}

function waitForReady(
  child: ReturnType<DetachedSpawn>,
  options: SpawnDetachedDaemonOptions,
): { promise: Promise<void>; cancel: () => void } {
  let cancel = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    const timeoutMs = options.readyTimeoutMs ?? 60_000;
    const finish = (error?: Error) => {
      clearTimeout(timer);
      for (const [event, listener] of listeners) child.off?.(event, listener);
      if (error) reject(error);
      else resolve();
    };
    cancel = () => finish();
    const failure = (detail: string) =>
      new Error(
        `${options.label ?? 'Daemon'} ${detail}. See ${options.logFile} (pid ${child.pid})`,
      );
    const listeners: Array<[string, (...args: unknown[]) => void]> = [
      [
        'message',
        (message) => {
          if (message === options.readyMessage) finish();
        },
      ],
      ['error', (error) => finish(failure(`failed to start: ${String(error)}`))],
      [
        'exit',
        (code, signal) =>
          finish(failure(`exited before readiness (code ${code}, signal ${signal})`)),
      ],
      ['disconnect', () => finish(failure('disconnected before readiness'))],
    ];
    const timer = setTimeout(
      () => finish(failure(`did not become ready within ${timeoutMs}ms; it may still be starting`)),
      timeoutMs,
    );
    for (const [event, listener] of listeners) child.on?.(event, listener);
  });
  return { promise, cancel };
}

/**
 * Detached child with stdout/stderr redirected to `logFile` and PID persisted.
 * Caller supplies `command` + `args` (typically re-exec of this CLI without `--daemon`).
 * Refuses to start if `pidFile` still points at a live process; rejects on spawn `error`.
 * With `readyMessage`, returns only after the child signals readiness over private IPC.
 */
export async function spawnDetachedDaemon(options: SpawnDetachedDaemonOptions): Promise<number> {
  const spawn = options.spawn ?? nodeSpawn;
  const label = options.label ?? 'Daemon';
  assertNoLivePid(options.pidFile, label);

  await mkdir(dirname(options.pidFile), { recursive: true });
  await mkdir(dirname(options.logFile), { recursive: true });

  const logFd = openSync(options.logFile, 'a');
  // Keep the FD open until the launcher exits (after readiness, when requested).
  // Retaining the handle is safer than
  // closeSync on Windows (which can revoke the child's inherited handle).
  const child = spawn(options.command, options.args, {
    detached: true,
    stdio: options.readyMessage ? ['ignore', logFd, logFd, 'ipc'] : ['ignore', logFd, logFd],
    ...(options.readyMessage
      ? { env: { ...process.env, RBO_DAEMON_PARENT_PID: String(process.pid) } }
      : {}),
  });

  // Subscribe before yielding: even an immediately ready/failed child must be observed.
  const ready = options.readyMessage ? waitForReady(child, options) : undefined;
  void ready?.promise.catch(() => {});

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onError = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(
          options.readyMessage
            ? new Error(`${label} failed to spawn: ${String(error)}. See ${options.logFile}`)
            : error instanceof Error
              ? error
              : new Error(String(error)),
        );
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
    await ready?.promise;
    return pid;
  } finally {
    ready?.cancel();
    child.unref?.();
    if (child.connected) child.disconnect?.();
  }
}
