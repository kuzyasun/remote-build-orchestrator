import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

const injectedStatusFailure = vi.hoisted(() => ({ cwd: '' }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const mockedExecFile = ((...args: unknown[]) => {
    const [file, gitArgs, options, callback] = args;
    const optCwd =
      typeof options === 'object' && options !== null
        ? (options as { cwd?: string }).cwd
        : undefined;
    const targetCwd = injectedStatusFailure.cwd;
    const isMatchingCwd = Boolean(
      targetCwd &&
        optCwd &&
        (optCwd.replace(/\\/g, '/').toLowerCase() === targetCwd.replace(/\\/g, '/').toLowerCase() ||
          optCwd.replace(/\\/g, '/').toLowerCase().endsWith('/vendor/lib')),
    );
    const shouldFail =
      file === 'git' &&
      Array.isArray(gitArgs) &&
      gitArgs.join('\0') === 'submodule\0status\0--recursive' &&
      isMatchingCwd;
    if (shouldFail && typeof callback === 'function') {
      const error = Object.assign(new Error('injected submodule status failure'), {
        stderr: 'injected submodule status failure',
      });
      queueMicrotask(() => (callback as (error: Error) => void)(error));
      return undefined;
    }
    return Reflect.apply(actual.execFile, undefined, args);
  }) as typeof actual.execFile;
  Object.defineProperty(mockedExecFile, Symbol.for('nodejs.util.promisify.custom'), {
    value: (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        mockedExecFile(...args, (error: Error | null, stdout: string, stderr: string) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({ stdout, stderr });
        });
      }),
  });
  return {
    ...actual,
    execFile: mockedExecFile,
  };
});

import { captureGitOverlaySnapshot } from '../src/capture.ts';

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[], extraConfig: string[] = []): Promise<string> {
  const { stdout } = await execFileAsync('git', [...extraConfig, ...args], {
    cwd,
    windowsHide: true,
  });
  return stdout.trim();
}

async function createBaseRepo(dir: string): Promise<void> {
  await runGit(dir, ['init']);
  await runGit(dir, ['config', 'user.email', 'test@example.com']);
  await runGit(dir, ['config', 'user.name', 'Test User']);
  await runGit(dir, ['config', 'core.autocrlf', 'false']);
}

describe('git_overlay recursive submodule status failures', () => {
  it('fails closed instead of producing a partial overlay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rbo-submod-status-recursive-'));
    const subWorking = join(root, 'sub-working');
    const subBare = join(root, 'sub.git');
    const parent = join(root, 'parent');
    const storage = await mkdtemp(join(tmpdir(), 'rbo-submod-status-storage-'));
    try {
      await mkdir(subWorking, { recursive: true });
      await mkdir(parent, { recursive: true });
      await createBaseRepo(subWorking);
      await writeFile(join(subWorking, 'hello.txt'), 'sub-content');
      await runGit(subWorking, ['add', 'hello.txt']);
      await runGit(subWorking, ['commit', '-m', 'sub init']);
      await runGit(subWorking, ['clone', '--bare', subWorking, subBare]);

      await createBaseRepo(parent);
      await runGit(parent, ['remote', 'add', 'origin', 'https://github.com/example/parent.git']);
      await runGit(
        parent,
        ['submodule', 'add', pathToFileURL(subBare).href, 'vendor/lib'],
        ['-c', 'protocol.file.allow=always'],
      );
      await runGit(parent, ['commit', '-m', 'add submodule']);

      injectedStatusFailure.cwd = join(parent, 'vendor/lib');
      await expect(
        captureGitOverlaySnapshot({
          projectRoot: parent,
          allowedProjectRoots: [parent],
          sourcePolicy: { include_untracked: true, include_ignored: [], secret_policy: 'block' },
          contentStorageDir: storage,
          repoUrl: 'https://github.com/example/parent.git',
        }),
      ).rejects.toMatchObject({
        category: 'materialization',
        retryable: true,
        details: { reason: 'submodule_status_failed' },
      });
      expect(
        (await readdir(storage, { recursive: true })).some((path) => path.endsWith('.tar.zst')),
      ).toBe(false);
      expect((await readdir(storage)).filter((path) => path.startsWith('snp_'))).toEqual([]);
    } finally {
      injectedStatusFailure.cwd = '';
      await rm(root, { recursive: true, force: true });
      await rm(storage, { recursive: true, force: true });
    }
  }, 60_000);
});
