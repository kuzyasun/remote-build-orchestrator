import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ensureAttemptLogs } from '../src/logs.js';
import { spawnJobScript, writeJobScript } from '../src/script.js';
import { describeWindowsExecutorResolution } from '../src/windows-executor-path.js';

const execFileAsync = promisify(execFile);

async function pidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs: number, diagnostic: string): Promise<void> {
  const startedAt = Date.now();
  while (await pidAlive(pid)) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(
        `Process ${pid} remained alive after ${Date.now() - startedAt}ms; ${diagnostic}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('process containment (§15.2)', () => {
  // PLATFORM-GAP: Unix process-group kill requires POSIX setsid/SIGTERM semantics — verify on a Unix/macOS runner
  it.skipIf(process.platform === 'win32')(
    'cancel kills child and grandchild on Unix via process group',
    async () => {
      const workspace = await mkdtemp(join(tmpdir(), 'rbo-exec-cancel-'));
      const controlDir = join(workspace, 'control');
      const logs = await ensureAttemptLogs(join(workspace, 'logs'));
      try {
        const script = `#!/bin/bash
set -e
CHILD=""
cleanup() { [ -n "$CHILD" ] && kill -TERM "$CHILD" 2>/dev/null || true; }
trap cleanup EXIT
bash -c 'sleep 120' &
CHILD=$!
wait "$CHILD"
`;
        await writeJobScript(controlDir, {
          shell: 'bash',
          script,
          timeout_seconds: 120,
          cancel_grace_seconds: 1,
        });
        const child = spawnJobScript({
          attemptId: 'att_test',
          controlDir,
          workspacePath: workspace,
          projectPath: workspace,
          execution: {
            shell: 'bash',
            script,
            timeout_seconds: 120,
            cancel_grace_seconds: 1,
          },
          env: {},
          logs,
        });

        await new Promise((r) => setTimeout(r, 500));
        const pgrep = await execFileAsync('pgrep', ['-P', String(child.pid)]).catch(() => ({
          stdout: '',
        }));
        const grandchildPid = Number.parseInt(String(pgrep.stdout).trim().split('\n')[0] ?? '', 10);
        expect(Number.isFinite(grandchildPid)).toBe(true);

        await child.kill(1);
        await child.waitForExit();

        await new Promise((r) => setTimeout(r, 500));
        expect(await pidAlive(child.pid)).toBe(false);
        if (grandchildPid) {
          expect(await pidAlive(grandchildPid)).toBe(false);
        }
      } finally {
        await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    },
    30_000,
  );

  // Regression test for the QEMU-serial "0 bytes" bug: a backgrounded process
  // left running in its own process group (job control, or any tool that calls
  // setsid/double-forks) used to be invisible to `process.kill(-pgid, …)` and
  // leaked forever on cancel. killTree now also walks the actual descendant
  // tree by parent/child lineage, which finds it regardless of process group.
  it.skipIf(process.platform === 'win32')(
    'cancel still reaps a backgrounded child that has its own process group',
    async () => {
      const workspace = await mkdtemp(join(tmpdir(), 'rbo-exec-cancel-owngroup-'));
      const controlDir = join(workspace, 'control');
      const logs = await ensureAttemptLogs(join(workspace, 'logs'));
      try {
        const script = `#!/bin/bash
set -m
sleep 120 &
CHILD=$!
echo "CHILD_PID=$CHILD"
wait "$CHILD"
`;
        await writeJobScript(controlDir, {
          shell: 'bash',
          script,
          timeout_seconds: 120,
          cancel_grace_seconds: 1,
        });
        const child = spawnJobScript({
          attemptId: 'att_test_owngroup',
          controlDir,
          workspacePath: workspace,
          projectPath: workspace,
          execution: {
            shell: 'bash',
            script,
            timeout_seconds: 120,
            cancel_grace_seconds: 1,
          },
          env: {},
          logs,
        });

        await new Promise((r) => setTimeout(r, 500));
        const pgrep = await execFileAsync('pgrep', ['-P', String(child.pid)]).catch(() => ({
          stdout: '',
        }));
        const grandchildPid = Number.parseInt(String(pgrep.stdout).trim().split('\n')[0] ?? '', 10);
        expect(Number.isFinite(grandchildPid)).toBe(true);

        // Sanity-check the precondition: job control actually put `sleep` in a
        // different process group from the wrapper, so a plain `-pid` group
        // signal alone would miss it.
        const wrapperPgid = (
          await execFileAsync('ps', ['-o', 'pgid=', String(child.pid)])
        ).stdout.trim();
        const childPgid = (
          await execFileAsync('ps', ['-o', 'pgid=', String(grandchildPid)])
        ).stdout.trim();
        expect(childPgid).not.toBe(wrapperPgid);

        await child.kill(1);
        await child.waitForExit();

        await new Promise((r) => setTimeout(r, 500));
        expect(await pidAlive(child.pid)).toBe(false);
        expect(await pidAlive(grandchildPid)).toBe(false);
      } finally {
        await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    },
    30_000,
  );

  // A descendant that traps SIGTERM keeps running through the grace period and
  // can spawn more children in it. Those are absent from the pre-signal snapshot,
  // and re-walking from the wrapper alone finds nothing (it is already dead and
  // survivors were reparented to init), so SIGKILL used to miss them entirely.
  it.skipIf(process.platform === 'win32')(
    'reaps a grandchild spawned during the cancel grace period',
    async () => {
      const workspace = await mkdtemp(join(tmpdir(), 'rbo-exec-grace-'));
      const controlDir = join(workspace, 'control');
      const logs = await ensureAttemptLogs(join(workspace, 'logs'));
      // The grandchild records its own pid so we assert on that exact process,
      // rather than pattern-matching a command line that a leaked process from an
      // earlier run could also match.
      const pidFile = join(workspace, 'grandchild.pid');
      try {
        const script = `bash -c 'trap "" TERM; sleep 1.2; sleep 300 & echo $! > ${pidFile}; wait' &
echo BG_STARTED
wait
`;
        const execution = {
          shell: 'bash' as const,
          script,
          timeout_seconds: 60,
          cancel_grace_seconds: 3,
          cleanup_timeout_seconds: 30,
        };
        await writeJobScript(controlDir, execution);
        const child = spawnJobScript({
          attemptId: 'att_grace',
          controlDir,
          workspacePath: workspace,
          projectPath: workspace,
          execution,
          env: {},
          logs,
        });

        await new Promise((r) => setTimeout(r, 400));
        // Grandchild is spawned ~1.2s into this 3s grace window.
        await child.kill(3);
        await child.waitForExit();
        await new Promise((r) => setTimeout(r, 800));

        const grandchildPid = Number.parseInt((await readFile(pidFile, 'utf8')).trim(), 10);
        // Guard against the test silently passing because the grandchild never
        // got spawned (which would make the assertion below vacuous).
        expect(Number.isFinite(grandchildPid)).toBe(true);
        expect(await pidAlive(grandchildPid)).toBe(false);
      } finally {
        await readFile(pidFile, 'utf8')
          .then((raw) => {
            const leaked = Number.parseInt(raw.trim(), 10);
            if (Number.isFinite(leaked)) {
              try {
                process.kill(leaked, 'SIGKILL');
              } catch {
                // already gone
              }
            }
          })
          .catch(() => undefined);
        await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    },
    30_000,
  );

  // Without job control, `kill -TERM "-$(ps -o pgid= "$BG_PID")"` resolves the
  // *wrapper's* pgid (the background job shares it), so a cleanup trap using
  // this common idiom signals the wrapper itself: cleanup dies half-done and the
  // job reports the signal instead of its real exit code. This is the concrete
  // breakage behind DTrack's ci/qemu/run_qemu_tests.sh cleanup().
  it.skipIf(process.platform === 'win32')(
    'a cleanup trap that group-kills its background job does not kill the wrapper',
    async () => {
      const workspace = await mkdtemp(join(tmpdir(), 'rbo-exec-selfkill-'));
      const controlDir = join(workspace, 'control');
      const logs = await ensureAttemptLogs(join(workspace, 'logs'));
      try {
        const script = `BG=""
cleanup() {
  if [ -n "$BG" ] && kill -0 "$BG" 2>/dev/null; then
    PGID="$(ps -o pgid= "$BG" | tr -d ' ' || true)"
    kill -TERM "-\${PGID:-$BG}" 2>/dev/null || true
  fi
  echo CLEANUP_COMPLETED
}
trap cleanup EXIT
sleep 300 &
BG=$!
echo BODY_DONE
exit 7
`;
        const execution = {
          shell: 'bash' as const,
          script,
          timeout_seconds: 60,
          cancel_grace_seconds: 5,
          cleanup_timeout_seconds: 30,
        };
        await writeJobScript(controlDir, execution);
        const child = spawnJobScript({
          attemptId: 'att_selfkill',
          controlDir,
          workspacePath: workspace,
          projectPath: workspace,
          execution,
          env: {},
          logs,
        });

        let out = '';
        child.stdout.on('data', (c: Buffer) => {
          out += c.toString();
        });
        const result = await child.waitForExit();

        expect(out).toContain('BODY_DONE');
        // The trap must run all the way through rather than being cut short by
        // its own signal, and the script's real exit code must survive.
        expect(out).toContain('CLEANUP_COMPLETED');
        expect(result.signal).toBeNull();
        expect(result.exitCode).toBe(7);
      } finally {
        await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    },
    30_000,
  );

  it('timeout kills a long-running script', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'rbo-exec-timeout-'));
    const controlDir = join(workspace, 'control');
    const logs = await ensureAttemptLogs(join(workspace, 'logs'));
    try {
      const isWin = process.platform === 'win32';
      const script = isWin ? 'Start-Sleep -Seconds 120' : '#!/bin/bash\nsleep 120';
      await writeJobScript(controlDir, {
        shell: isWin ? 'powershell' : 'bash',
        script,
        timeout_seconds: 1,
        cancel_grace_seconds: 1,
      });

      const child = spawnJobScript({
        attemptId: 'att_timeout',
        controlDir,
        workspacePath: workspace,
        projectPath: workspace,
        execution: {
          shell: isWin ? 'powershell' : 'bash',
          script,
          timeout_seconds: 1,
          cancel_grace_seconds: 1,
        },
        env: {},
        logs,
      });

      await Promise.race([
        child.waitForExit(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('timeout_seconds did not terminate the script')),
            15_000,
          ),
        ),
      ]);
      expect(await pidAlive(child.pid)).toBe(false);
    } finally {
      await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 30_000);

  it.skipIf(process.platform !== 'win32')(
    'cancel kills child and grandchild on Windows via the Job Object helper',
    async () => {
      const helper = describeWindowsExecutorResolution();
      expect(helper.path, helper.detail).not.toBeNull();

      const workspace = await mkdtemp(join(tmpdir(), 'rbo-exec-cancel-win-'));
      const controlDir = join(workspace, 'control');
      const logs = await ensureAttemptLogs(join(workspace, 'logs'));
      const pidFile = join(workspace, 'grandchild.pid');
      let grandchildPid: number | undefined;
      try {
        const script = `$ErrorActionPreference = 'Stop'
$p = Start-Process -FilePath ping -ArgumentList '-n','120','127.0.0.1' -PassThru -WindowStyle Hidden
Set-Content -LiteralPath '${pidFile.replace(/'/g, "''")}' -Value $p.Id
Wait-Process -Id $p.Id
`;
        const execution = {
          shell: 'powershell' as const,
          script,
          timeout_seconds: 120,
          cancel_grace_seconds: 2,
        };
        await writeJobScript(controlDir, execution);
        const child = spawnJobScript({
          attemptId: 'att_win_cancel',
          controlDir,
          workspacePath: workspace,
          projectPath: workspace,
          execution,
          env: {},
          logs,
        });

        const deadline = Date.now() + 8_000;
        while (Date.now() < deadline) {
          try {
            await readFile(pidFile, 'utf8');
            break;
          } catch {
            await new Promise((r) => setTimeout(r, 100));
          }
        }
        grandchildPid = Number.parseInt((await readFile(pidFile, 'utf8')).trim(), 10);
        expect(Number.isFinite(grandchildPid)).toBe(true);

        await child.kill(1);
        await child.waitForExit();
        await waitForPidExit(
          grandchildPid,
          5_000,
          `backend=Windows Job Object helper (${helper.detail})`,
        );
        expect(await pidAlive(child.pid)).toBe(false);
        expect(await pidAlive(grandchildPid)).toBe(false);
      } finally {
        if (grandchildPid !== undefined) {
          await execFileAsync('taskkill', ['/F', '/PID', String(grandchildPid)], {
            windowsHide: true,
          }).catch(() => undefined);
        }
        await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    },
    30_000,
  );
});
