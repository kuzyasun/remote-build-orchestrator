import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { GitUrlAllowlist } from '@rbo/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { applyControlledGitSource } from '../src/repos/controlled-git.js';

const execFileAsync = promisify(execFile);

const allowlist: GitUrlAllowlist = {
  schemes: ['https'],
  hosts: ['github.com'],
  repository_prefixes: ['testuser/'],
};

const canonicalUrl = 'https://github.com/testuser/submodule-overlay.git';

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

async function createParentWithSubmodule(): Promise<{
  parent: string;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'rbo-agent-submod-'));
  const subWorking = join(root, 'sub-working');
  const subBare = join(root, 'sub.git');
  const parent = join(root, 'parent');

  await mkdir(subWorking, { recursive: true });
  await mkdir(parent, { recursive: true });
  await runGit(subWorking, ['init']);
  await runGit(subWorking, ['config', 'user.email', 't@example.com']);
  await runGit(subWorking, ['config', 'user.name', 'T']);
  await writeFile(join(subWorking, 'lib.txt'), 'from-sub');
  await runGit(subWorking, ['add', 'lib.txt']);
  await runGit(subWorking, ['commit', '-m', 'sub']);
  await runGit(subWorking, ['clone', '--bare', subWorking, subBare]);

  await runGit(parent, ['init']);
  await runGit(parent, ['config', 'user.email', 't@example.com']);
  await runGit(parent, ['config', 'user.name', 'T']);
  await runGit(
    parent,
    ['submodule', 'add', pathToFileURL(subBare).href, 'deps/lib'],
    ['-c', 'protocol.file.allow=always'],
  );
  await runGit(parent, ['commit', '-m', 'parent']);

  return {
    parent,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe('applyControlledGitSource (§11.14)', () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
  });

  it('rejects submodule URLs outside the allowlist', async () => {
    const fixture = await createParentWithSubmodule();
    cleanup = fixture.cleanup;
    const worktree = await mkdtemp(join(tmpdir(), 'rbo-submod-worktree-'));
    await runGit(fixture.parent, ['clone', fixture.parent, worktree]);
    await runGit(worktree, ['submodule', 'deinit', '-f', 'deps/lib']);

    await expect(
      applyControlledGitSource({
        repoRoot: worktree,
        allowlist,
        submodules: true,
        lfs: false,
      }),
    ).rejects.toThrow(/not allowed by Git allowlist/);

    await rm(worktree, { recursive: true, force: true });
  }, 60_000);

  it('completes submodule sync for allowlisted .gitmodules', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'rbo-submod-allowlisted-'));
    await writeFile(
      join(worktree, '.gitmodules'),
      `[submodule "deps/lib"]\n\tpath = deps/lib\n\turl = ${canonicalUrl}\n`,
    );
    await runGit(worktree, ['init']);
    await runGit(worktree, ['config', 'user.email', 't@example.com']);
    await runGit(worktree, ['config', 'user.name', 'T']);

    await expect(
      applyControlledGitSource({
        repoRoot: worktree,
        allowlist,
        submodules: true,
        lfs: false,
      }),
    ).resolves.toBeUndefined();

    await rm(worktree, { recursive: true, force: true });
  }, 60_000);
});
