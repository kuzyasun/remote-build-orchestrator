import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import type { ExecutionConfig } from '@rbo/protocol';
import { RboError } from '@rbo/shared';
import { waitForCompletion } from './completion.js';
import { type LinuxCgroupScope, createLinuxCgroupScope, findAttemptPids } from './containment.js';
import type { AttemptLogPaths } from './logs.js';
import { appendStderr, appendStdout } from './logs.js';
import { buildReservedRboEnv } from './runtime-env.js';
import { describeWindowsExecutorResolution } from './windows-executor-path.js';
import { WindowsHelperFrameReader } from './windows-frames.js';

const execFileAsync = promisify(execFile);

type ProcessExit = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut?: boolean;
};

type ProcessStart = { started: true } | { started: false; errorMessage?: string };

interface NativeResultDelivery {
  graceMs: number;
  abort: () => void;
}

/**
 * ChildProcess-like EventEmitter façade shared by Unix spawn and Windows
 * helper frame-reader adapters (§0.1 rule 10 / Phase 3 pin).
 */
export class ManagedChildProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly nativeResultDelivery?: NativeResultDelivery;
  pid: number;
  private readonly waitForExitImpl: () => Promise<ProcessExit>;
  private readonly waitForStartImpl: () => Promise<ProcessStart>;
  private readonly killImpl: (graceSeconds: number) => Promise<void>;
  /**
   * Chain of every fire-and-forget durable log append started by attachLogPipes
   * (the default attachLogs path). Resolves only once each queued append has
   * settled, so a caller can drain before deleting the logs directory — and the
   * close handler can drain before ending the streams.
   *
   * Production callers (Agent, Controller) run with attachLogs:false and own
   * their own drain (spoolWriteChain / logWriteChain), leaving this chain empty
   * for them; this only covers the attachLogs:true path used by tests and simple
   * callers.
   */
  private logWriteChain: Promise<void> = Promise.resolve();
  private streamsEnded = false;

  constructor(input: {
    pid: number;
    waitForExit: () => Promise<ProcessExit>;
    waitForStart?: () => Promise<ProcessStart>;
    kill: (graceSeconds: number) => Promise<void>;
    nativeResultDelivery?: NativeResultDelivery;
  }) {
    super();
    this.pid = input.pid;
    this.waitForExitImpl = input.waitForExit;
    this.waitForStartImpl = input.waitForStart ?? (async () => ({ started: input.pid > 0 }));
    this.killImpl = input.kill;
    this.nativeResultDelivery = input.nativeResultDelivery;
  }

  waitForExit(): Promise<ProcessExit> {
    return this.waitForExitImpl();
  }

  waitForStart(): Promise<ProcessStart> {
    return this.waitForStartImpl();
  }

  kill(graceSeconds = 10): Promise<void> {
    return this.killImpl(graceSeconds);
  }

  /**
   * Track an in-flight durable log append so it can be awaited via drainLogs.
   * The append must not reject (wrap with .catch at the call site), so the chain
   * never settles rejected and drainLogs never throws.
   */
  trackLogAppend(append: Promise<unknown>): void {
    this.logWriteChain = this.logWriteChain.then(() => append).then(() => undefined);
  }

  /** Resolve once every tracked durable log append has settled. */
  async drainLogs(): Promise<void> {
    await this.logWriteChain;
  }

  /**
   * Await all in-flight durable log appends, then end the stdout/stderr
   * PassThrough streams. Called from each adapter's child 'close' handler so a
   * late append can never race teardown (dir deletion / stream end). Idempotent.
   */
  async endStreamsAfterDrain(): Promise<void> {
    await this.logWriteChain;
    if (this.streamsEnded) {
      return;
    }
    this.streamsEnded = true;
    this.stdout.end();
    this.stderr.end();
  }
}

export type RunningProcess = ManagedChildProcess;

function manageChild(
  child: ChildProcess,
  kill: (graceSeconds: number) => Promise<void>,
  onClose: (exitCode: number | null, signal: NodeJS.Signals | null) => ProcessExit,
  nativeResultDelivery?: NativeResultDelivery,
  nativeStart?: Promise<ProcessStart>,
): ManagedChildProcess {
  let resolveExit: (result: ProcessExit) => void;
  const exit = new Promise<ProcessExit>((resolvePromise) => {
    resolveExit = resolvePromise;
  });
  const start =
    nativeStart ??
    new Promise<ProcessStart>((resolvePromise) => {
      child.once('spawn', () => resolvePromise({ started: true }));
      child.once('error', (error) =>
        resolvePromise({ started: false, errorMessage: error.message }),
      );
      child.once('close', () => resolvePromise({ started: false }));
    });
  const managed = new ManagedChildProcess({
    pid: child.pid ?? -1,
    waitForExit: () => exit,
    waitForStart: () => start,
    kill,
    nativeResultDelivery,
  });
  child.on('error', (error) => {
    managed.stderr.write(`Process error: ${error.message}\n`);
  });
  child.once('close', (code, signal) => {
    const result = onClose(code, signal);
    void managed.endStreamsAfterDrain().then(() => {
      resolveExit(result);
      managed.emit('exit', result.exitCode, result.signal);
    });
  });
  return managed;
}

function scriptFileName(shell: ExecutionConfig['shell'], name: 'job' | 'cleanup'): string {
  if (shell === 'powershell' || shell === 'pwsh') {
    return `${name}.ps1`;
  }
  if (shell === 'cmd' || (shell === 'direct' && process.platform === 'win32')) {
    return `${name}.cmd`;
  }
  return `${name}.sh`;
}

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
  const isDirect = execution.shell === 'direct';
  const fileName = scriptName ?? scriptFileName(execution.shell, 'job');
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
  // Track each durable append so drainLogs()/endStreamsAfterDrain() can await
  // every in-flight write before a caller deletes the logs directory or the
  // close handler ends the streams. Catching here keeps the chain settled so a
  // late chunk landing on a removed dir (e.g. after teardown) rejects silently
  // instead of becoming an unhandled rejection.
  child.stdout.on('data', (chunk: Buffer | string) => {
    child.trackLogAppend(
      appendStdout(logs, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)).catch(
        () => undefined,
      ),
    );
  });
  child.stderr.on('data', (chunk: Buffer | string) => {
    child.trackLogAppend(
      appendStderr(logs, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)).catch(
        () => undefined,
      ),
    );
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
  attemptId?: string;
  containmentId?: string;
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

  const containmentId = input.containmentId ?? input.attemptId;
  let cgroupScope: LinuxCgroupScope | null = null;
  let processExited = false;
  if (containmentId && process.platform === 'linux' && child.pid) {
    void createLinuxCgroupScope(containmentId).then(async (scope) => {
      if (!scope) return;
      if (processExited) {
        await scope.cleanup();
        return;
      }
      cgroupScope = scope;
      if (child.pid) {
        await scope.addPid(child.pid);
      }
    });
  }

  let lastOutputAt = Date.now();
  let idleTimer: NodeJS.Timeout | undefined;
  let wallTimeoutTimer: NodeJS.Timeout | undefined;

  const clearTimers = () => {
    processExited = true;
    if (idleTimer) {
      clearInterval(idleTimer);
      idleTimer = undefined;
    }
    if (wallTimeoutTimer) {
      clearTimeout(wallTimeoutTimer);
      wallTimeoutTimer = undefined;
    }
    if (cgroupScope) {
      void cgroupScope.cleanup();
    }
  };

  const killTreeImpl = async (pid: number | undefined, graceSeconds: number) => {
    if (!pid) {
      return;
    }
    const wrapperRunning = () =>
      !processExited && child.exitCode === null && child.signalCode === null;
    if (isWindows) {
      if (!wrapperRunning()) {
        return;
      }
      try {
        // Keep the wrapper alive until taskkill captures its process tree.
        // Terminating it first can reparent a still-running descendant, making
        // a subsequent `/T` miss the orphan entirely.
        await execFileAsync('taskkill', ['/pid', String(pid), '/T', '/F'], {
          windowsHide: true,
        });
      } catch {
        // If taskkill cannot inspect the process (for example, it already
        // exited), retain the best-effort root termination fallback.
        try {
          child.kill();
        } catch {
          // process may already be gone
        }
      }
      return;
    }
    // Snapshot descendants *before* signaling anything. Once the wrapper itself
    // is signaled, it can exit almost immediately (job control moved everything
    // else out of its process group, so `-pid` only ever reaches the wrapper) —
    // and the moment its real parent exits, a still-running descendant is
    // reparented to init, no longer showing the wrapper as its ppid. Looking it
    // up *after* signaling would silently miss it.
    const initialDescendants = wrapperRunning() ? await listDescendantPids([pid]) : [];
    const preSignalDescendants = wrapperRunning() ? initialDescendants : [];
    const envDescendants = containmentId ? await findAttemptPids(containmentId) : [];
    const cgroupDescendants = cgroupScope ? await cgroupScope.listPids() : [];

    const signalAll = async (signal: NodeJS.Signals, extraDescendants: number[] = []) => {
      // The wrapper may have exited while collecting containment evidence.
      // Its numeric PID/PGID can no longer identify a live process we own.
      if (wrapperRunning()) {
        try {
          process.kill(-pid, signal);
        } catch {
          try {
            child.kill(signal);
          } catch {
            // already gone
          }
        }
      }
      // Catch anything that fell outside the wrapper's process group (see
      // POSIX_JOB_CONTROL_PRELUDE) or orphaned via setsid (tracked via
      // environment tag or Linux cgroup) so a genuine kill never leaks an orphan.
      //
      // Accepted tradeoff: a snapshotted pid could in principle be reaped and
      // its number reused by an unrelated process before we signal it, so we
      // would signal the wrong process. The window is milliseconds and pid
      // reuse needs a full pid-space wrap, so this is not worth the cost of
      // re-verifying lineage per pid — which would reintroduce the reparenting
      // blindness the pre-signal snapshot exists to avoid.
      const targets = new Set([
        ...preSignalDescendants,
        ...envDescendants,
        ...cgroupDescendants,
        ...extraDescendants,
      ]);
      targets.delete(pid);
      targets.delete(process.pid);
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
    let lateDescendants = wrapperRunning()
      ? await listDescendantPids([pid, ...preSignalDescendants]).catch(() => [])
      : [];
    if (!wrapperRunning()) {
      lateDescendants = preSignalDescendants.length
        ? await listDescendantPids(preSignalDescendants).catch(() => [])
        : [];
    }
    const lateEnvDescendants = containmentId ? await findAttemptPids(containmentId) : [];
    const lateCgroupDescendants = cgroupScope ? await cgroupScope.listPids() : [];
    await signalAll('SIGKILL', [
      ...lateDescendants,
      ...lateEnvDescendants,
      ...lateCgroupDescendants,
    ]);
    if (cgroupScope) {
      await cgroupScope.kill();
      await cgroupScope.cleanup();
    }
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

  const managed = manageChild(
    child,
    (graceSeconds) => killTree(child.pid, graceSeconds),
    (exitCode, signal) => {
      clearTimers();
      return { exitCode, signal };
    },
  );

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
  if (input.onLogChunk || input.attachLogs !== false) {
    attachLogPipes(managed, input.logs, input.onLogChunk);
  }
  return managed;
}

function spawnWindowsHelperProcess(input: {
  helperPath: string;
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
  getStartBudgetMs?: () => number;
}): ManagedChildProcess {
  let startAuthorization:
    | { kind: 'unleased' }
    | { kind: 'lease'; qpc_issued_ms: number; qpc_deadline_ms: number; epoch_deadline_ms: number } =
    { kind: 'unleased' };
  if (input.getStartBudgetMs) {
    // On Windows Node's hrtime is libuv's QPC timestamp in nanoseconds. Sample
    // both clocks before measuring the lease budget so marshalling cannot extend it.
    const qpcIssuedMs = Number(process.hrtime.bigint() / 1_000_000n);
    const epochIssuedMs = Date.now();
    // Keep one millisecond for clock conversion and inter-thread tick ambiguity.
    const remainingMs = Math.max(0, Math.floor(input.getStartBudgetMs()) - 1);
    const qpcDeadlineMs = qpcIssuedMs + remainingMs;
    const epochDeadlineMs = epochIssuedMs + remainingMs;
    if (!Number.isSafeInteger(qpcDeadlineMs) || !Number.isSafeInteger(epochDeadlineMs)) {
      throw new RboError('process_spawn', 'Invalid Windows executor start authorization deadline');
    }
    startAuthorization = {
      kind: 'lease',
      qpc_issued_ms: qpcIssuedMs,
      qpc_deadline_ms: qpcDeadlineMs,
      epoch_deadline_ms: epochDeadlineMs,
    };
  }
  const request = JSON.stringify({
    protocol: 3,
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
    start_authorization: startAuthorization,
  });

  const child = spawn(resolve(input.helperPath), [], {
    cwd: input.cwd,
    env: input.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let cancelSent = false;
  let helperClosed = false;
  let killInFlight: Promise<void> | undefined;
  let lastOutputAt = Date.now();
  let idleTimer: NodeJS.Timeout | undefined;
  let controlPayload: Buffer | undefined;
  let started = false;
  let resolveStart: (result: ProcessStart) => void;
  const start = new Promise<ProcessStart>((resolvePromise) => {
    resolveStart = resolvePromise;
  });
  let spawnError: string | undefined;
  child.once('error', (error) => {
    spawnError = error.message;
  });
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
    if (cancelSent || !idleTimeoutSeconds || idleTimeoutSeconds <= 0) {
      return;
    }
    clearIdle();
    idleTimer = setInterval(() => {
      if (Date.now() - lastOutputAt >= idleTimeoutSeconds * 1000) {
        clearIdle();
        void managed.kill(0);
      }
    }, 500);
  };
  const cancelHelper = async (graceSeconds: number) => {
    if (!child.pid || helperClosed) {
      return;
    }
    cancelSent = true;
    child.stdin?.write('CANCEL\n');
    let timer: NodeJS.Timeout | undefined;
    try {
      // Allow the helper time to publish its final frame after its own drain window.
      const finished = await Promise.race([
        managed.waitForExit().then(() => true),
        new Promise<boolean>((resolvePromise) => {
          timer = setTimeout(() => resolvePromise(false), graceSeconds * 1000 + 1000);
        }),
      ]);
      if (!finished && !helperClosed) {
        child.kill();
      }
    } finally {
      clearTimeout(timer);
    }
  };
  const managed = manageChild(
    child,
    (graceSeconds) => {
      killInFlight ??= cancelHelper(graceSeconds);
      return killInFlight;
    },
    (code, signal) => {
      helperClosed = true;
      clearIdle();
      let startError = spawnError ?? 'Windows executor exited before confirming job start';
      if (controlPayload) {
        try {
          const parsed = JSON.parse(controlPayload.toString('utf8')) as {
            exit_code?: number | null;
            success?: boolean;
            timed_out?: boolean;
            error_message?: string | null;
          };
          if (parsed.error_message) {
            managed.stderr.write(`Windows executor: ${parsed.error_message}\n`);
            startError = parsed.error_message;
          }
          if (parsed.exit_code === null || typeof parsed.exit_code === 'number') {
            resolveStart({ started: false, errorMessage: startError });
            return {
              exitCode:
                (!started || parsed.success === false) && parsed.exit_code === 0
                  ? null
                  : parsed.exit_code,
              signal,
              ...(parsed.timed_out ? { timedOut: true } : {}),
            };
          }
        } catch {
          // Fall back to the helper's exit status if the control frame is malformed.
        }
      }
      resolveStart({ started: false, errorMessage: startError });
      if (code === 0) {
        managed.stderr.write('Windows executor did not return a valid result\n');
        return { exitCode: null, signal };
      }
      return { exitCode: code, signal };
    },
    {
      // The helper owns the root deadline and can drain both before and after closing the Job Object.
      graceMs: input.cancelGraceSeconds * 2000 + 1000,
      abort: () => {
        child.kill();
      },
    },
    start,
  );

  child.stdout?.on('data', (chunk: Buffer) => {
    const frames = frameReader.append(chunk);
    if (frames.started) {
      started = true;
      resolveStart({ started: true });
    }
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

  child.stdin?.on('error', (error) => {
    if (!cancelSent && !helperClosed) {
      managed.stderr.write(`Windows executor stdin error: ${error.message}\n`);
    }
    child.stdin?.destroy();
  });

  if (input.onLogChunk || input.attachLogs !== false) {
    attachLogPipes(managed, input.logs, input.onLogChunk);
  }
  child.stdin?.write(`${request}\n`);
  resetIdle();
  return managed;
}

export interface SpawnJobScriptResult extends ManagedChildProcess {
  ignoredRboEnvKeys: string[];
}

function buildChildEnv(input: {
  execution: ExecutionConfig;
  injected: Record<string, string>;
}): { env: NodeJS.ProcessEnv; ignoredRboEnvKeys: string[] } {
  const inheritedEnv = { ...process.env };
  for (const key of Object.keys(inheritedEnv)) {
    const name = key.toUpperCase();
    if (name === 'RBO_ADMIN_TOKEN' || name === 'RBO_MCP_TOKEN') {
      delete inheritedEnv[key];
    }
  }
  const userEnv = { ...(input.execution.env ?? {}) };
  const ignoredRboEnvKeys: string[] = [];
  for (const key of Object.keys(userEnv)) {
    if (key.startsWith('RBO_')) {
      ignoredRboEnvKeys.push(key);
      delete userEnv[key];
    }
  }
  return {
    env: { ...inheritedEnv, ...userEnv, ...input.injected },
    ignoredRboEnvKeys,
  };
}

export function spawnJobScript(input: {
  attemptId: string;
  containmentId?: string;
  controlDir: string;
  workspacePath: string;
  projectPath: string;
  execution: ExecutionConfig;
  env: Record<string, string>;
  logs: AttemptLogPaths;
  scriptFileName?: string;
  /** Require Windows Job Object containment for Agent scripts. */
  requireWindowsJobObject?: boolean;
  /** Remaining lease time for a Windows launch that requires active authorization. */
  getWindowsStartBudgetMs?: () => number;
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
  const containmentId = input.containmentId ?? input.attemptId;
  const { env: childEnv, ignoredRboEnvKeys } = buildChildEnv({
    execution: input.execution,
    injected: {
      ...buildReservedRboEnv({
        jobId: input.env.RBO_JOB_ID ?? '',
        attemptId: input.env.RBO_ATTEMPT_ID ?? input.attemptId,
        workspacePath: input.workspacePath,
        projectPath: input.projectPath,
        logDir: input.logs.logDir,
        artifactDir: input.env.RBO_ARTIFACT_DIR ?? '',
        extra,
      }),
      RBO_CONTAINMENT_ID: containmentId,
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
    const resolution = describeWindowsExecutorResolution();
    if (resolution.path) {
      const helper = spawnWindowsHelperProcess({
        helperPath: resolution.path,
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
        getStartBudgetMs: input.getWindowsStartBudgetMs,
      });
      Object.assign(helper, { ignoredRboEnvKeys });
      return helper as SpawnJobScriptResult;
    }
    if (input.requireWindowsJobObject || input.getWindowsStartBudgetMs) {
      throw new RboError(
        'process_spawn',
        `Windows Job Object helper required. ${resolution.detail}`,
      );
    }
  }

  const child = spawnNodeProcess({
    attemptId: input.attemptId,
    containmentId,
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
  requireWindowsJobObject?: boolean;
  getWindowsStartBudgetMs?: () => number;
  cancelSignal?: AbortSignal;
}): Promise<{ exitCode: number | null; timedOut: boolean; message?: string }> {
  if (!input.execution.cleanup_script) {
    return { exitCode: 0, timedOut: false };
  }
  const interruptionReason = () => {
    const reason: unknown = input.cancelSignal?.reason;
    return reason instanceof Error ? reason.message : 'lease expired';
  };
  const skipped = () => ({
    exitCode: null,
    timedOut: false,
    message: `Cleanup script skipped: ${interruptionReason()}`,
  });
  if (input.cancelSignal?.aborted) return skipped();

  const cleanupName = scriptFileName(input.execution.shell, 'cleanup');
  await writeJobScript(input.controlDir, input.execution, cleanupName);
  const cleanupContainmentId = `${input.attemptId}_cleanup`;
  const execution: ExecutionConfig = {
    ...input.execution,
    timeout_seconds: input.execution.cleanup_timeout_seconds ?? 60,
    // On POSIX the adapter coalesces kills. An earlier timeout must not leave
    // a grace period in progress when the active lease expires.
    ...(process.platform !== 'win32' && input.getWindowsStartBudgetMs
      ? { cancel_grace_seconds: 0 }
      : {}),
    completion: { type: 'run_to_exit' },
  };
  const budget = input.getWindowsStartBudgetMs?.();
  if (input.cancelSignal?.aborted || (budget !== undefined && budget <= 0)) {
    return skipped();
  }
  const child = spawnJobScript({
    ...input,
    execution,
    attemptId: input.attemptId,
    containmentId: cleanupContainmentId,
    scriptFileName: cleanupName,
  });
  let stopping: Promise<void> | undefined;
  const stop = (grace: number) => {
    stopping ??= child.kill(grace);
    return stopping;
  };
  const onCancel = () => {
    void stop(0).catch(() => undefined);
  };
  input.cancelSignal?.addEventListener('abort', onCancel, { once: true });
  if (input.cancelSignal?.aborted) onCancel();
  try {
    const result = await waitForCompletion({
      child,
      execution,
      logs: input.logs,
      signal: { cancelled: false },
    });
    if (input.cancelSignal?.aborted) {
      return {
        exitCode: null,
        timedOut: false,
        message: `Cleanup script interrupted: ${interruptionReason()}`,
      };
    }
    if (result.type === 'timeout') {
      await stop(execution.cancel_grace_seconds);
      return { exitCode: null, timedOut: true };
    }
    return { exitCode: result.type === 'exit' ? result.exitCode : null, timedOut: false };
  } finally {
    input.cancelSignal?.removeEventListener('abort', onCancel);
    try {
      if (input.getWindowsStartBudgetMs && process.platform !== 'win32') {
        // Sweep descendants still tagged for cleanup after the wrapper exits.
        await stop(0);
      } else {
        await stopping;
      }
    } finally {
      await child.waitForExit();
    }
  }
}
