import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { decompressTarZstd, parseTarArchive } from '../src/archive.js';
import { captureFullSnapshot } from '../src/capture.js';

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true });
}

async function createFixtureRepo(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'rbo-snap-scenario-'));
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

async function capture(repoDir: string, storage: string, overrides: Record<string, unknown> = {}) {
  return captureFullSnapshot({
    projectRoot: repoDir,
    allowedProjectRoots: [repoDir],
    sourcePolicy: {
      include_untracked: true,
      include_ignored: [],
      secret_policy: 'block',
    },
    contentStorageDir: storage,
    ...overrides,
  });
}

function pathsInManifest(result: Awaited<ReturnType<typeof captureFullSnapshot>>): string[] {
  return result.manifest.source.files.map((f) => f.path).sort();
}

/** Probe once: hosts without symlink privilege must skip symlink scenarios explicitly. */
const canCreateSymlinks: boolean = await (async () => {
  const probeDir = await mkdtemp(join(tmpdir(), 'rbo-symlink-probe-'));
  try {
    await writeFile(join(probeDir, 'target.txt'), 't');
    await symlink('target.txt', join(probeDir, 'link.txt'));
    return true;
  } catch {
    return false;
  } finally {
    await rm(probeDir, { recursive: true, force: true });
  }
})();

describe('captureFullSnapshot scenarios (§34.1 full mode)', () => {
  it('captures staged-only changes', async () => {
    const { dir, cleanup } = await createFixtureRepo();
    const storage = await mkdtemp(join(tmpdir(), 'rbo-cap-'));
    try {
      await writeFile(join(dir, 'base.txt'), 'base');
      await runGit(dir, ['add', 'base.txt']);
      await runGit(dir, ['commit', '-m', 'init']);
      await writeFile(join(dir, 'staged.txt'), 'staged');
      await writeFile(join(dir, 'unstaged.txt'), 'unstaged');
      await runGit(dir, ['add', 'staged.txt']);

      const result = await capture(dir, storage);
      expect(pathsInManifest(result)).toEqual(['base.txt', 'staged.txt', 'unstaged.txt']);
    } finally {
      await cleanup();
      await rm(storage, { recursive: true, force: true });
    }
  }, 30_000);

  it('captures unstaged-only modifications', async () => {
    const { dir, cleanup } = await createFixtureRepo();
    const storage = await mkdtemp(join(tmpdir(), 'rbo-cap-'));
    try {
      await writeFile(join(dir, 'tracked.txt'), 'v1');
      await runGit(dir, ['add', 'tracked.txt']);
      await runGit(dir, ['commit', '-m', 'init']);
      await writeFile(join(dir, 'tracked.txt'), 'v2-unstaged');

      const result = await capture(dir, storage);
      const archive = parseTarArchive(decompressTarZstd(await readFile(result.archivePath)));
      expect(archive.find((e) => e.path === 'tracked.txt')?.content.toString()).toBe('v2-unstaged');
    } finally {
      await cleanup();
      await rm(storage, { recursive: true, force: true });
    }
  }, 30_000);

  it('captures staged and unstaged changes to the same file', async () => {
    const { dir, cleanup } = await createFixtureRepo();
    const storage = await mkdtemp(join(tmpdir(), 'rbo-cap-'));
    try {
      await writeFile(join(dir, 'dual.txt'), 'committed');
      await runGit(dir, ['add', 'dual.txt']);
      await runGit(dir, ['commit', '-m', 'init']);
      await writeFile(join(dir, 'dual.txt'), 'worktree');
      await runGit(dir, ['add', 'dual.txt']);
      await writeFile(join(dir, 'dual.txt'), 'worktree-plus');

      const result = await capture(dir, storage);
      const archive = parseTarArchive(decompressTarZstd(await readFile(result.archivePath)));
      expect(archive.find((e) => e.path === 'dual.txt')?.content.toString()).toBe('worktree-plus');
    } finally {
      await cleanup();
      await rm(storage, { recursive: true, force: true });
    }
  }, 30_000);

  it('captures staged deletions', async () => {
    const { dir, cleanup } = await createFixtureRepo();
    const storage = await mkdtemp(join(tmpdir(), 'rbo-cap-'));
    try {
      await writeFile(join(dir, 'remove-me.txt'), 'gone');
      await runGit(dir, ['add', 'remove-me.txt']);
      await runGit(dir, ['commit', '-m', 'init']);
      await runGit(dir, ['rm', 'remove-me.txt']);

      const result = await capture(dir, storage);
      expect(pathsInManifest(result)).not.toContain('remove-me.txt');
    } finally {
      await cleanup();
      await rm(storage, { recursive: true, force: true });
    }
  }, 30_000);

  it('excludes gitignored files by default', async () => {
    const { dir, cleanup } = await createFixtureRepo();
    const storage = await mkdtemp(join(tmpdir(), 'rbo-cap-'));
    try {
      await writeFile(join(dir, '.gitignore'), 'ignored.tmp\n');
      await writeFile(join(dir, 'tracked.txt'), 'ok');
      await writeFile(join(dir, 'ignored.tmp'), 'secret');
      await runGit(dir, ['add', '.gitignore', 'tracked.txt']);
      await runGit(dir, ['commit', '-m', 'init']);

      const result = await capture(dir, storage);
      expect(pathsInManifest(result)).toContain('tracked.txt');
      expect(pathsInManifest(result)).not.toContain('ignored.tmp');
    } finally {
      await cleanup();
      await rm(storage, { recursive: true, force: true });
    }
  }, 30_000);

  it('includes explicitly requested ignored paths', async () => {
    const { dir, cleanup } = await createFixtureRepo();
    const storage = await mkdtemp(join(tmpdir(), 'rbo-cap-'));
    try {
      await writeFile(join(dir, '.gitignore'), 'ignored.tmp\n');
      await writeFile(join(dir, 'tracked.txt'), 'ok');
      await writeFile(join(dir, 'ignored.tmp'), 'included');
      await runGit(dir, ['add', '.gitignore', 'tracked.txt']);
      await runGit(dir, ['commit', '-m', 'init']);

      const result = await capture(dir, storage, {
        sourcePolicy: {
          include_untracked: true,
          include_ignored: ['ignored.tmp'],
          secret_policy: 'block',
        },
      });
      expect(pathsInManifest(result)).toContain('ignored.tmp');
    } finally {
      await cleanup();
      await rm(storage, { recursive: true, force: true });
    }
  }, 30_000);

  it('captures binary file content', async () => {
    const { dir, cleanup } = await createFixtureRepo();
    const storage = await mkdtemp(join(tmpdir(), 'rbo-cap-'));
    try {
      const binary = Buffer.from([0x00, 0x01, 0xff, 0xfe]);
      await writeFile(join(dir, 'binary.bin'), binary);
      await runGit(dir, ['add', 'binary.bin']);
      await runGit(dir, ['commit', '-m', 'init']);

      const result = await capture(dir, storage);
      const archive = parseTarArchive(decompressTarZstd(await readFile(result.archivePath)));
      expect(archive.find((e) => e.path === 'binary.bin')?.content).toEqual(binary);
    } finally {
      await cleanup();
      await rm(storage, { recursive: true, force: true });
    }
  }, 30_000);

  it('captures Unicode filenames', async () => {
    const { dir, cleanup } = await createFixtureRepo();
    const storage = await mkdtemp(join(tmpdir(), 'rbo-cap-'));
    try {
      const name = 'файл_тест.txt';
      await writeFile(join(dir, name), 'unicode');
      await runGit(dir, ['add', name]);
      await runGit(dir, ['commit', '-m', 'init']);

      const result = await capture(dir, storage);
      expect(pathsInManifest(result)).toContain(name);
    } finally {
      await cleanup();
      await rm(storage, { recursive: true, force: true });
    }
  }, 30_000);

  it('captures filenames with spaces', async () => {
    const { dir, cleanup } = await createFixtureRepo();
    const storage = await mkdtemp(join(tmpdir(), 'rbo-cap-'));
    try {
      const name = 'file with spaces.txt';
      await writeFile(join(dir, name), 'spaces');
      await runGit(dir, ['add', name]);
      await runGit(dir, ['commit', '-m', 'init']);

      const result = await capture(dir, storage);
      expect(pathsInManifest(result)).toContain(name);
    } finally {
      await cleanup();
      await rm(storage, { recursive: true, force: true });
    }
  }, 30_000);

  it('records executable bit via git index metadata', async () => {
    const { dir, cleanup } = await createFixtureRepo();
    const storage = await mkdtemp(join(tmpdir(), 'rbo-cap-'));
    try {
      await writeFile(join(dir, 'run.sh'), '#!/bin/sh\necho run\n');
      await runGit(dir, ['add', 'run.sh']);
      await runGit(dir, ['update-index', '--chmod=+x', 'run.sh']);
      await runGit(dir, ['commit', '-m', 'init']);

      const result = await capture(dir, storage);
      const entry = result.manifest.source.files.find((f) => f.path === 'run.sh');
      expect(entry?.mode).toBe('100755');
    } finally {
      await cleanup();
      await rm(storage, { recursive: true, force: true });
    }
  }, 30_000);

  // PLATFORM-GAP: OS denied symlink creation on this host — verify on Unix/macOS runner
  it.skipIf(!canCreateSymlinks)(
    'captures relative symlinks inside the workspace',
    async () => {
      const { dir, cleanup } = await createFixtureRepo();
      const storage = await mkdtemp(join(tmpdir(), 'rbo-cap-'));
      try {
        await writeFile(join(dir, 'target.txt'), 'target');
        await runGit(dir, ['add', 'target.txt']);
        await runGit(dir, ['commit', '-m', 'init']);
        await symlink('target.txt', join(dir, 'link.txt'));
        await runGit(dir, ['add', 'link.txt']);

        const result = await capture(dir, storage);
        const entry = result.manifest.source.files.find((f) => f.path === 'link.txt');
        expect(entry?.type).toBe('symlink');
        expect(entry?.target).toBe('target.txt');
      } finally {
        await cleanup();
        await rm(storage, { recursive: true, force: true });
      }
    },
    30_000,
  );

  // PLATFORM-GAP: OS denied symlink creation on this host — verify on Unix/macOS runner
  it.skipIf(!canCreateSymlinks)(
    'rejects absolute symlink targets',
    async () => {
      const { dir, cleanup } = await createFixtureRepo();
      const storage = await mkdtemp(join(tmpdir(), 'rbo-cap-'));
      try {
        await writeFile(join(dir, 'base.txt'), 'base');
        await runGit(dir, ['add', 'base.txt']);
        await runGit(dir, ['commit', '-m', 'init']);
        const absTarget = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc/hosts';
        await symlink(absTarget, join(dir, 'bad-link.txt'));
        await runGit(dir, ['add', 'bad-link.txt']);

        await expect(capture(dir, storage)).rejects.toThrow(
          /Absolute symlink|escapes allowed root|Symlink escapes/,
        );
      } finally {
        await cleanup();
        await rm(storage, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it('captures files from an additional root', async () => {
    const { dir, cleanup } = await createFixtureRepo();
    const extraRoot = await mkdtemp(join(tmpdir(), 'rbo-extra-'));
    const storage = await mkdtemp(join(tmpdir(), 'rbo-cap-'));
    try {
      await writeFile(join(dir, 'main.txt'), 'main');
      await runGit(dir, ['add', 'main.txt']);
      await runGit(dir, ['commit', '-m', 'init']);
      await mkdir(join(extraRoot, 'vendor'), { recursive: true });
      await writeFile(join(extraRoot, 'vendor', 'dep.txt'), 'dependency');

      const result = await captureFullSnapshot({
        projectRoot: dir,
        allowedProjectRoots: [dir, extraRoot],
        sourcePolicy: {
          include_untracked: true,
          include_ignored: [],
          secret_policy: 'block',
        },
        contentStorageDir: storage,
        additionalRoots: [
          {
            source_path: extraRoot,
            mount_path: 'vendor',
            include: ['vendor/**'],
            exclude: [],
          },
        ],
      });
      expect(pathsInManifest(result)).toEqual(['main.txt']);
      expect(result.manifest.additional_roots).toHaveLength(1);
      expect(result.manifest.additional_roots[0]?.mount).toBe('vendor');
      const { decompressTarZstd, parseTarArchive } = await import('../src/archive.js');
      const { readFile } = await import('node:fs/promises');
      const entries = parseTarArchive(decompressTarZstd(await readFile(result.archivePath)));
      expect(entries.map((e) => e.path)).toContain('vendor/vendor/dep.txt');
      // No duplicate archive entries for the additional root.
      expect(entries.filter((e) => e.path === 'vendor/vendor/dep.txt')).toHaveLength(1);
    } finally {
      await cleanup();
      await rm(extraRoot, { recursive: true, force: true });
      await rm(storage, { recursive: true, force: true });
    }
  }, 30_000);

  it('rejects additional roots that overlap main_mount or each other', async () => {
    const { dir, cleanup } = await createFixtureRepo();
    const extraA = await mkdtemp(join(tmpdir(), 'rbo-extra-a-'));
    const extraB = await mkdtemp(join(tmpdir(), 'rbo-extra-b-'));
    const storage = await mkdtemp(join(tmpdir(), 'rbo-cap-'));
    try {
      await writeFile(join(dir, 'main.txt'), 'main');
      await runGit(dir, ['add', 'main.txt']);
      await runGit(dir, ['commit', '-m', 'init']);
      await writeFile(join(extraA, 'a.txt'), 'a');
      await writeFile(join(extraB, 'b.txt'), 'b');

      const base = {
        projectRoot: dir,
        allowedProjectRoots: [dir, extraA, extraB],
        sourcePolicy: {
          include_untracked: true,
          include_ignored: [],
          secret_policy: 'block' as const,
        },
        contentStorageDir: storage,
      };

      await expect(
        captureFullSnapshot({
          ...base,
          additionalRoots: [
            {
              source_path: extraA,
              mount_path: 'project',
              include: ['**/*'],
              exclude: [],
            },
          ],
        }),
      ).rejects.toMatchObject({
        category: 'validation',
        message: expect.stringMatching(/overlap/i),
      });

      await expect(
        captureFullSnapshot({
          ...base,
          additionalRoots: [
            {
              source_path: extraA,
              mount_path: 'vendor',
              include: ['**/*'],
              exclude: [],
            },
            {
              source_path: extraB,
              mount_path: 'vendor/sub',
              include: ['**/*'],
              exclude: [],
            },
          ],
        }),
      ).rejects.toMatchObject({
        category: 'validation',
        message: expect.stringMatching(/overlap/i),
      });

      await expect(
        captureFullSnapshot({
          ...base,
          additionalRoots: [
            {
              source_path: extraA,
              mount_path: 'Vendor',
              include: ['**/*'],
              exclude: [],
            },
            {
              source_path: extraB,
              mount_path: 'vendor',
              include: ['**/*'],
              exclude: [],
            },
          ],
        }),
      ).rejects.toMatchObject({
        category: 'validation',
        message: expect.stringMatching(/overlap/i),
      });
    } finally {
      await cleanup();
      await rm(extraA, { recursive: true, force: true });
      await rm(extraB, { recursive: true, force: true });
      await rm(storage, { recursive: true, force: true });
    }
  }, 30_000);

  // PLATFORM-GAP: directory symlink/junction escape needs OS symlink privilege — verify on Unix/macOS runner
  it.skipIf(!canCreateSymlinks)(
    'rejects project roots that escape allowed roots via symlink',
    async (ctx) => {
      const allowed = await mkdtemp(join(tmpdir(), 'rbo-allowed-'));
      const outside = await mkdtemp(join(tmpdir(), 'rbo-outside-'));
      const storage = await mkdtemp(join(tmpdir(), 'rbo-cap-'));
      try {
        await writeFile(join(outside, 'tracked.txt'), 'tracked');
        await runGit(outside, ['init']);
        await runGit(outside, ['config', 'user.email', 'test@example.com']);
        await runGit(outside, ['config', 'user.name', 'Test User']);
        await runGit(outside, ['add', 'tracked.txt']);
        await runGit(outside, ['commit', '-m', 'init']);

        const linkPath = join(allowed, 'escape-link');
        try {
          await symlink(outside, linkPath, 'junction');
        } catch {
          try {
            await symlink(outside, linkPath, 'dir');
          } catch {
            // PLATFORM-GAP: directory symlink/junction unavailable on this host
            ctx.skip();
          }
        }

        await expect(
          captureFullSnapshot({
            projectRoot: linkPath,
            allowedProjectRoots: [allowed],
            sourcePolicy: {
              include_untracked: true,
              include_ignored: [],
              secret_policy: 'block',
            },
            contentStorageDir: storage,
          }),
        ).rejects.toMatchObject({ category: 'materialization' });
      } finally {
        await rm(allowed, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
        await rm(storage, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it.skipIf(process.platform === 'win32')(
    'captures newline in filename when the OS allows it',
    async () => {
      const { dir, cleanup } = await createFixtureRepo();
      const storage = await mkdtemp(join(tmpdir(), 'rbo-cap-'));
      try {
        const name = 'line\nbreak.txt';
        await writeFile(join(dir, name), 'newline');
        await runGit(dir, ['add', name]);
        await runGit(dir, ['commit', '-m', 'init']);

        const result = await capture(dir, storage);
        expect(pathsInManifest(result)).toContain(name);
      } finally {
        await cleanup();
        await rm(storage, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it.skipIf(process.platform !== 'win32')(
    'documents case-collision limitation on case-insensitive filesystems',
    async () => {
      // PLATFORM-GAP: creating FILE.txt + file.txt as distinct entries requires a
      // case-sensitive FS — verify end-to-end capture rejection on a Linux runner.
      // Pure decision logic is covered by findCaseCollisions unit tests.
      const { dir, cleanup } = await createFixtureRepo();
      const storage = await mkdtemp(join(tmpdir(), 'rbo-cap-'));
      try {
        await writeFile(join(dir, 'Case.txt'), 'upper');
        await runGit(dir, ['add', 'Case.txt']);
        await runGit(dir, ['commit', '-m', 'init']);
        expect(existsSync(join(dir, 'case.txt'))).toBe(true);
      } finally {
        await cleanup();
        await rm(storage, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
