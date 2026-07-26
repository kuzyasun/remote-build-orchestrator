import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import type { ExecutionConfig } from '@rbo/protocol';
import { RboError } from '@rbo/shared';
import type { AttemptLogPaths } from './logs.js';
import { appendStderr, appendStdout } from './logs.js';
import { buildReservedRboEnv } from './runtime-env.js';
import { resolveWindowsExecutorPath } from './windows-executor-path.js';
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

function resolveShellCommand(shell: ExecutionConfig['shell']): { command: string; args: string[] } {
  switch (shell) {
    case 'bash':
      return { command: 'bash', args: [] };
    case 'sh':
      return { command: 'sh', args: [] };
    case 'zsh':
      return { command: 'zsh', args: [] };
    case 'powershell':
      return {
        command: process.platform === 'win32' ? 'powershell.exe' : 'powershell',
        args: ['-NoProfile', '-NonInteractive', '-File'],
      };
    case 'pwsh':
      return {
        command: process.platform === 'win32' ? 'pwsh.exe' : 'pwsh',
        args: ['-NoProfile', '-NonInteractive', '-File'],
      };
    case 'cmd':
      return { command: 'cmd.exe', args: ['/c'] };
    case 'direct':
      return { command: '', args: [] };
    default:
      throw new RboError('shell_missing', `Unsupported shell: '${shell as string}'`, false);
  }
}

export async function writeJobScript(
  controlDir: string,
  execution: ExecutionConfig,
  scriptName?: string,
): Promise<string> {
  await mkdir(controlDir, { recursive: true });
  const isPowerShell = execution.shell === 'powershell' || execution.shell === 'pwsh';
  const isCmd = execution.shell === 'cmd';
  const isDirect = execution.shell === 'direct';
  const fileName =
    scriptName ??
    (isPowerShell
      ? 'job.ps1'
      : isCmd || (isDirect && process.platform === 'win32')
        ? 'job.cmd'
        : 'job.sh');
  const scriptPath = join(controlDir, fileName);
  const isCleanup =
    scriptName === 'cleanup.ps1' || scriptName === 'cleanup.sh' || scriptName === 'cleanup.cmd';
  const scriptBody = isCleanup ? (execution.cleanup_script ?? '') : execution.script;
  // Ensure Unix direct exec has a shebang when the user did not provide one.
  const autoShebanged = isDirect && process.platform !== 'win32' && !scriptBody.startsWith('#!');
  let body = autoShebanged ? `#!/usr/bin/env bash\n${scriptBody}` : scriptBody;
  if (isPowerShell) {
    body = `${POWERSHELL_JOB_PRELUDE}${body}`;
  } else if (execution.shell === 'bash' || execution.shell === 'sh') {
    body = `${POSIX_JOB_CONTROL_PRELUDE}${body}`;
  } else if (autoShebanged) {
    // We know this is our own injected bash shebang (not a user-supplied one for
    // an arbitrary interpreter), so it's safe to insert the prelude right after it.
    const newlineIdx = body.indexOf('\n');
    body = `${body.slice(0, newlineIdx + 1)}${POSIX_JOB_CONTROL_PRELUDE}${body.slice(newlineIdx + 1)}`;
  }
  await writeFile(scriptPath, body, 'utf8');
  if (process.platform !== 'win32') {
    await chmod(scriptPath, 0o755);
  }
  return scriptPath;
}

/**
 * Injected ahead of every PowerShell job/cleanup script.
 *
 * Windows PowerShell leaves `$LASTEXITCODE` as `$null` until a console-subsystem
 * native executable runs. GUI-subsystem CLIs (PE subsystem 2 — e.g. eim.exe) often
 * never populate it. Then `if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }` becomes
 * `$null -ne 0` → immediate `exit $null` (process exit 0) and later commands never run.
 *
 * Seeding `$global:LASTEXITCODE = 0` makes the usual fail-closed pattern safe when the
 * variable was never set. Operators should still write normal scripts; RBO owns this fix.
 */
export const POWERSHELL_JOB_PRELUDE = [
  '# RBO PowerShell runtime prelude (injected; do not remove)',
  '$global:LASTEXITCODE = 0',
  '# --- end RBO prelude ---',
  '',
  '',
].join('\n');

/**
 * Injected ahead of every bash/sh job/cleanup script (and Unix `direct` scripts
 * we auto-shebang, since that shebang is our own `#!/usr/bin/env bash`).
 *
 * `bash job.sh` is invoked non-interactively, so job control is off by default —
 * a `long_running_server &` inside the script does NOT get its own process
 * group; it stays in the wrapper's group. That silently breaks the common
 * cleanup idiom `kill -TERM "-$(ps -o pgid= "$BG_PID")"`: the pgid it resolves
 * is the *wrapper's*, so the script signals itself, dies mid-cleanup, and
 * reports the signal instead of its real exit code. Enabling job control
 * restores the interactive-shell semantics such scripts are written against.
 *
 * `killTree` (below) independently walks the actual descendant tree, so orphan
 * reaping does not depend on this prelude taking effect — which matters because
 * it is deliberately NOT applied everywhere:
 *   - `zsh`: `set -m` without a controlling tty is a FATAL error in zsh
 *     ("can't change option: -m") that aborts the whole script — `|| true` does
 *     not rescue it. `setopt monitor` is the safe zsh spelling but is a no-op
 *     without a tty (verified: backgrounded jobs keep the parent's pgid), so
 *     zsh gets no prelude at all rather than a misleading one.
 *   - `sh` on Linux (dash): accepts `set -m` but reports "can't access tty; job
 *     control turned off" and leaves it off. Harmless; the stderr note is
 *     swallowed by the redirect and killTree still covers cleanup.
 *
 * Deliberately ONE line: it shifts every line number in the user's script, which
 * shows up in their own `job.sh: line N:` diagnostics, so the offset is kept to
 * the minimum of 1. `bash -m job.sh` would avoid the shift entirely but does not
 * work — bash silently drops `-m` for a non-interactive script file (verified:
 * `$-` comes back as `hB`, no `m`), so in-script `set -m` is the only mechanism
 * that actually enables job control here.
 */
export const POSIX_JOB_CONTROL_PRELUDE =
  'set -m 2>/dev/null || true # RBO: job control, so `cmd &` gets its own process group\n';

function attachLogPipes(
  child: ManagedChildProcess,
  logs: AttemptLogPaths,
  onLogChunk?: (stream: 'stdout' | 'stderr', chunk: Buffer) => void | Promise<void>,
): void {
  if (onLogChunk) {
    child.stdout.on('data', (chunk: Buffer | string) => {
      void onLogChunk('stdout', Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      void onLogChunk('stderr', Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    return;
  }
  child.stdout.on('data', (chunk: Buffer | string) => {
    void appendStdout(logs, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  child.stderr.on('data', (chunk: Buffer | string) => {
    void appendStderr(logs, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
}

/**
 * Read the live process table as a parent -> children adjacency map.
 *
 * One `ps` invocation serves any number of lineage walks (see
 * listDescendantPids), which matters because killTree re-walks on every pass.
 */
async function readProcessTree(): Promise<Map<number, number[]>> {
  const childrenByParent = new Map<number, number[]>();
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=,ppid=']));
  } catch {
    return childrenByParent;
  }
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const [pidStr, ppidStr] = trimmed.split(/\s+/);
    const pid = Number(pidStr);
    const ppid = Number(ppidStr);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) {
      continue;
    }
    const siblings = childrenByParent.get(ppid);
    if (siblings) {
      siblings.push(pid);
    } else {
      childrenByParent.set(ppid, [pid]);
    }
  }
  return childrenByParent;
}

/**
 * Every live descendant of any of `rootPids`, by parent/child lineage rather
 * than process-group membership.
 *
 * A backgrounded job (see POSIX_JOB_CONTROL_PRELUDE) can end up in its own
 * process group/session — `process.kill(-pgid, …)` won't reach it. Parentage
 * survives that (the OS only reparents an orphan once its actual parent
 * exits), so this is what lets killTree still reap it on a genuine job kill.
 *
 * Takes multiple roots because once the wrapper dies its own lineage is gone
 * (survivors get reparented to init), so a later re-walk has to start from the
 * descendants we already know about to see anything they spawned since.
 */
async function listDescendantPids(rootPids: number[]): Promise<number[]> {
  const childrenByParent = await readProcessTree();
  const seen = new Set<number>();
  const stack = [...rootPids];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      continue;
    }
    for (const kid of childrenByParent.get(current) ?? []) {
      // `seen` also guards against re-walking shared subtrees (and, defensively,
      // any pid appearing twice in the ps snapshot).
      if (seen.has(kid)) {
        continue;
      }
      seen.add(kid);
      stack.push(kid);
    }
  }
  for (const root of rootPids) {
    seen.delete(root);
  }
  return [...seen];
}

function spawnNodeProcess(input: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logs: AttemptLogPaths;
  attachLogs?: boolean;
  onLogChunk?: (stream: 'stdout' | 'stderr', chunk: Buffer) => void | Promise<void>;
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

  const killTreeImpl = async (pid: number | undefined, graceSeconds: number) => {
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
    // Snapshot descendants *before* signaling anything. Once the wrapper itself
    // is signaled, it can exit almost immediately (job control moved everything
    // else out of its process group, so `-pid` only ever reaches the wrapper) —
    // and the moment its real parent exits, a still-running descendant is
    // reparented to init, no longer showing the wrapper as its ppid. Looking it
    // up *after* signaling would silently miss it.
    const preSignalDescendants = await listDescendantPids([pid]);
    const signalAll = async (signal: NodeJS.Signals, extraDescendants: number[] = []) => {
      try {
        process.kill(-pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // already gone
        }
      }
      // Catch anything that fell outside the wrapper's process group (see
      // POSIX_JOB_CONTROL_PRELUDE) so a genuine kill never leaks an orphan.
      //
      // Accepted tradeoff: a snapshotted pid could in principle be reaped and
      // its number reused by an unrelated process before we signal it, so we
      // would signal the wrong process. The window is milliseconds and pid
      // reuse needs a full pid-space wrap, so this is not worth the cost of
      // re-verifying lineage per pid — which would reintroduce the reparenting
      // blindness the pre-signal snapshot exists to avoid.
      const targets = new Set([...preSignalDescendants, ...extraDescendants]);
      for (const descendantPid of targets) {
        try {
          process.kill(descendantPid, signal);
        } catch {
          // already gone
        }
      }
    };
    await signalAll('SIGTERM');
    if (graceSeconds > 0) {
      await new Promise((r) => setTimeout(r, graceSeconds * 1000));
    }
    // Re-walk before SIGKILL to catch anything spawned during the grace period —
    // e.g. a descendant that traps SIGTERM and keeps working. This must start
    // from the known descendants as well as the wrapper: by now the wrapper is
    // usually dead, so walking from it alone finds nothing (survivors have been
    // reparented to init) and newly-spawned grandchildren would leak.
    const lateDescendants = await listDescendantPids([pid, ...preSignalDescendants]).catch(
      () => [],
    );
    await signalAll('SIGKILL', lateDescendants);
  };

  // The idle-timeout interval re-fires every 500ms while a job is quiet, and each
  // pass now shells out to `ps`. Collapse concurrent kills onto one in-flight run
  // so a process that is slow to die cannot pile up ps invocations.
  let killInFlight: Promise<void> | undefined;
  const killTree = (pid: number | undefined, graceSeconds: number): Promise<void> => {
    if (killInFlight) {
      return killInFlight;
    }
    killInFlight = killTreeImpl(pid, graceSeconds).finally(() => {
      killInFlight = undefined;
    });
    return killInFlight;
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

  if (input.onLogChunk || input.attachLogs !== false) {
    attachLogPipes(managed, input.logs, input.onLogChunk);
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
  onLogChunk?: (stream: 'stdout' | 'stderr', chunk: Buffer) => void | Promise<void>;
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

  if (input.onLogChunk || input.attachLogs !== false) {
    attachLogPipes(managed, input.logs, input.onLogChunk);
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
  /** Optional chunk callback (used with attachLogs: false for Controller live logs). */
  onLogChunk?: (stream: 'stdout' | 'stderr', chunk: Buffer) => void | Promise<void>;
}): SpawnJobScriptResult {
  const defaultName =
    input.execution.shell === 'powershell' || input.execution.shell === 'pwsh'
      ? 'job.ps1'
      : input.execution.shell === 'cmd' ||
          (input.execution.shell === 'direct' && process.platform === 'win32')
        ? 'job.cmd'
        : 'job.sh';
  const scriptPath = join(input.controlDir, input.scriptFileName ?? defaultName);
  const shell = resolveShellCommand(input.execution.shell);

  const extra: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.env)) {
    if (!key.startsWith('RBO_')) {
      extra[key] = value;
    }
  }
  const { env: childEnv, ignoredRboEnvKeys } = buildChildEnv({
    execution: input.execution,
    injected: buildReservedRboEnv({
      jobId: input.env.RBO_JOB_ID ?? '',
      attemptId: input.env.RBO_ATTEMPT_ID ?? input.attemptId,
      workspacePath: input.workspacePath,
      projectPath: input.projectPath,
      logDir: input.logs.logDir,
      artifactDir: input.env.RBO_ARTIFACT_DIR ?? '',
      extra,
    }),
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
  } else if (input.execution.shell === 'powershell' || input.execution.shell === 'pwsh') {
    command = shell.command;
    args = [...shell.args, scriptPath];
  } else if (input.execution.shell === 'cmd') {
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
      onLogChunk: input.onLogChunk,
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
    onLogChunk: input.onLogChunk,
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
