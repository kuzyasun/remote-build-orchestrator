import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ensureAttemptLogs } from '../src/logs.js';
import { spawnJobScript, writeJobScript } from '../src/script.js';

const execFileAsync = promisify(execFile);

async function pidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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
});
