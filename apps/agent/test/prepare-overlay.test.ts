import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type GitUrlAllowlist, computeRepoKey, normalizeRepositoryUrl } from '@rbo/shared';
import { applyGitOverlay, captureGitOverlaySnapshot } from '@rbo/snapshot';
import { createGitFixtureRepo } from '@rbo/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentJobExecutor } from '../src/executor/index.js';
import { DEFAULT_REPO_CACHE_CONFIG, RepoMirrorManager } from '../src/repos/mirror.js';

const execFileAsync = promisify(execFile);

const allowlist: GitUrlAllowlist = {
  schemes: ['https'],
  hosts: ['github.com'],
  repository_prefixes: ['testuser/'],
};

const canonicalUrl = 'https://github.com/testuser/overlay-repo.git';

/** Probe once: hosts without symlink privilege must skip symlink scenarios explicitly. */
const canCreateSymlinks: boolean = await (async () => {
  const probeDir = await mkdtemp(join(tmpdir(), 'rbo-symlink-probe-'));
  try {
    await writeFile(join(probeDir, 'target.txt'), 'target');
    await symlink('target.txt', join(probeDir, 'link.txt'));
    return true;
  } catch {
    return false;
  } finally {
    await rm(probeDir, { recursive: true, force: true }).catch(() => undefined);
  }
})();

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    encoding: 'utf8',
  });
  return stdout.trim();
}

function mockSocket(): import('ws').WebSocket & { sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];
  return {
    readyState: 1,
    OPEN: 1,
    sent,
    send(raw: string) {
      sent.push(JSON.parse(raw) as Record<string, unknown>);
    },
  } as unknown as import('ws').WebSocket & { sent: Array<Record<string, unknown>> };
}

function sha256File(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function patchLocalDownloads(
  executor: AgentJobExecutor,
  files: { overlay: string; bundle?: string },
): void {
  const inner = executor as unknown as {
    downloadSnapshotFile: (
      url: string,
      token: string,
      dest: string,
      expectedSize: number,
      expectedSha256: string,
    ) => Promise<void>;
  };
  inner.downloadSnapshotFile = async (_url, _token, dest, expectedSize, expectedSha256) => {
    const source =
      _url.includes('/overlay') || _url.includes('overlay') ? files.overlay : files.bundle;
    if (!source) {
      throw new Error(`unexpected download url: ${_url}`);
    }
    await copyFile(source, dest);
    const data = await readFile(dest);
    if (data.length !== expectedSize) {
      throw new Error(`download size mismatch: got ${data.length}, expected ${expectedSize}`);
    }
    const sha = sha256File(data);
    if (sha !== expectedSha256) {
      throw new Error(`download sha256 mismatch: got ${sha}, expected ${expectedSha256}`);
    }
  };
}

function baseLeaseOffer(attemptId: string, leaseId: string) {
  return {
    attempt_id: attemptId,
    lease_id: leaseId,
    lease_epoch: 1,
    job_id: `job_${attemptId}`,
    job_request: {
      client_request_id: `req_${attemptId}`,
      source: { project_root: 'C:/proj', cwd: '.' },
      execution: { script: 'true' },
    },
    snapshot_metadata: {
      snapshot_id: 'snp_1',
      content_id: 'cid',
      size_bytes: 1,
      sha256: 'ab',
    },
    lease_ttl_seconds: 300,
  };
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

  it('AgentJobExecutor orchestrates mirror worktree + overlay when base commit is present', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'rbo-agent-exec-overlay-'));
    const repoCacheRoot = join(stateDir, 'repo-cache');
    const reposDir = join(repoCacheRoot, 'repos');
    const attemptId = 'att_exec_overlay';
    const leaseId = 'lease_exec_overlay';

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
    const head = await runGit(fixture.root, ['rev-parse', 'HEAD']);

    const repoKey = computeRepoKey(canonicalUrl);
    const repoDir = join(reposDir, repoKey);
    await mkdir(repoDir, { recursive: true });
    await runGit(repoDir, ['clone', '--mirror', fixture.root, 'mirror.git']);

    const socket = mockSocket();
    const executor = new AgentJobExecutor(socket, {
      stateDir,
      repoCacheDir: repoCacheRoot,
      controllerFingerprint: 'sha256:deadbeef',
      gitAllowlist: allowlist,
      repoCache: DEFAULT_REPO_CACHE_CONFIG,
    });
    patchLocalDownloads(executor, { overlay: captured.archivePath });

    executor.handleLeaseOffer(baseLeaseOffer(attemptId, leaseId));

    const overlayBytes = await readFile(captured.archivePath);
    await executor.handlePrepareSource({
      source_mode: 'git_overlay',
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      repo: {
        url: canonicalUrl,
        canonical_id: normalizeRepositoryUrl(canonicalUrl),
        branch: 'main',
        base_commit: head,
        fetch_refs: [],
      },
      overlay: {
        download_url: 'https://controller.test/data/v1/attempts/att/overlay',
        data_token: 'overlay-token',
        expected_size_bytes: overlayBytes.length,
        expected_sha256: sha256File(overlayBytes),
      },
      manifest: captured.manifest,
    });

    expect(socket.sent.some((frame) => frame.type === 'source_ready')).toBe(true);
    expect(socket.sent.some((frame) => frame.type === 'source_need')).toBe(false);

    const projectPath = join(stateDir, 'workspaces', attemptId, 'project');
    expect(await readFile(join(projectPath, 'src/a.txt'), 'utf8')).toBe('A-dirty');
    expect(await readFile(join(projectPath, 'src/new.txt'), 'utf8')).toBe('new');
    expect(await readFile(join(projectPath, 'src/b.txt'), 'utf8')).toBe('B');
  });

  it('AgentJobExecutor imports bundle then applies overlay when base commit is missing', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'rbo-agent-exec-bundle-'));
    const repoCacheRoot = join(stateDir, 'repo-cache');
    const reposDir = join(repoCacheRoot, 'repos');
    const attemptId = 'att_exec_bundle';
    const leaseId = 'lease_exec_bundle';

    fixture = await createGitFixtureRepo({
      committed: [{ path: 'bundle.txt', content: 'from-bundle' }],
      unstaged: [{ path: 'bundle.txt', content: 'from-overlay' }],
    });
    await runGit(fixture.root, ['remote', 'add', 'origin', canonicalUrl]);
    const head = await runGit(fixture.root, ['rev-parse', 'HEAD']);

    const bundlePath = join(stateDir, 'bundle.gitbundle');
    await runGit(fixture.root, ['bundle', 'create', bundlePath, 'HEAD']);
    const bundleBytes = await readFile(bundlePath);

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
    const overlayBytes = await readFile(captured.archivePath);

    const repoKey = computeRepoKey(canonicalUrl);
    const repoDir = join(reposDir, repoKey);
    await mkdir(repoDir, { recursive: true });
    await runGit(repoDir, ['init', '--bare', 'mirror.git']);

    const socket = mockSocket();
    const executor = new AgentJobExecutor(socket, {
      stateDir,
      repoCacheDir: repoCacheRoot,
      controllerFingerprint: 'sha256:deadbeef',
      gitAllowlist: allowlist,
      repoCache: DEFAULT_REPO_CACHE_CONFIG,
    });
    patchLocalDownloads(executor, {
      overlay: captured.archivePath,
      bundle: bundlePath,
    });

    executor.handleLeaseOffer(baseLeaseOffer(attemptId, leaseId));

    const preparePromise = executor.handlePrepareSource({
      source_mode: 'git_overlay',
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      repo: {
        url: canonicalUrl,
        canonical_id: normalizeRepositoryUrl(canonicalUrl),
        branch: 'main',
        base_commit: head,
        fetch_refs: [],
      },
      overlay: {
        download_url: 'https://controller.test/data/v1/attempts/att/overlay',
        data_token: 'overlay-token',
        expected_size_bytes: overlayBytes.length,
        expected_sha256: sha256File(overlayBytes),
      },
      manifest: captured.manifest,
    });

    await viWaitFor(() =>
      socket.sent.some(
        (frame) => frame.type === 'source_need' && frame.payload?.reason === 'base_commit_missing',
      ),
    );

    executor.handleBundleDownload({
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: 1,
      download_url: 'https://controller.test/data/v1/attempts/att/bundle',
      data_token: 'bundle-token',
      expected_size_bytes: bundleBytes.length,
      expected_sha256: sha256File(bundleBytes),
    });

    await preparePromise;

    expect(socket.sent.some((frame) => frame.type === 'source_ready')).toBe(true);
    const projectPath = join(stateDir, 'workspaces', attemptId, 'project');
    expect(await readFile(join(projectPath, 'bundle.txt'), 'utf8')).toBe('from-overlay');
  });
});

describe('git_overlay overlay fixtures (executable / symlink / empty-dir)', () => {
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

  // PLATFORM-GAP: Windows does not preserve Unix executable bits on materialized files
  it.skipIf(process.platform === 'win32')(
    'preserves executable bit through overlay capture and apply',
    async () => {
      stateDir = await mkdtemp(join(tmpdir(), 'rbo-overlay-exec-'));
      fixture = await createGitFixtureRepo({
        committed: [{ path: 'run.sh', content: '#!/bin/sh\necho base\n', mode: '100755' }],
        unstaged: [{ path: 'run.sh', content: '#!/bin/sh\necho dirty\n' }],
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

      const runEntry = captured.manifest.overlay.files.find((file) => file.path === 'run.sh');
      expect(runEntry?.mode).toBe('100755');

      const attemptDir = join(stateDir, 'workspaces', 'att_exec');
      const projectPath = join(attemptDir, 'project');
      await mkdir(projectPath, { recursive: true });
      await writeFile(join(projectPath, 'run.sh'), '#!/bin/sh\necho base\n');

      await applyGitOverlay({
        manifest: captured.manifest,
        archivePath: captured.archivePath,
        workspaceRoot: attemptDir,
        projectPath,
      });

      expect(await readFile(join(projectPath, 'run.sh'), 'utf8')).toBe('#!/bin/sh\necho dirty\n');
      const mode = (await stat(join(projectPath, 'run.sh'))).mode & 0o777;
      expect(mode & 0o111).not.toBe(0);
    },
  );

  // PLATFORM-GAP: OS denied symlink creation or overlay symlink materialization on this host
  it.skipIf(!canCreateSymlinks || process.platform === 'win32')(
    'preserves relative symlink through overlay capture and apply',
    async () => {
      stateDir = await mkdtemp(join(tmpdir(), 'rbo-overlay-symlink-'));
      fixture = await createGitFixtureRepo({
        committed: [{ path: 'target.txt', content: 'target-bytes' }],
      });
      await runGit(fixture.root, ['remote', 'add', 'origin', canonicalUrl]);
      await symlink('target.txt', join(fixture.root, 'link.txt'));
      await runGit(fixture.root, ['add', 'link.txt']);

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

      const attemptDir = join(stateDir, 'workspaces', 'att_symlink');
      const projectPath = join(attemptDir, 'project');
      await mkdir(projectPath, { recursive: true });
      await writeFile(join(projectPath, 'target.txt'), 'target-bytes');

      await applyGitOverlay({
        manifest: captured.manifest,
        archivePath: captured.archivePath,
        workspaceRoot: attemptDir,
        projectPath,
      });

      const linkStat = await stat(join(projectPath, 'link.txt'));
      expect(linkStat.isSymbolicLink()).toBe(true);
      expect(await readFile(join(projectPath, 'link.txt'), 'utf8')).toBe('target-bytes');
    },
  );

  // PLATFORM-GAP: git on Windows often omits empty untracked directories from porcelain v2
  it.skipIf(process.platform === 'win32')(
    'preserves empty untracked directories through overlay capture and apply',
    async () => {
      stateDir = await mkdtemp(join(tmpdir(), 'rbo-overlay-empty-dir-'));
      fixture = await createGitFixtureRepo({
        committed: [{ path: 'base.txt', content: 'base' }],
      });
      await runGit(fixture.root, ['remote', 'add', 'origin', canonicalUrl]);
      await mkdir(join(fixture.root, 'empty-dir'), { recursive: true });

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

      expect(captured.manifest.overlay.empty_directories).toContain('empty-dir');

      const attemptDir = join(stateDir, 'workspaces', 'att_empty');
      const projectPath = join(attemptDir, 'project');
      await mkdir(projectPath, { recursive: true });
      await writeFile(join(projectPath, 'base.txt'), 'base');

      await applyGitOverlay({
        manifest: captured.manifest,
        archivePath: captured.archivePath,
        workspaceRoot: attemptDir,
        projectPath,
      });

      const emptyDirStat = await stat(join(projectPath, 'empty-dir'));
      expect(emptyDirStat.isDirectory()).toBe(true);
    },
  );
});

async function viWaitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for condition');
}
