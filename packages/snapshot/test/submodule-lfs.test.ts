import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { captureFullSnapshot, captureGitOverlaySnapshot } from '../src/capture.js';
import {
  assertLfsContentMaterialized,
  assertSubmodulesReadyForCapture,
  isLfsPointer,
  parseSubmoduleStatus,
} from '../src/git-source-policy.js';

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[], extraConfig: string[] = []): Promise<string> {
  const { stdout } = await execFileAsync('git', [...extraConfig, ...args], {
    cwd,
    windowsHide: true,
  });
  return stdout.trim();
}

async function addLocalSubmodule(
  parent: string,
  subBare: string,
  submodulePath: string,
): Promise<void> {
  const fileProto = ['-c', 'protocol.file.allow=always'];
  const subUrl = pathToFileURL(subBare).href;
  await runGit(parent, ['submodule', 'add', subUrl, submodulePath], fileProto);
}

async function createBaseRepo(dir: string): Promise<void> {
  await runGit(dir, ['init']);
  await runGit(dir, ['config', 'user.email', 'test@example.com']);
  await runGit(dir, ['config', 'user.name', 'Test User']);
  await runGit(dir, ['config', 'core.autocrlf', 'false']);
}

async function createSubmoduleFixture(): Promise<{
  parent: string;
  submodulePath: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'rbo-submod-fixture-'));
  const subWorking = join(root, 'sub-working');
  const subBare = join(root, 'sub.git');
  const parent = join(root, 'parent');

  await mkdir(subWorking, { recursive: true });
  await mkdir(parent, { recursive: true });
  await createBaseRepo(subWorking);
  await writeFile(join(subWorking, 'hello.txt'), 'sub-content');
  await runGit(subWorking, ['add', 'hello.txt']);
  await runGit(subWorking, ['commit', '-m', 'sub init']);
  await runGit(subWorking, ['clone', '--bare', subWorking, subBare]);

  await createBaseRepo(parent);
  await addLocalSubmodule(parent, subBare, 'vendor/lib');
  await runGit(parent, ['commit', '-m', 'add submodule']);

  return {
    parent,
    submodulePath: 'vendor/lib',
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe('git-source-policy helpers', () => {
  it('parses submodule status lines', () => {
    const parsed = parseSubmoduleStatus(` 1234567 vendor/lib (heads/main)
+89abcde vendor/other (v2)
-abcdef0 vendor/missing
U1111111 vendor/conflict`);
    expect(parsed).toEqual([
      { path: 'vendor/lib', state: 'clean', commit: '1234567' },
      { path: 'vendor/other', state: 'dirty', commit: '89abcde' },
      { path: 'vendor/missing', state: 'uninitialized', commit: 'abcdef0' },
      { path: 'vendor/conflict', state: 'conflict', commit: '1111111' },
    ]);
  });

  it('detects LFS pointer payloads', () => {
    const pointer = `version https://git-lfs.github.com/spec/v1
oid sha256:abcd
size 10
`;
    expect(isLfsPointer(pointer)).toBe(true);
    expect(isLfsPointer('real bytes')).toBe(false);
  });
});

describe('capture submodule policy (§11.14)', () => {
  it('captures initialized clean submodule files as ordinary paths', async () => {
    const fixture = await createSubmoduleFixture();
    const storage = await mkdtemp(join(tmpdir(), 'rbo-cap-submod-'));
    try {
      const result = await captureFullSnapshot({
        projectRoot: fixture.parent,
        allowedProjectRoots: [fixture.parent],
        sourcePolicy: {
          include_untracked: true,
          include_ignored: [],
          secret_policy: 'block',
        },
        contentStorageDir: storage,
      });
      expect(result.manifest.source.files.map((f) => f.path)).toContain('vendor/lib/hello.txt');
      expect(result.gitSourceRequirements.submodules).toBe(true);
      const entry = result.manifest.source.files.find((f) => f.path === 'vendor/lib/hello.txt');
      expect(entry?.type).toBe('file');
      const bytes = await readFile(
        join(storage, result.instance.snapshot_id, 'vendor/lib/hello.txt'),
      );
      expect(bytes.toString()).toBe('sub-content');
    } finally {
      await fixture.cleanup();
      await rm(storage, { recursive: true, force: true });
    }
  }, 60_000);

  it('fails on dirty submodule', async () => {
    const fixture = await createSubmoduleFixture();
    const storage = await mkdtemp(join(tmpdir(), 'rbo-cap-submod-dirty-'));
    try {
      await writeFile(join(fixture.parent, fixture.submodulePath, 'hello.txt'), 'dirty');
      await expect(
        captureFullSnapshot({
          projectRoot: fixture.parent,
          allowedProjectRoots: [fixture.parent],
          sourcePolicy: {
            include_untracked: true,
            include_ignored: [],
            secret_policy: 'block',
          },
          contentStorageDir: storage,
        }),
      ).rejects.toMatchObject({
        category: 'materialization',
        details: { reason: 'dirty_submodule', path: fixture.submodulePath },
      });
    } finally {
      await fixture.cleanup();
      await rm(storage, { recursive: true, force: true });
    }
  }, 60_000);

  it('fails on uninitialized submodule', async () => {
    const fixture = await createSubmoduleFixture();
    const storage = await mkdtemp(join(tmpdir(), 'rbo-cap-submod-uninit-'));
    try {
      await runGit(fixture.parent, ['submodule', 'deinit', '-f', fixture.submodulePath]);
      await expect(assertSubmodulesReadyForCapture(fixture.parent)).rejects.toMatchObject({
        category: 'materialization',
        details: { reason: 'uninitialized_submodule', path: fixture.submodulePath },
      });
    } finally {
      await fixture.cleanup();
      await rm(storage, { recursive: true, force: true });
    }
  }, 60_000);

  it('allows clean submodule state for git_overlay capture', async () => {
    const fixture = await createSubmoduleFixture();
    const storage = await mkdtemp(join(tmpdir(), 'rbo-cap-submod-overlay-'));
    try {
      await runGit(fixture.parent, [
        'remote',
        'add',
        'origin',
        'https://github.com/testuser/parent.git',
      ]);
      const result = await captureGitOverlaySnapshot({
        projectRoot: fixture.parent,
        allowedProjectRoots: [fixture.parent],
        sourcePolicy: {
          include_untracked: true,
          include_ignored: [],
          secret_policy: 'allow',
        },
        contentStorageDir: storage,
        repoUrl: 'https://github.com/testuser/parent.git',
      });
      expect(result.gitSourceRequirements.submodules).toBe(true);
    } finally {
      await fixture.cleanup();
      await rm(storage, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('capture LFS policy (§11.15)', () => {
  it('fails full capture when LFS pointer has no materialized content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rbo-lfs-pointer-'));
    const storage = await mkdtemp(join(tmpdir(), 'rbo-cap-lfs-'));
    try {
      await createBaseRepo(dir);
      await writeFile(
        join(dir, '.gitattributes'),
        'tracked.bin filter=lfs diff=lfs merge=lfs -text\n',
      );
      const pointer = `version https://git-lfs.github.com/spec/v1
oid sha256:0000000000000000000000000000000000000000000000000000000000000000
size 4
`;
      await writeFile(join(dir, 'tracked.bin'), pointer);
      await runGit(dir, ['add', '.gitattributes', 'tracked.bin']);
      await runGit(dir, ['commit', '-m', 'lfs pointer']);

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
      ).rejects.toMatchObject({
        category: 'materialization',
        details: { reason: 'lfs_content_missing' },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(storage, { recursive: true, force: true });
    }
  }, 30_000);

  it('passes LFS materialization check for real bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rbo-lfs-bytes-'));
    try {
      await createBaseRepo(dir);
      await writeFile(join(dir, 'payload.bin'), 'REAL');
      await expect(assertLfsContentMaterialized(dir, ['payload.bin'])).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
