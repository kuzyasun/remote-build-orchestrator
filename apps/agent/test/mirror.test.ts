import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { type GitUrlAllowlist, computeRepoKey } from '@rbo/shared';
import { createGitFixtureRepo } from '@rbo/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGitMutation } from '../src/repos/mirror-git.js';
import {
  DEFAULT_REPO_CACHE_CONFIG,
  type MirrorMetadata,
  RepoMirrorManager,
} from '../src/repos/mirror.js';

const execFileAsync = promisify(execFile);

const allowlist: GitUrlAllowlist = {
  schemes: ['https', 'ssh'],
  hosts: ['github.com'],
  repository_prefixes: ['testuser/'],
};

const canonicalUrl = 'https://github.com/testuser/testrepo.git';

function toGitOsPath(input: string): string {
  let path = input;
  if (process.platform === 'win32') {
    if (path.startsWith('\\\\?\\')) {
      path = path.slice(4);
    }
    path = path.replace(/\//g, '\\');
  }
  return path;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    encoding: 'utf8',
  });
  return stdout.trim();
}

async function runGitDir(gitDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: gitDir,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    encoding: 'utf8',
  });
  return stdout.trim();
}

async function seedMirrorFromFixture(
  reposDir: string,
  url: string,
  fixtureRoot: string,
): Promise<{ repoKey: string; mirrorPath: string; head: string }> {
  const repoKey = computeRepoKey(url);
  const repoDir = join(reposDir, repoKey);
  const mirrorPath = join(repoDir, 'mirror.git');
  await mkdir(repoDir, { recursive: true });
  await runGit(repoDir, ['clone', '--mirror', fixtureRoot, 'mirror.git']);
  const head = await runGitDir(mirrorPath, ['rev-parse', 'HEAD']);
  const metadata: MirrorMetadata = {
    repo_key: repoKey,
    canonical_id: 'github.com/testuser/testrepo',
    url,
    last_used_at: new Date().toISOString(),
    active_worktree_count: 0,
  };
  await writeFile(join(repoDir, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  return { repoKey, mirrorPath, head };
}

describe('RepoMirrorManager', () => {
  let reposDir: string;
  let workspacesDir: string;
  let manager: RepoMirrorManager;

  beforeEach(async () => {
    reposDir = await mkdir(join(tmpdir(), `rbo-mirror-repos-${Date.now()}`), {
      recursive: true,
    }).then((p) => p);
    workspacesDir = join(dirname(reposDir), `rbo-mirror-ws-${Date.now()}`);
    await mkdir(workspacesDir, { recursive: true });
    manager = new RepoMirrorManager({
      reposDir,
      allowlist,
      repoCache: { ...DEFAULT_REPO_CACHE_CONFIG },
    });
  });

  afterEach(async () => {
    await rm(reposDir, { recursive: true, force: true });
    await rm(workspacesDir, { recursive: true, force: true });
  });

  describe('allowlist enforcement', () => {
    it('rejects file:// URLs before clone/fetch/bundle import', async () => {
      await expect(manager.ensureMirror('file:///tmp/evil.git')).rejects.toThrow(
        /not allowed|rejected/i,
      );
      await expect(manager.fetchRefs('file:///tmp/evil.git', ['refs/heads/main'])).rejects.toThrow(
        /not allowed|rejected/i,
      );
      await expect(
        manager.importBundle('file:///tmp/evil.git', '/tmp/bundle', 'b1'),
      ).rejects.toThrow(/not allowed|rejected/i);
    });

    it('rejects local paths', async () => {
      await expect(manager.ensureMirror('C:/repos/app.git')).rejects.toThrow(
        /not allowed|rejected/i,
      );
      await expect(manager.ensureMirror('/home/me/app.git')).rejects.toThrow(
        /not allowed|rejected/i,
      );
    });

    it('rejects unknown hosts', async () => {
      await expect(
        manager.ensureMirror('https://evil.example.com/testuser/testrepo.git'),
      ).rejects.toThrow(/not allowed|rejected/i);
    });

    it('rejects repository prefix mismatches', async () => {
      await expect(manager.ensureMirror('https://github.com/other/repo.git')).rejects.toThrow(
        /not allowed|rejected/i,
      );
    });
  });

  describe('commit presence', () => {
    it('detects present vs missing commits in the mirror', async () => {
      const fixture = await createGitFixtureRepo({
        committed: [{ path: 'readme.txt', content: 'hello' }],
      });
      try {
        const { repoKey, head } = await seedMirrorFromFixture(reposDir, canonicalUrl, fixture.root);
        await expect(manager.hasCommit(repoKey, head)).resolves.toBe(true);
        await expect(
          manager.hasCommit(repoKey, '0000000000000000000000000000000000000000'),
        ).resolves.toBe(false);
      } finally {
        await fixture.cleanup();
      }
    });
  });

  describe('worktree lifecycle', () => {
    it('creates and removes a detached worktree without deleting the mirror', async () => {
      const fixture = await createGitFixtureRepo({
        committed: [{ path: 'keep.txt', content: 'stay' }],
      });
      try {
        const { head } = await seedMirrorFromFixture(reposDir, canonicalUrl, fixture.root);
        const worktreePath = join(workspacesDir, 'attempt-1', 'project');
        await manager.createWorktree(canonicalUrl, head, worktreePath);
        expect(await runGit(worktreePath, ['rev-parse', 'HEAD'])).toBe(head);
        const metadata = JSON.parse(
          await readFile(join(reposDir, computeRepoKey(canonicalUrl), 'metadata.json'), 'utf8'),
        ) as MirrorMetadata;
        expect(metadata.active_worktree_count).toBe(1);

        await manager.removeWorktree(canonicalUrl, worktreePath);
        const finish = vi.fn(async () => {});
        await manager.tryCleanupWorktree(canonicalUrl, worktreePath, async () => true, finish);
        expect(finish).toHaveBeenCalledOnce();
        await expect(runGit(worktreePath, ['rev-parse', 'HEAD'])).rejects.toThrow();
        const mirrorPath = join(reposDir, computeRepoKey(canonicalUrl), 'mirror.git');
        await expect(runGitDir(mirrorPath, ['rev-parse', 'HEAD'])).resolves.toBe(head);
        const after = JSON.parse(
          await readFile(join(reposDir, computeRepoKey(canonicalUrl), 'metadata.json'), 'utf8'),
        ) as MirrorMetadata;
        expect(after.active_worktree_count).toBe(0);
      } finally {
        await fixture.cleanup();
      }
    });
  });

  describe('concurrent worktrees', () => {
    it('serializes fetch/import while allowing parallel detached worktrees', async () => {
      const fixture = await createGitFixtureRepo({
        committed: [{ path: 'base.txt', content: 'v1' }],
      });
      try {
        const { head } = await seedMirrorFromFixture(reposDir, canonicalUrl, fixture.root);
        const defaultBranch = await runGitDir(
          join(reposDir, computeRepoKey(canonicalUrl), 'mirror.git'),
          ['symbolic-ref', '--short', 'HEAD'],
        );
        const fetchRef = `refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`;
        const fetchOrder: number[] = [];
        let fetchSerial = 0;
        const concurrentManager = new RepoMirrorManager({
          reposDir,
          allowlist,
          repoCache: { ...DEFAULT_REPO_CACHE_CONFIG },
          onFetchMutexHeld: async () => {
            const ticket = ++fetchSerial;
            fetchOrder.push(ticket);
            await new Promise((resolve) => setTimeout(resolve, 30));
            fetchOrder.push(-ticket);
          },
        });

        const worktreeA = join(workspacesDir, 'attempt-a', 'project');
        const worktreeB = join(workspacesDir, 'attempt-b', 'project');

        await Promise.all([
          (async () => {
            await concurrentManager.fetchRefs(canonicalUrl, [fetchRef]);
            await concurrentManager.createWorktree(canonicalUrl, head, worktreeA);
          })(),
          (async () => {
            await concurrentManager.fetchRefs(canonicalUrl, [fetchRef]);
            await concurrentManager.createWorktree(canonicalUrl, head, worktreeB);
          })(),
        ]);

        expect(fetchOrder).toEqual([1, -1, 2, -2]);
        expect(await runGit(worktreeA, ['rev-parse', 'HEAD'])).toBe(head);
        expect(await runGit(worktreeB, ['rev-parse', 'HEAD'])).toBe(head);
        expect(worktreeA).not.toBe(worktreeB);
        const repoKey = computeRepoKey(canonicalUrl);
        expect((await concurrentManager.readMetadata(repoKey))?.active_worktree_count).toBe(2);

        await concurrentManager.removeWorktree(canonicalUrl, worktreeA);
        expect((await concurrentManager.readMetadata(repoKey))?.active_worktree_count).toBe(1);
        await concurrentManager.removeWorktree(canonicalUrl, worktreeB);
        expect((await concurrentManager.readMetadata(repoKey))?.active_worktree_count).toBe(0);
      } finally {
        await fixture.cleanup();
      }
    });
  });

  it('reclaims an exited fetch owner and protects the replacement across managers', async () => {
    const repoKey = computeRepoKey(canonicalUrl);
    const repoDir = join(reposDir, repoKey);
    await mkdir(join(repoDir, 'mirror.git'), { recursive: true });
    await manager.ensureMirror(canonicalUrl);
    const lock = join(reposDir, '.fetch-locks', repoKey);
    const exitedPid = 2_147_483_647;
    const oldOwner = join(lock, `${exitedPid}-3c72c68e-b68a-4a9a-b3bd-610c3ccb67ce`);
    await mkdir(oldOwner, { recursive: true });

    let markEntered!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const mayFinish = new Promise<void>((resolve) => {
      release = resolve;
    });
    const activeManager = new RepoMirrorManager({
      reposDir,
      allowlist,
      repoCache: { ...DEFAULT_REPO_CACHE_CONFIG },
      onFetchMutexHeld: async () => {
        markEntered();
        await mayFinish;
      },
    });
    const acquiring = activeManager.ensureMirror(canonicalUrl);
    try {
      await Promise.race([entered, acquiring]);
      await expect(manager.ensureMirror(canonicalUrl)).rejects.toThrow(/Fetch lock held/);
      await expect(
        manager.createWorktree(canonicalUrl, '0'.repeat(40), join(workspacesDir, 'blocked')),
      ).rejects.toThrow(/Fetch lock held/);
      await expect(
        runGitMutation(oldOwner, repoDir, ['init', '--bare', 'too-late.git']),
      ).rejects.toThrow(/ENOENT/);
      await expect(access(join(repoDir, 'too-late.git'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(manager.evictMirrors({ stubTotalSizeGb: 9999 })).resolves.toEqual([]);
    } finally {
      release();
      await acquiring;
    }
    await expect(manager.evictMirrors({ stubTotalSizeGb: 9999 })).resolves.toEqual([repoKey]);
  });

  it('dequeues cancelled operations while keeping the current mirror owner', async () => {
    const repoKey = computeRepoKey(canonicalUrl);
    await mkdir(join(reposDir, repoKey, 'mirror.git'), { recursive: true });
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const onFetchMutexHeld = vi.fn(() => {
      entered.resolve();
      return finish.promise;
    });
    const activeManager = new RepoMirrorManager({
      reposDir,
      allowlist,
      repoCache: DEFAULT_REPO_CACHE_CONFIG,
      onFetchMutexHeld,
    });
    const owning = activeManager.ensureMirror(canonicalUrl);
    const controller = new AbortController();
    const { signal } = controller;
    const reason = new Error('source abandoned');
    const project = join(workspacesDir, 'cancelled', 'project');

    try {
      await entered.promise;
      const rejected = Promise.all([
        expect(activeManager.ensureMirror(canonicalUrl, signal)).rejects.toBe(reason),
        expect(activeManager.fetchRefs(canonicalUrl, ['refs/heads/main'], signal)).rejects.toBe(
          reason,
        ),
        expect(
          activeManager.importBundle(
            canonicalUrl,
            join(workspacesDir, 'missing.bundle'),
            'b1',
            signal,
          ),
        ).rejects.toBe(reason),
        expect(
          activeManager.createWorktree(canonicalUrl, '0'.repeat(40), project, signal),
        ).rejects.toBe(reason),
      ]);
      controller.abort(reason);
      await rejected;
      await expect(manager.ensureMirror(canonicalUrl)).rejects.toThrow(/Fetch lock held/);
      expect(onFetchMutexHeld).toHaveBeenCalledOnce();
    } finally {
      finish.resolve();
      await owning;
    }

    await expect(activeManager.ensureMirror(canonicalUrl)).resolves.toMatchObject({ repoKey });
    expect(onFetchMutexHeld).toHaveBeenCalledTimes(2);
    await expect(access(project)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['fetch.lock', 'owner marker'])(
    'keeps a legacy %s locked when Git process ownership is unknown',
    async (format) => {
      const repoKey = computeRepoKey(canonicalUrl);
      const repoDir = join(reposDir, repoKey);
      await mkdir(join(repoDir, 'mirror.git'), { recursive: true });
      await manager.ensureMirror(canonicalUrl);

      const lockDir = join(reposDir, '.fetch-locks', repoKey);
      const exitedPid = 2_147_483_647;
      if (format === 'fetch.lock') {
        await writeFile(join(repoDir, 'fetch.lock'), `${exitedPid}\n`);
      } else {
        await mkdir(lockDir);
        await writeFile(join(lockDir, `${exitedPid}-3c72c68e-b68a-4a9a-b3bd-610c3ccb67ce`), '');
      }
      await expect(manager.ensureMirror(canonicalUrl)).rejects.toThrow(
        /Fetch lock held.*Legacy lock.*owning Agent and its Git processes/,
      );
      await expect(manager.evictMirrors({ stubTotalSizeGb: 9999 })).resolves.toEqual([]);
    },
  );

  it.each(['exited', 'live'])(
    'retains an abandoned Git mutation marker with an %s Agent',
    async (agent) => {
      const repoKey = computeRepoKey(canonicalUrl);
      const mirrorPath = join(reposDir, repoKey, 'mirror.git');
      await mkdir(mirrorPath, { recursive: true });
      await manager.ensureMirror(canonicalUrl);

      const exitedPid = 2_147_483_647;
      const agentPid = agent === 'exited' ? exitedPid : process.pid;
      const marker = join(
        reposDir,
        '.fetch-locks',
        repoKey,
        `${agentPid}-3c72c68e-b68a-4a9a-b3bd-610c3ccb67ce`,
        `${exitedPid}-a297710c-4879-45f9-8db6-9ca5f375d632`,
      );
      await mkdir(marker, { recursive: true });

      await expect(manager.ensureMirror(canonicalUrl)).rejects.toThrow(
        /Fetch lock held.*Abandoned Git mutation marker.*owning Agent and its Git processes/,
      );
      const inspect = vi.fn(async () => true);
      const finish = vi.fn(async () => {});
      await expect(
        manager.tryCleanupWorktree(canonicalUrl, join(workspacesDir, 'retained'), inspect, finish),
      ).rejects.toThrow(/Abandoned Git mutation marker/);
      expect(inspect).not.toHaveBeenCalled();
      expect(finish).not.toHaveBeenCalled();
      await expect(manager.evictMirrors({ stubTotalSizeGb: 9999 })).resolves.toEqual([]);
      await expect(access(marker)).resolves.toBeUndefined();
    },
  );

  it('protects a running Git command after its Agent exits and reclaims the lock after Git closes', async () => {
    const repoKey = computeRepoKey(canonicalUrl);
    const mirrorPath = join(reposDir, repoKey, 'mirror.git');
    const lock = join(reposDir, '.fetch-locks', repoKey);
    await mkdir(mirrorPath, { recursive: true });
    await manager.ensureMirror(canonicalUrl);

    const started = join(workspacesDir, 'git-started');
    const finish = join(workspacesDir, 'git-may-finish');
    const finished = join(workspacesDir, 'git-finished');
    const command = join(workspacesDir, 'hold-git.cjs');
    await writeFile(
      command,
      `
      const { existsSync, writeFileSync } = require('node:fs');
      writeFileSync(${JSON.stringify(started)}, '');
      const stopAt = Date.now() + 20_000;
      const timer = setInterval(() => {
        if (!existsSync(${JSON.stringify(finish)}) && Date.now() < stopAt) return;
        clearInterval(timer);
        process.stderr.write('Git finished after the Agent pipe closed\\n', () => {
          writeFileSync(${JSON.stringify(finished)}, '');
        });
      }, 20);
    `,
    );
    const shellQuote = (path: string) =>
      `'${toGitOsPath(path).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
    const alias = `alias.rbo-lock-test=!${shellQuote(process.execPath)} ${shellQuote(command)}`;
    const launcherUrl = new URL('../src/repos/mirror-git.ts', import.meta.url).href;
    const agent = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
          import { mkdir } from 'node:fs/promises';
          import { join } from 'node:path';
          import { runGitMutation } from ${JSON.stringify(launcherUrl)};
          const [lock, mirror, alias] = process.argv.slice(1);
          const owner = join(lock, process.pid + '-3c72c68e-b68a-4a9a-b3bd-610c3ccb67ce');
          await mkdir(owner, { recursive: true });
          await runGitMutation(owner, mirror, ['-c', alias, 'rbo-lock-test']);
        `,
        '--',
        lock,
        mirrorPath,
        alias,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
    );
    let diagnostics = '';
    agent.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      diagnostics += chunk;
    });
    const closed = once(agent, 'close').catch((error: unknown) => [error]);
    try {
      await Promise.race([
        vi.waitFor(() => access(started), { timeout: 5_000 }),
        closed.then(([code]) => {
          throw new Error(`Agent exited before Git started (${code}): ${diagnostics}`);
        }),
      ]);
      expect(agent.kill('SIGKILL')).toBe(true);
      expect(await closed).toEqual([null, 'SIGKILL']);
      expect(() => process.kill(agent.pid as number, 0)).toThrow(
        expect.objectContaining({ code: 'ESRCH' }),
      );

      await expect(manager.ensureMirror(canonicalUrl)).rejects.toThrow(/Fetch lock held/);
      await expect(manager.evictMirrors({ stubTotalSizeGb: 9999 })).resolves.toEqual([]);
      await expect(access(mirrorPath)).resolves.toBeUndefined();

      await writeFile(finish, '');
      await vi.waitFor(() => manager.ensureMirror(canonicalUrl), { timeout: 5_000 });
      await expect(access(finished)).resolves.toBeUndefined();
      await expect(manager.evictMirrors({ stubTotalSizeGb: 9999 })).resolves.toEqual([repoKey]);
    } finally {
      await writeFile(finish, '');
      if (agent.exitCode === null && agent.signalCode === null) {
        agent.kill('SIGKILL');
      }
      await closed;
    }
  });

  describe('bundle import', () => {
    it('imports bundle objects under refs/rbo/bundles namespace', async () => {
      const fixture = await createGitFixtureRepo({
        committed: [{ path: 'bundle.txt', content: 'bundle-me' }],
      });
      const orphan = await createGitFixtureRepo({
        committed: [{ path: 'orphan.txt', content: 'local-only' }],
      });
      try {
        const { repoKey } = await seedMirrorFromFixture(reposDir, canonicalUrl, fixture.root);
        const orphanHead = await runGit(orphan.root, ['rev-parse', 'HEAD']);
        const bundlePath = join(workspacesDir, 'local.bundle');
        await runGit(orphan.root, ['bundle', 'create', toGitOsPath(bundlePath), 'HEAD']);

        await manager.importBundle(canonicalUrl, bundlePath, 'bundle-1');
        await expect(manager.hasCommit(repoKey, orphanHead)).resolves.toBe(true);
        const mirrorPath = join(reposDir, repoKey, 'mirror.git');
        const refs = await runGitDir(mirrorPath, [
          'for-each-ref',
          '--format=%(refname)',
          'refs/rbo/bundles/bundle-1',
        ]);
        expect(refs.split('\n').some((line) => line.startsWith('refs/rbo/bundles/bundle-1/'))).toBe(
          true,
        );
        const importedHead = await runGitDir(mirrorPath, [
          'rev-parse',
          refs.split('\n').find((line) => line.startsWith('refs/rbo/bundles/bundle-1/')) ?? '',
        ]);
        expect(importedHead).toBe(orphanHead);
      } finally {
        await fixture.cleanup();
        await orphan.cleanup();
      }
    });
  });

  describe('eviction', () => {
    it('skips mirrors with active worktrees even when over size limit', async () => {
      const fixture = await createGitFixtureRepo({
        committed: [{ path: 'evict.txt', content: 'keep' }],
      });
      try {
        const { repoKey, head } = await seedMirrorFromFixture(reposDir, canonicalUrl, fixture.root);
        const worktreePath = join(workspacesDir, 'active', 'project');
        await manager.createWorktree(canonicalUrl, head, worktreePath);

        const evicted = await manager.evictMirrors({ stubTotalSizeGb: 9999 });
        expect(evicted).not.toContain(repoKey);
        await expect(
          runGitDir(join(reposDir, repoKey, 'mirror.git'), ['rev-parse', 'HEAD']),
        ).resolves.toBe(head);

        await manager.removeWorktree(canonicalUrl, worktreePath);
        const evictedAfter = await manager.evictMirrors({ stubTotalSizeGb: 9999 });
        expect(evictedAfter).toContain(repoKey);
      } finally {
        await fixture.cleanup();
      }
    });
  });
});
