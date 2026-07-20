import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type GitUrlAllowlist, computeRepoKey } from '@rbo/shared';
import { applyGitOverlay, captureGitOverlaySnapshot } from '@rbo/snapshot';
import { createGitFixtureRepo } from '@rbo/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_REPO_CACHE_CONFIG, RepoMirrorManager } from '../src/repos/mirror.js';

const execFileAsync = promisify(execFile);

const allowlist: GitUrlAllowlist = {
  schemes: ['https'],
  hosts: ['github.com'],
  repository_prefixes: ['testuser/'],
};

const canonicalUrl = 'https://github.com/testuser/overlay-repo.git';

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    encoding: 'utf8',
  });
  return stdout.trim();
}

describe('git_overlay prepare path (mirror + worktree + overlay)', () => {
  let stateDir: string;
  let fixture: Awaited<ReturnType<typeof createGitFixtureRepo>>;

  afterEach(async () => {
    if (fixture) {
      await fixture.cleanup();
    }
    if (stateDir) {
      await rm(stateDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('seeds mirror from fixture, creates worktree, and applies overlay archive', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'rbo-agent-overlay-'));
    const reposDir = join(stateDir, 'repos');
    const attemptDir = join(stateDir, 'workspaces', 'att_overlay');
    const projectPath = join(attemptDir, 'project');

    fixture = await createGitFixtureRepo({
      committed: [
        { path: 'src/a.txt', content: 'A' },
        { path: 'src/b.txt', content: 'B' },
      ],
      unstaged: [{ path: 'src/a.txt', content: 'A-dirty' }],
      untracked: [{ path: 'src/new.txt', content: 'new' }],
    });
    await runGit(fixture.root, ['remote', 'add', 'origin', canonicalUrl]);

    const storage = join(stateDir, 'capture');
    const captured = await captureGitOverlaySnapshot({
      projectRoot: fixture.root,
      allowedProjectRoots: [fixture.root],
      sourcePolicy: {
        include_untracked: true,
        include_ignored: [],
        secret_policy: 'allow',
      },
      contentStorageDir: storage,
      repoUrl: canonicalUrl,
    });

    const repoKey = computeRepoKey(canonicalUrl);
    const repoDir = join(reposDir, repoKey);
    await mkdir(repoDir, { recursive: true });
    await runGit(repoDir, ['clone', '--mirror', fixture.root, 'mirror.git']);
    const head = await runGit(join(repoDir, 'mirror.git'), ['rev-parse', 'HEAD']);

    const manager = new RepoMirrorManager({
      reposDir,
      allowlist,
      repoCache: DEFAULT_REPO_CACHE_CONFIG,
    });

    expect(await manager.hasCommit(repoKey, head)).toBe(true);
    await manager.createWorktree(canonicalUrl, head, projectPath);
    await applyGitOverlay({
      manifest: captured.manifest,
      archivePath: captured.archivePath,
      workspaceRoot: attemptDir,
      projectPath,
    });

    expect(await readFile(join(projectPath, 'src/a.txt'), 'utf8')).toBe('A-dirty');
    expect(await readFile(join(projectPath, 'src/new.txt'), 'utf8')).toBe('new');
    expect(await readFile(join(projectPath, 'src/b.txt'), 'utf8')).toBe('B');

    await manager.removeWorktree(canonicalUrl, projectPath);
  });

  it('imports a bundle when base commit is missing from mirror', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'rbo-agent-overlay-bundle-'));
    const reposDir = join(stateDir, 'repos');
    const attemptDir = join(stateDir, 'workspaces', 'att_bundle');
    const projectPath = join(attemptDir, 'project');
    const bundlePath = join(attemptDir, 'bundle.gitbundle');
    await mkdir(attemptDir, { recursive: true });

    fixture = await createGitFixtureRepo({
      committed: [{ path: 'only.txt', content: 'only' }],
    });
    await runGit(fixture.root, ['remote', 'add', 'origin', canonicalUrl]);
    const head = await runGit(fixture.root, ['rev-parse', 'HEAD']);
    await runGit(fixture.root, ['bundle', 'create', bundlePath, 'HEAD']);

    const repoKey = computeRepoKey(canonicalUrl);
    const repoDir = join(reposDir, repoKey);
    await mkdir(repoDir, { recursive: true });
    await runGit(repoDir, ['init', '--bare', 'mirror.git']);

    const manager = new RepoMirrorManager({
      reposDir,
      allowlist,
      repoCache: DEFAULT_REPO_CACHE_CONFIG,
    });

    expect(await manager.hasCommit(repoKey, head)).toBe(false);
    await manager.importBundle(canonicalUrl, bundlePath, 'bundle-test-1');
    expect(await manager.hasCommit(repoKey, head)).toBe(true);
    await manager.createWorktree(canonicalUrl, head, projectPath);
    expect(await readFile(join(projectPath, 'only.txt'), 'utf8')).toBe('only');
    await manager.removeWorktree(canonicalUrl, projectPath);
  });
});
