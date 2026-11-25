import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ensureAttemptLogs } from '../src/logs.js';
import { runCleanupScript, spawnJobScript, writeJobScript } from '../src/script.js';
import { describeWindowsExecutorResolution } from '../src/windows-executor-path.js';

vi.mock('../src/windows-executor-path.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/windows-executor-path.js')>()),
  describeWindowsExecutorResolution: vi.fn(),
}));

describe.skipIf(process.platform !== 'win32')('required Windows Job Object containment', () => {
  it('rejects both job and cleanup scripts when the native helper is missing', async () => {
    vi.mocked(describeWindowsExecutorResolution).mockReturnValue({
      path: null,
      reason: 'not_installed',
      detail: 'The Windows executor package is missing.',
    });
    const workspace = await mkdtemp(join(tmpdir(), 'rbo-exec-require-job-object-'));
    try {
      const input = {
        attemptId: 'att_require_job_object',
        requireWindowsJobObject: true,
        controlDir: join(workspace, 'control'),
        workspacePath: workspace,
        projectPath: workspace,
        execution: {
          shell: 'cmd' as const,
          script: 'exit /b 0',
          cleanup_script: 'exit /b 0',
          timeout_seconds: 10,
          cancel_grace_seconds: 1,
        },
        env: {},
        logs: await ensureAttemptLogs(join(workspace, 'logs')),
      };
      await writeJobScript(input.controlDir, input.execution);
      expect(() => spawnJobScript(input)).toThrow(/Windows Job Object helper required/);
      await expect(runCleanupScript(input)).rejects.toThrow(/Windows Job Object helper required/);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
