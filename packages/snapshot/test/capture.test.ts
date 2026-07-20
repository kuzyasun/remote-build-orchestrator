import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { assertGitStateUnchanged, captureGitState } from '@rbo/testing';
import { describe, expect, it, vi } from 'vitest';
import { decompressTarZstd, parseTarArchive } from '../src/archive.js';
import { captureFullSnapshot, findCaseCollisions, findMountPathOverlaps } from '../src/capture.js';

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true });
}

async function createFixtureRepo(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'rbo-snapshot-'));
  await runGit(dir, ['init']);
  await runGit(dir, ['config', 'user.email', 'test@example.com']);
  await runGit(dir, ['config', 'user.name', 'Test User']);
  return {
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe('captureFullSnapshot (§11, Appendix C)', () => {
  it('captures tracked and untracked files in full mode', async () => {
    const { dir, cleanup } = await createFixtureRepo();
    const storage = await mkdtemp(join(tmpdir(), 'rbo-capture-'));
    try {
      await writeFile(join(dir, 'tracked.txt'), 'tracked-content');
      await runGit(dir, ['add', 'tracked.txt']);
      await runGit(dir, ['commit', '-m', 'init']);
      await writeFile(join(dir, 'untracked.txt'), 'untracked-content');

      const result = await captureFullSnapshot({
        projectRoot: dir,
        allowedProjectRoots: [dir],
        sourcePolicy: {
          include_untracked: true,
          include_ignored: [],
          secret_policy: 'block',
        },
        contentStorageDir: storage,
      });

      expect(result.manifest.payload.mode).toBe('full');
      expect(result.manifest.source.files.map((f) => f.path).sort()).toEqual([
        'tracked.txt',
        'untracked.txt',
      ]);
      const archive = await readFile(result.archivePath);
      const tar = decompressTarZstd(archive);
      const entries = parseTarArchive(tar);
      expect(entries.find((e) => e.path === 'untracked.txt')?.content.toString()).toBe(
        'untracked-content',
      );
    } finally {
      await cleanup();
      await rm(storage, { recursive: true, force: true });
    }
  }, 30_000);

  it('blocks secret denylist files', async () => {
    const { dir, cleanup } = await createFixtureRepo();
    const storage = await mkdtemp(join(tmpdir(), 'rbo-capture-'));
    try {
      await writeFile(join(dir, '.env'), 'SECRET=1');
      await runGit(dir, ['add', '.env']);
      await runGit(dir, ['commit', '-m', 'add env']);

      await expect(
        captureFullSnapshot({
          projectRoot: dir,
          allowedProjectRoots: [dir],
          sourcePolicy: {
            include_untracked: true,
            include_ignored: [],
            secret_policy: 'block',
          },
          contentStorageDir: storage,
        }),
      ).rejects.toMatchObject({ category: 'secret_blocked' });
    } finally {
      await cleanup();
      await rm(storage, { recursive: true, force: true });
    }
  }, 30_000);

  it('returns workspace_changed when HEAD changes during capture', async () => {
    const { dir, cleanup } = await createFixtureRepo();
    const storage = await mkdtemp(join(tmpdir(), 'rbo-capture-'));
    try {
      await writeFile(join(dir, 'stable.txt'), 'stable');
      await runGit(dir, ['add', 'stable.txt']);
      await runGit(dir, ['commit', '-m', 'init']);

      vi.resetModules();
      let statusCalls = 0;
      vi.doMock('../src/git-status.js', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../src/git-status.js')>();
        return {
          ...actual,
          gitStatusPorcelainV2: async (repoRoot: string) => {
            statusCalls += 1;
            const result = await actual.gitStatusPorcelainV2(repoRoot);
            if (statusCalls >= 2) {
              return { ...result, head: `${result.head}deadbeef` };
            }
            return result;
          },
        };
      });

      const { captureFullSnapshot: captureWithMock } = await import('../src/capture.js');
      await expect(
        captureWithMock({
          projectRoot: dir,
          allowedProjectRoots: [dir],
          sourcePolicy: {
            include_untracked: true,
            include_ignored: [],
            secret_policy: 'block',
          },
          contentStorageDir: storage,
        }),
      ).rejects.toMatchObject({ category: 'workspace_changed' });

      vi.doUnmock('../src/git-status.js');
      vi.resetModules();
    } finally {
      await cleanup();
      await rm(storage, { recursive: true, force: true });
    }
  }, 30_000);

  it('does not mutate source git state', async () => {
    const { dir, cleanup } = await createFixtureRepo();
    const storage = await mkdtemp(join(tmpdir(), 'rbo-capture-'));
    try {
      await writeFile(join(dir, 'stable.txt'), 'stable');
      await runGit(dir, ['add', 'stable.txt']);
      await runGit(dir, ['commit', '-m', 'init']);
      const before = await captureGitState(dir);

      await captureFullSnapshot({
        projectRoot: dir,
        allowedProjectRoots: [dir],
        sourcePolicy: {
          include_untracked: true,
          include_ignored: [],
          secret_policy: 'block',
        },
        contentStorageDir: storage,
      });

      const after = await captureGitState(dir);
      assertGitStateUnchanged(before, after);
    } finally {
      await cleanup();
      await rm(storage, { recursive: true, force: true });
    }
  }, 30_000);

  it('returns workspace_changed on concurrent file modification and removes partial capture storage', async () => {
    const { dir, cleanup } = await createFixtureRepo();
    const storage = await mkdtemp(join(tmpdir(), 'rbo-capture-'));
    try {
      await writeFile(join(dir, 'race.txt'), 'aaaaaaaaaa');
      await runGit(dir, ['add', 'race.txt']);
      await runGit(dir, ['commit', '-m', 'init']);

      vi.resetModules();
      let raceLstatCalls = 0;
      vi.doMock('node:fs/promises', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:fs/promises')>();
        return {
          ...actual,
          lstat: async (
            path: Parameters<typeof actual.lstat>[0],
            options?: Parameters<typeof actual.lstat>[1],
          ) => {
            const result = await actual.lstat(path, options);
            if (String(path).replace(/\\/g, '/').endsWith('/race.txt')) {
              raceLstatCalls += 1;
              if (raceLstatCalls >= 3) {
                return Object.assign(result, { mtimeMs: result.mtimeMs + 10_000 });
              }
            }
            return result;
          },
        };
      });

      const { captureFullSnapshot: captureWithMock } = await import('../src/capture.js');
      await expect(
        captureWithMock({
          projectRoot: dir,
          allowedProjectRoots: [dir],
          sourcePolicy: {
            include_untracked: true,
            include_ignored: [],
            secret_policy: 'block',
          },
          contentStorageDir: storage,
        }),
      ).rejects.toMatchObject({ category: 'workspace_changed' });

      expect(await readdir(storage)).toEqual([]);
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    } finally {
      await cleanup();
      await rm(storage, { recursive: true, force: true });
    }
  }, 30_000);

  it('returns workspace_changed when a file is replaced with same size', async () => {
    const { dir, cleanup } = await createFixtureRepo();
    const storage = await mkdtemp(join(tmpdir(), 'rbo-capture-'));
    try {
      await writeFile(join(dir, 'same-size.txt'), '0123456789');
      await runGit(dir, ['add', 'same-size.txt']);
      await runGit(dir, ['commit', '-m', 'init']);

      vi.resetModules();
      let sameSizeLstatCalls = 0;
      vi.doMock('node:fs/promises', async (importOriginal) => {
        const actual = await importOriginal<typeof import('node:fs/promises')>();
        return {
          ...actual,
          lstat: async (
            path: Parameters<typeof actual.lstat>[0],
            options?: Parameters<typeof actual.lstat>[1],
          ) => {
            const result = await actual.lstat(path, options);
            if (String(path).replace(/\\/g, '/').endsWith('/same-size.txt')) {
              sameSizeLstatCalls += 1;
              if (sameSizeLstatCalls >= 3) {
                return Object.assign(result, { mtimeMs: result.mtimeMs + 5_000 });
              }
            }
            return result;
          },
        };
      });

      const { captureFullSnapshot: captureWithMock } = await import('../src/capture.js');
      await expect(
        captureWithMock({
          projectRoot: dir,
          allowedProjectRoots: [dir],
          sourcePolicy: {
            include_untracked: true,
            include_ignored: [],
            secret_policy: 'block',
          },
          contentStorageDir: storage,
        }),
      ).rejects.toMatchObject({
        category: 'workspace_changed',
        details: { reason: 'file_identity_changed' },
      });

      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    } finally {
      await cleanup();
      await rm(storage, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('findCaseCollisions (pure)', () => {
  it('detects colliding paths under case-insensitive comparison', () => {
    expect(findCaseCollisions(['src/A.ts', 'src/a.ts', 'README.md'])).toEqual([
      ['src/A.ts', 'src/a.ts'],
    ]);
    expect(findCaseCollisions(['only.txt', 'other.txt'])).toEqual([]);
  });
});

describe('findMountPathOverlaps (pure)', () => {
  it('detects overlap with main_mount, nested mounts, and case-fold collisions', () => {
    expect(findMountPathOverlaps('project', ['vendor'])).toEqual([]);
    expect(findMountPathOverlaps('project', ['project'])).toEqual([['project', 'project']]);
    expect(findMountPathOverlaps('project', ['Project'])).toEqual([['project', 'Project']]);
    expect(findMountPathOverlaps('project', ['vendor', 'vendor/sub'])).toEqual([
      ['vendor', 'vendor/sub'],
    ]);
    expect(findMountPathOverlaps('project', ['project/vendor'])).toEqual([
      ['project', 'project/vendor'],
    ]);
  });
});
