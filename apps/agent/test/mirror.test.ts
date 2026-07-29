import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { type GitUrlAllowlist, computeRepoKey } from '@rbo/shared';
import { createGitFixtureRepo } from '@rbo/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

        await concurrentManager.removeWorktree(canonicalUrl, worktreeA);
        await concurrentManager.removeWorktree(canonicalUrl, worktreeB);
      } finally {
        await fixture.cleanup();
      }
    });
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
