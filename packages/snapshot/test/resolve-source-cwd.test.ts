import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { captureFullSnapshot, resolveSourceCwdForCapture } from '../src/capture.js';

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true });
}

describe('resolveSourceCwdForCapture', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup) {
        await cleanup();
      }
    }
  });

  async function createNestedPackageRepo(): Promise<{ root: string; pkg: string }> {
    const root = await mkdtemp(join(tmpdir(), 'rbo-nested-cwd-'));
    cleanups.push(async () => {
      await rm(root, { recursive: true, force: true });
    });
    await runGit(root, ['init']);
    await runGit(root, ['config', 'user.email', 'test@example.com']);
    await runGit(root, ['config', 'user.name', 'Test User']);
    const pkg = join(root, 'radev');
    await mkdir(pkg, { recursive: true });
    await writeFile(join(pkg, 'package.json'), '{"name":"radev"}\n');
    await writeFile(join(root, 'README.md'), 'monorepo\n');
    await runGit(root, ['add', '.']);
    await runGit(root, ['commit', '-m', 'init']);
    return { root, pkg };
  }

  it('derives cwd from nested project_root when cwd is default "."', async () => {
    const { root, pkg } = await createNestedPackageRepo();
    await expect(resolveSourceCwdForCapture(pkg, '.')).resolves.toBe('radev');
    await expect(resolveSourceCwdForCapture(pkg, undefined)).resolves.toBe('radev');
    await expect(resolveSourceCwdForCapture(root, '.')).resolves.toBe('.');
  });

  it('preserves an explicit non-default cwd', async () => {
    const { root, pkg } = await createNestedPackageRepo();
    await expect(resolveSourceCwdForCapture(pkg, 'docs')).resolves.toBe('docs');
    await expect(resolveSourceCwdForCapture(root, 'radev')).resolves.toBe('radev');
  });

  it('stores derived cwd on the snapshot manifest for nested project_root', async () => {
    const { root, pkg } = await createNestedPackageRepo();
    const storage = await mkdtemp(join(tmpdir(), 'rbo-nested-cwd-store-'));
    cleanups.push(async () => {
      await rm(storage, { recursive: true, force: true });
    });

    const captured = await captureFullSnapshot({
      projectRoot: pkg,
      allowedProjectRoots: [root],
      cwd: '.',
      sourcePolicy: {
        include_untracked: true,
        include_ignored: [],
        secret_policy: 'block',
      },
      contentStorageDir: storage,
    });

    expect(captured.manifest.workspace.cwd).toBe('radev');
  });
});
