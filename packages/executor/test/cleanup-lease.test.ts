import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ensureAttemptLogs } from '../src/logs.js';
import { runCleanupScript } from '../src/script.js';
import { resolveWindowsExecutorPath } from '../src/windows-executor-path.js';

const isWindows = process.platform === 'win32';

async function createCleanupFixture() {
  const workspacePath = await mkdtemp(join(tmpdir(), 'rbo-exec-cleanup-lease-'));
  return {
    attemptId: 'att_cleanup_lease',
    requireWindowsJobObject: true,
    controlDir: join(workspacePath, 'control'),
    workspacePath,
    projectPath: workspacePath,
    execution: {
      shell: isWindows ? ('cmd' as const) : ('sh' as const),
      script: 'echo primary',
      cleanup_script: `"${process.execPath}" -e "const fs = require('node:fs'); fs.writeFileSync('started', 'yes'); setTimeout(() => fs.writeFileSync('finished', 'yes'), 6000)"`,
      timeout_seconds: 30,
      cleanup_timeout_seconds: 10,
      cancel_grace_seconds: 1,
    },
    env: {},
    logs: await ensureAttemptLogs(join(workspacePath, 'logs')),
  };
}

it('checks cleanup authorization after writing the script and before launching it', async () => {
  const input = await createCleanupFixture();
  try {
    const getWindowsStartBudgetMs = vi.fn(() => {
      expect(existsSync(join(input.controlDir, isWindows ? 'cleanup.cmd' : 'cleanup.sh'))).toBe(
        true,
      );
      return 0;
    });
    await expect(runCleanupScript({ ...input, getWindowsStartBudgetMs })).resolves.toEqual({
      exitCode: null,
      timedOut: false,
      message: 'Cleanup script skipped: lease expired',
    });
    expect(getWindowsStartBudgetMs).toHaveBeenCalledOnce();
    expect(existsSync(join(input.workspacePath, 'started'))).toBe(false);
  } finally {
    await rm(input.workspacePath, { recursive: true, force: true });
  }
});

it.skipIf(isWindows && !resolveWindowsExecutorPath())(
  'interrupts an authorized cleanup and waits for its child to stop',
  async () => {
    const input = await createCleanupFixture();
    const cancel = new AbortController();
    const cleanup = runCleanupScript({
      ...input,
      cancelSignal: cancel.signal,
      getWindowsStartBudgetMs: () => 5_000,
    });
    try {
      await Promise.race([
        vi.waitFor(
          async () => {
            await expect(readFile(join(input.workspacePath, 'started'), 'utf8')).resolves.toBe(
              'yes',
            );
          },
          { timeout: 4_000 },
        ),
        cleanup.then(async (result) => {
          const stderr = await readFile(input.logs.stderrPath, 'utf8');
          throw new Error(
            `Cleanup stopped before the fixture started (${result.exitCode})\n${stderr}`,
          );
        }),
      ]);
      cancel.abort(new Error('lease expired'));
      await expect(cleanup).resolves.toEqual({
        exitCode: null,
        timedOut: false,
        message: 'Cleanup script interrupted: lease expired',
      });
      expect(existsSync(join(input.workspacePath, 'finished'))).toBe(false);
    } finally {
      cancel.abort(new Error('test finished'));
      await cleanup.catch(() => undefined);
      await rm(input.workspacePath, { recursive: true, force: true });
    }
  },
);
