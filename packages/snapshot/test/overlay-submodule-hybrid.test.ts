import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { captureFullSnapshot, captureGitOverlaySnapshot } from '../src/capture.ts';

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

async function addLocalSubmodule(
  parent: string,
  subBare: string,
  submodulePath: string,
): Promise<void> {
  const fileProto = ['-c', 'protocol.file.allow=always'];
  const subUrl = pathToFileURL(subBare).href;
  await runGit(parent, ['submodule', 'add', subUrl, submodulePath], fileProto);
}

async function createSubmoduleFixture(): Promise<{
  parent: string;
  submodulePath: string;
  subWorking: string;
  subBare: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'rbo-submod-hybrid-fixture-'));
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
  await runGit(parent, ['remote', 'add', 'origin', 'https://github.com/example/parent.git']);
  await addLocalSubmodule(parent, subBare, 'vendor/lib');
  await runGit(parent, ['commit', '-m', 'add submodule']);

  return {
    parent,
    submodulePath: 'vendor/lib',
    subWorking,
    subBare,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe('git_overlay hybrid submodule capture (Approach A)', () => {
  it('fails on uninitialized submodule with actionable instructions', async () => {
    const fixture = await createSubmoduleFixture();
    const storage = await mkdtemp(join(tmpdir(), 'rbo-cap-hybrid-uninit-'));
    try {
      await runGit(fixture.parent, ['submodule', 'deinit', '-f', fixture.submodulePath]);
      await expect(
        captureGitOverlaySnapshot({
          projectRoot: fixture.parent,
          allowedProjectRoots: [fixture.parent],
          sourcePolicy: { include_untracked: true, include_ignored: [], secret_policy: 'block' },
          contentStorageDir: storage,
          repoUrl: 'https://github.com/example/parent.git',
        }),
      ).rejects.toMatchObject({
        category: 'materialization',
        message: expect.stringMatching(/git submodule update --init/),
        details: { reason: 'uninitialized_submodule' },
      });
    } finally {
      await fixture.cleanup();
      await rm(storage, { recursive: true, force: true });
    }
  }, 60_000);

  it('captures dirty submodule files and pins gitlink SHA', async () => {
    const fixture = await createSubmoduleFixture();
    const storage = await mkdtemp(join(tmpdir(), 'rbo-cap-hybrid-dirty-'));
    try {
      const subFilePath = join(fixture.parent, fixture.submodulePath, 'hello.txt');
      await writeFile(subFilePath, 'dirty-content-update');

      const result = await captureGitOverlaySnapshot({
        projectRoot: fixture.parent,
        allowedProjectRoots: [fixture.parent],
        sourcePolicy: { include_untracked: true, include_ignored: [], secret_policy: 'block' },
        contentStorageDir: storage,
        repoUrl: 'https://github.com/example/parent.git',
      });

      const gitlinkEntry = result.manifest.overlay.files.find((f) => f.path === 'vendor/lib');
      expect(gitlinkEntry).toBeDefined();
      expect(gitlinkEntry?.type).toBe('gitlink');
      if (gitlinkEntry?.type === 'gitlink') {
        expect(gitlinkEntry.mode).toBe('160000');
        expect(gitlinkEntry.commit).toMatch(/^[0-9a-f]{40}$/);
      }

      const dirtyFileEntry = result.manifest.overlay.files.find(
        (f) => f.path === 'vendor/lib/hello.txt',
      );
      expect(dirtyFileEntry).toBeDefined();
      expect(dirtyFileEntry?.type).toBe('file');

      const packedContent = await readFile(
        join(storage, result.instance.snapshot_id, 'overlay-staging', 'vendor/lib/hello.txt'),
      );
      expect(packedContent.toString()).toBe('dirty-content-update');
    } finally {
      await fixture.cleanup();
      await rm(storage, { recursive: true, force: true });
    }
  }, 60_000);

  it('captures clean pointer changes', async () => {
    const fixture = await createSubmoduleFixture();
    const storage = await mkdtemp(join(tmpdir(), 'rbo-cap-hybrid-pointer-'));
    try {
      // Create new commit in subWorking and push to subBare
      await writeFile(join(fixture.subWorking, 'new.txt'), 'new-file');
      await runGit(fixture.subWorking, ['add', 'new.txt']);
      await runGit(fixture.subWorking, ['commit', '-m', 'sub commit 2']);
      await runGit(fixture.subWorking, ['push', fixture.subBare, 'HEAD:main']);

      // Pull/checkout commit 2 inside parent's vendor/lib
      const subRepo = join(fixture.parent, fixture.submodulePath);
      const fileProto = ['-c', 'protocol.file.allow=always'];
      await runGit(subRepo, ['fetch', 'origin'], fileProto);
      await runGit(subRepo, ['checkout', 'FETCH_HEAD']);

      const subHead = await runGit(subRepo, ['rev-parse', 'HEAD']);

      const result = await captureGitOverlaySnapshot({
        projectRoot: fixture.parent,
        allowedProjectRoots: [fixture.parent],
        sourcePolicy: { include_untracked: true, include_ignored: [], secret_policy: 'block' },
        contentStorageDir: storage,
        repoUrl: 'https://github.com/example/parent.git',
      });

      const gitlinkEntry = result.manifest.overlay.files.find((f) => f.path === 'vendor/lib');
      expect(gitlinkEntry).toBeDefined();
      expect(gitlinkEntry?.type).toBe('gitlink');
      if (gitlinkEntry?.type === 'gitlink') {
        expect(gitlinkEntry.commit).toBe(subHead);
      }
      expect(
        result.manifest.overlay.files.find((f) => f.path === 'vendor/lib/new.txt'),
      ).toBeUndefined();
    } finally {
      await fixture.cleanup();
      await rm(storage, { recursive: true, force: true });
    }
  }, 60_000);

  it('regression: full snapshot still fails on dirty submodule', async () => {
    const fixture = await createSubmoduleFixture();
    const storage = await mkdtemp(join(tmpdir(), 'rbo-cap-full-regression-'));
    try {
      await writeFile(join(fixture.parent, fixture.submodulePath, 'hello.txt'), 'dirty-full');
      await expect(
        captureFullSnapshot({
          projectRoot: fixture.parent,
          allowedProjectRoots: [fixture.parent],
          sourcePolicy: { include_untracked: true, include_ignored: [], secret_policy: 'block' },
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
});
