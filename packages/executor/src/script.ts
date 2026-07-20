import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ExecutionConfig } from '@rbo/protocol';
import { RboError } from '@rbo/shared';
import type { AttemptLogPaths } from './logs.js';
import { appendStderr, appendStdout } from './logs.js';
import { WindowsHelperFrameReader } from './windows-frames.js';

const execFileAsync = promisify(execFile);

/**
 * ChildProcess-like EventEmitter façade shared by Unix spawn and Windows
 * helper frame-reader adapters (§0.1 rule 10 / Phase 3 pin).
 */
export class ManagedChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid: number;
  private readonly waitForExitImpl: () => Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>;
  private readonly killImpl: (graceSeconds: number) => Promise<void>;

  constructor(input: {
    pid: number;
    waitForExit: () => Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
    kill: (graceSeconds: number) => Promise<void>;
  }) {
    super();
    this.pid = input.pid;
    this.waitForExitImpl = input.waitForExit;
    this.killImpl = input.kill;
  }

  waitForExit(): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
    return this.waitForExitImpl();
  }

  kill(graceSeconds = 10): Promise<void> {
    return this.killImpl(graceSeconds);
  }
}

export type RunningProcess = ManagedChildProcess;

/** Phase 3 implements bash/powershell/direct; remaining shells are a documented gap. */
export const PHASE3_UNSUPPORTED_SHELLS = ['sh', 'zsh', 'cmd', 'pwsh'] as const;

function resolveShellCommand(shell: ExecutionConfig['shell']): { command: string; args: string[] } {
  switch (shell) {
    case 'bash':
      return { command: 'bash', args: [] };
    case 'powershell':
      return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-File'] };
    case 'direct':
      return { command: '', args: [] };
    default:
      throw new RboError(
        'shell_missing',
        `Shell '${shell}' is not supported in Phase 3 (supported: bash, powershell, direct; gap: ${PHASE3_UNSUPPORTED_SHELLS.join(', ')})`,
        false,
      );
  }
}

export async function writeJobScript(
  controlDir: string,
  execution: ExecutionConfig,
  scriptName?: string,
): Promise<string> {
  await mkdir(controlDir, { recursive: true });
  const isPowerShell = execution.shell === 'powershell';
  const isDirect = execution.shell === 'direct';
  const fileName =
    scriptName ??
    (isPowerShell ? 'job.ps1' : isDirect && process.platform === 'win32' ? 'job.cmd' : 'job.sh');
  const scriptPath = join(controlDir, fileName);
  const isCleanup =
    scriptName === 'cleanup.ps1' || scriptName === 'cleanup.sh' || scriptName === 'cleanup.cmd';
  const scriptBody = isCleanup ? (execution.cleanup_script ?? '') : execution.script;
  // Ensure Unix direct exec has a shebang when the user did not provide one.
  const body =
    isDirect && process.platform !== 'win32' && !scriptBody.startsWith('#!')
      ? `#!/usr/bin/env bash\n${scriptBody}`
      : scriptBody;
  await writeFile(scriptPath, body, 'utf8');
  if (process.platform !== 'win32') {
    await chmod(scriptPath, 0o755);
  }
  return scriptPath;
}

function resolveWindowsExecutorPath(): string | null {
  const fromEnv = process.env.RBO_WINDOWS_EXECUTOR;
  if (fromEnv && existsSync(fromEnv)) {
    return fromEnv;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '../../../native/windows-executor/target/debug/rbo-windows-executor.exe'),
    join(here, '../../../native/windows-executor/target/release/rbo-windows-executor.exe'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function attachLogPipes(child: ManagedChildProcess, logs: AttemptLogPaths): void {
  child.stdout.on('data', (chunk: Buffer | string) => {
    void appendStdout(logs, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  child.stderr.on('data', (chunk: Buffer | string) => {
    void appendStderr(logs, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
}

function spawnNodeProcess(input: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logs: AttemptLogPaths;
  attachLogs?: boolean;
  timeoutSeconds?: number;
  cancelGraceSeconds?: number;
  idleTimeoutSeconds?: number;
}): ManagedChildProcess {
  const isWindows = process.platform === 'win32';
  const child = spawn(input.command, input.args, {
    cwd: input.cwd,
    env: input.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !isWindows,
    windowsHide: true,
  });

  let lastOutputAt = Date.now();
  let idleTimer: NodeJS.Timeout | undefined;
  let wallTimeoutTimer: NodeJS.Timeout | undefined;

  const clearTimers = () => {
    if (idleTimer) {
      clearInterval(idleTimer);
      idleTimer = undefined;
    }
    if (wallTimeoutTimer) {
      clearTimeout(wallTimeoutTimer);
      wallTimeoutTimer = undefined;
    }
  };

  const killTree = async (pid: number | undefined, graceSeconds: number) => {
    if (!pid) {
      return;
    }
    if (isWindows) {
      child.kill();
      if (graceSeconds > 0) {
        await new Promise((r) => setTimeout(r, graceSeconds * 1000));
      }
      try {
        await execFileAsync('taskkill', ['/pid', String(pid), '/T', '/F'], {
          windowsHide: true,
        });
      } catch {
        // process may already be gone
      }
      return;
    }
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    if (graceSeconds > 0) {
      await new Promise((r) => setTimeout(r, graceSeconds * 1000));
    }
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  };

  const managed = new ManagedChildProcess({
    pid: child.pid ?? -1,
    waitForExit: () =>
      new Promise((resolvePromise) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          clearTimers();
          resolvePromise({ exitCode: child.exitCode, signal: child.signalCode });
          return;
        }
        child.once('close', (code, signal) => {
          clearTimers();
          managed.emit('exit', code, signal);
          resolvePromise({ exitCode: code, signal });
        });
      }),
    kill: (graceSeconds: number) => killTree(child.pid, graceSeconds),
  });

  const idleTimeoutSeconds = input.idleTimeoutSeconds;
  const resetIdle = () => {
    lastOutputAt = Date.now();
    if (idleTimeoutSeconds) {
      if (idleTimer) {
        clearInterval(idleTimer);
      }
      idleTimer = setInterval(() => {
        if (Date.now() - lastOutputAt >= idleTimeoutSeconds * 1000) {
          void killTree(child.pid, 0);
        }
      }, 500);
    }
  };
  resetIdle();

  if (input.timeoutSeconds && input.timeoutSeconds > 0) {
    wallTimeoutTimer = setTimeout(() => {
      void killTree(child.pid, input.cancelGraceSeconds ?? 0);
    }, input.timeoutSeconds * 1000);
  }

  child.stdout?.on('data', (chunk: Buffer) => {
    resetIdle();
    managed.stdout.write(chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    resetIdle();
    managed.stderr.write(chunk);
  });
  child.on('close', () => {
    managed.stdout.end();
    managed.stderr.end();
  });

  if (input.attachLogs !== false) {
    attachLogPipes(managed, input.logs);
  }
  return managed;
}

function spawnWindowsHelperProcess(input: {
  attemptId: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logs: AttemptLogPaths;
  attachLogs?: boolean;
  timeoutSeconds: number;
  cancelGraceSeconds: number;
  idleTimeoutSeconds?: number;
}): ManagedChildProcess | null {
  const helperPath = resolveWindowsExecutorPath();
  if (!helperPath) {
    return null;
  }

  const request = JSON.stringify({
    protocol: 2,
    attempt_id: input.attemptId,
    command: input.command,
    args: input.args,
    cwd: input.cwd,
    env: Object.fromEntries(
      Object.entries(input.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    timeout_seconds: input.timeoutSeconds,
    cancel_grace_seconds: input.cancelGraceSeconds,
  });

  const child = spawn(helperPath, [], {
    cwd: input.cwd,
    env: input.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stdin?.write(`${request}\n`);

  let cancelSent = false;
  let lastOutputAt = Date.now();
  let idleTimer: NodeJS.Timeout | undefined;
  let controlPayload: Buffer | undefined;
  const frameReader = new WindowsHelperFrameReader();

  const clearIdle = () => {
    if (idleTimer) {
      clearInterval(idleTimer);
      idleTimer = undefined;
    }
  };

  const resetIdle = () => {
    lastOutputAt = Date.now();
    const idleTimeoutSeconds = input.idleTimeoutSeconds;
    if (!idleTimeoutSeconds || idleTimeoutSeconds <= 0) {
      return;
    }
    clearIdle();
    idleTimer = setInterval(() => {
      if (Date.now() - lastOutputAt >= idleTimeoutSeconds * 1000) {
        if (!cancelSent) {
          cancelSent = true;
          child.stdin?.write('CANCEL\n');
        }
        child.kill();
      }
    }, 500);
  };
  resetIdle();

  let exitCode: number | null = null;
  let resolved = false;
  const waiters: Array<(value: { exitCode: number | null; signal: null }) => void> = [];

  const managed = new ManagedChildProcess({
    pid: child.pid ?? -1,
    waitForExit: () =>
      new Promise((resolvePromise) => {
        if (resolved) {
          resolvePromise({ exitCode, signal: null });
          return;
        }
        waiters.push(resolvePromise);
      }),
    kill: async (graceSeconds: number) => {
      if (!cancelSent) {
        cancelSent = true;
        child.stdin?.write('CANCEL\n');
      }
      await new Promise((r) => setTimeout(r, graceSeconds * 1000));
      child.kill();
    },
  });

  child.stdout?.on('data', (chunk: Buffer) => {
    const frames = frameReader.append(chunk);
    for (const data of frames.stdout) {
      resetIdle();
      managed.stdout.write(data);
    }
    for (const data of frames.stderr) {
      resetIdle();
      managed.stderr.write(data);
    }
    if (frames.control) {
      controlPayload = frames.control;
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    resetIdle();
    managed.stderr.write(chunk);
  });

  child.on('close', (code) => {
    clearIdle();
    let resolvedExit: number | null = code;
    if (controlPayload) {
      try {
        const parsed = JSON.parse(controlPayload.toString('utf8')) as {
          exit_code?: number | null;
        };
        if (parsed.exit_code === null || typeof parsed.exit_code === 'number') {
          resolvedExit = parsed.exit_code ?? null;
        }
      } catch {
        // fall back to helper process exit code
      }
    }
    exitCode = resolvedExit;
    resolved = true;
    managed.stdout.end();
    managed.stderr.end();
    managed.emit('exit', exitCode, null);
    for (const waiter of waiters) {
      waiter({ exitCode, signal: null });
    }
  });

  if (input.attachLogs !== false) {
    attachLogPipes(managed, input.logs);
  }
  return managed;
}

export interface SpawnJobScriptResult extends ManagedChildProcess {
  ignoredRboEnvKeys: string[];
}

function buildChildEnv(input: {
  execution: ExecutionConfig;
  injected: Record<string, string>;
}): { env: NodeJS.ProcessEnv; ignoredRboEnvKeys: string[] } {
  const userEnv = { ...(input.execution.env ?? {}) };
  const ignoredRboEnvKeys: string[] = [];
  for (const key of Object.keys(userEnv)) {
    if (key.startsWith('RBO_')) {
      ignoredRboEnvKeys.push(key);
      delete userEnv[key];
    }
  }
  return {
    env: { ...process.env, ...userEnv, ...input.injected },
    ignoredRboEnvKeys,
  };
}

export function spawnJobScript(input: {
  attemptId: string;
  controlDir: string;
  workspacePath: string;
  projectPath: string;
  execution: ExecutionConfig;
  env: Record<string, string>;
  logs: AttemptLogPaths;
  scriptFileName?: string;
  /** When false, caller owns redaction/persistence of stdout/stderr. Default true. */
  attachLogs?: boolean;
}): SpawnJobScriptResult {
  const defaultName =
    input.execution.shell === 'powershell'
      ? 'job.ps1'
      : input.execution.shell === 'direct' && process.platform === 'win32'
        ? 'job.cmd'
        : 'job.sh';
  const scriptPath = join(input.controlDir, input.scriptFileName ?? defaultName);
  const shell = resolveShellCommand(input.execution.shell);

  const { env: childEnv, ignoredRboEnvKeys } = buildChildEnv({
    execution: input.execution,
    injected: {
      ...input.env,
      RBO_WORKSPACE: input.workspacePath,
      RBO_PROJECT_DIR: input.projectPath,
      RBO_LOG_DIR: input.logs.logDir,
    },
  });

  let command: string;
  let args: string[];
  if (input.execution.shell === 'direct') {
    if (process.platform === 'win32') {
      command = 'cmd.exe';
      args = ['/d', '/c', scriptPath];
    } else {
      command = scriptPath;
      args = [];
    }
  } else if (input.execution.shell === 'powershell') {
    command = shell.command;
    args = [...shell.args, scriptPath];
  } else {
    command = shell.command;
    args = [scriptPath];
  }

  if (process.platform === 'win32') {
    const helper = spawnWindowsHelperProcess({
      attemptId: input.attemptId,
      command,
      args,
      cwd: input.projectPath,
      env: childEnv,
      logs: input.logs,
      attachLogs: input.attachLogs,
      timeoutSeconds: input.execution.timeout_seconds,
      cancelGraceSeconds: input.execution.cancel_grace_seconds,
      idleTimeoutSeconds: input.execution.idle_timeout_seconds,
    });
    if (helper) {
      Object.assign(helper, { ignoredRboEnvKeys });
      return helper as SpawnJobScriptResult;
    }
  }

  const child = spawnNodeProcess({
    command,
    args,
    cwd: input.projectPath,
    env: childEnv,
    logs: input.logs,
    attachLogs: input.attachLogs,
    timeoutSeconds: input.execution.timeout_seconds,
    cancelGraceSeconds: input.execution.cancel_grace_seconds,
    idleTimeoutSeconds: input.execution.idle_timeout_seconds,
  });
  Object.assign(child, { ignoredRboEnvKeys });
  return child as SpawnJobScriptResult;
}

export async function runCleanupScript(input: {
  attemptId: string;
  controlDir: string;
  workspacePath: string;
  projectPath: string;
  execution: ExecutionConfig;
  env: Record<string, string>;
  logs: AttemptLogPaths;
}): Promise<{ exitCode: number | null; timedOut: boolean }> {
  if (!input.execution.cleanup_script) {
    return { exitCode: 0, timedOut: false };
  }
  const isPowerShell = input.execution.shell === 'powershell';
  const isDirectWin = input.execution.shell === 'direct' && process.platform === 'win32';
  const cleanupName = isPowerShell ? 'cleanup.ps1' : isDirectWin ? 'cleanup.cmd' : 'cleanup.sh';
  await writeJobScript(input.controlDir, input.execution, cleanupName);
  const child = spawnJobScript({
    ...input,
    scriptFileName: cleanupName,
  });
  const timeoutMs = (input.execution.cleanup_timeout_seconds ?? 60) * 1000;
  const result = await Promise.race([
    child.waitForExit().then((r) => ({ type: 'exit' as const, ...r })),
    new Promise<'timeout'>((resolvePromise) =>
      setTimeout(() => resolvePromise('timeout'), timeoutMs),
    ),
  ]);
  if (result === 'timeout') {
    await child.kill(input.execution.cancel_grace_seconds);
    return { exitCode: null, timedOut: true };
  }
  return { exitCode: result.exitCode, timedOut: false };
}
