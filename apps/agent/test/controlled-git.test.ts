import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { GitUrlAllowlist } from '@rbo/shared';
import { detectGitSourceRequirements } from '@rbo/snapshot';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyControlledGitSource,
  hasControlledGitLfsTrackedFiles,
  isControlledGitLfsAvailable,
} from '../src/repos/controlled-git.js';

vi.mock('node:child_process', async (importOriginal) => {
  const childProcess = await importOriginal<typeof import('node:child_process')>();
  return { ...childProcess, spawn: vi.fn(childProcess.spawn) };
});

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
  subBare: string;
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
  await addLocalSubmodule(parent, subBare, 'deps/lib');
  await runGit(parent, ['commit', '-m', 'parent']);

  return {
    parent,
    subBare,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe('applyControlledGitSource (§11.14)', () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    vi.unstubAllEnvs();
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

  it.each(['allowlisted', 'rewritten outside policy'] as const)(
    'validates a nested URL %s',
    async (destination) => {
      vi.stubEnv('GIT_ALLOW_PROTOCOL', 'file');
      const fixture = await createParentWithSubmodule();
      cleanup = fixture.cleanup;
      const child = join(fixture.parent, 'deps', 'lib');
      const nestedPath = 'nested lib';
      const nestedUrl = 'https://github.com/testuser/nested.git';
      const nested = join(child, nestedPath);
      await addLocalSubmodule(child, fixture.subBare, nestedPath);
      await writeFile(
        join(child, '.gitmodules'),
        `[submodule "${nestedPath}"]\n\tpath = ${nestedPath}\n\turl = "${nestedUrl}"\n`,
      );
      await runGit(child, ['add', '.gitmodules']);
      await runGit(
        child,
        ['commit', '-m', 'nested'],
        ['-c', 'user.name=T', '-c', 'user.email=t@example.com'],
      );
      await writeFile(
        join(fixture.parent, '.gitmodules'),
        `[submodule "deps/lib"]\n\tpath = deps/lib\n\turl = ${canonicalUrl}\n`,
      );
      await runGit(fixture.parent, ['add', '.gitmodules', 'deps/lib']);
      if (destination === 'rewritten outside policy') {
        await runGit(nested, ['remote', 'set-url', 'origin', nestedUrl]);
        await runGit(nested, [
          'config',
          'url.https://example.invalid/testuser/nested.git.insteadOf',
          nestedUrl,
        ]);
        await runGit(child, ['submodule', 'deinit', '-f', '--', nestedPath]);
      }
      const materialize = () =>
        applyControlledGitSource({
          repoRoot: fixture.parent,
          allowlist,
          submodules: true,
          lfs: false,
        });
      if (destination === 'allowlisted') {
        await expect(materialize()).resolves.toBeUndefined();
        await expect(runGit(nested, ['remote', 'get-url', 'origin'])).resolves.toBe(nestedUrl);
      } else {
        await expect(materialize()).rejects.toThrow(/Submodule URL rejected.*unknown_host/);
      }
    },
    // Windows Git fixture setup is slower under the full parallel suite.
    120_000,
  );
});

describe('controlled Git subprocess deadlines', () => {
  const spawnMock = vi.mocked(spawn);

  afterEach(() => {
    vi.useRealTimers();
    spawnMock.mockClear();
  });

  async function hangNextCommand(withDescendant: boolean) {
    const { spawn: spawnFixture } =
      await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const ready = Promise.withResolvers<void>();
    const closed = vi.fn();
    const idle = 'setTimeout(() => {}, 15000)';
    const fixture = withDescendant
      ? `
        const { spawn } = require('node:child_process');
        const leaf = spawn(process.execPath, ['-e', ${JSON.stringify(idle)}], {
          stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true,
        });
        leaf.once('spawn', () => process.stdout.write('ready'));
        ${idle};
        `
      : `process.stdout.write('ready'); ${idle};`;

    spawnMock.mockImplementationOnce((_command, _args, options) => {
      const child = spawnFixture(process.execPath, ['-e', fixture], {
        ...options,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.once('data', () => ready.resolve());
      child.once('error', ready.reject);
      child.once('close', closed);
      child.once('close', () =>
        ready.reject(new Error('Git test fixture exited before readiness')),
      );
      return child;
    });
    return { ready: ready.promise, closed };
  }

  it('terminates an active submodule command and waits for its pipes to close on abort', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rbo-agent-git-abort-'));
    const controller = new AbortController();
    try {
      await writeFile(join(root, '.gitmodules'), '');
      const { ready, closed } = await hangNextCommand(true);
      const reason = new Error('test source preparation cancelled');
      const rejected = expect(
        applyControlledGitSource({
          repoRoot: root,
          allowlist,
          submodules: true,
          lfs: false,
          signal: controller.signal,
        }),
      ).rejects.toBe(reason);
      await ready;
      controller.abort(reason);
      await rejected;
      expect(closed).toHaveBeenCalledOnce();
    } finally {
      controller.abort();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('terminates a hung LFS version probe at its deadline', async () => {
    const { ready, closed } = await hangNextCommand(false);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const rejected = expect(isControlledGitLfsAvailable()).rejects.toThrow(
      'git-lfs version timed out',
    );
    await ready;
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(closed).toHaveBeenCalledOnce();
  });

  it('does not start the LFS version probe after cancellation', async () => {
    const reason = new Error('test source preparation cancelled');
    await expect(isControlledGitLfsAvailable(AbortSignal.abort(reason))).rejects.toBe(reason);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('does not mask cancellation of the LFS tracked-file lookup during source detection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rbo-agent-git-detect-abort-'));
    const controller = new AbortController();
    try {
      await writeFile(join(root, '.gitattributes'), '*.bin filter=lfs\n');
      const { ready, closed } = await hangNextCommand(false);
      const reason = new Error('test source preparation cancelled');
      const rejected = expect(
        detectGitSourceRequirements(root, (repoRoot) =>
          hasControlledGitLfsTrackedFiles(repoRoot, controller.signal),
        ),
      ).rejects.toBe(reason);
      await ready;
      controller.abort(reason);
      await rejected;
      expect(closed).toHaveBeenCalledOnce();
    } finally {
      controller.abort();
      await rm(root, { recursive: true, force: true });
    }
  });
});
