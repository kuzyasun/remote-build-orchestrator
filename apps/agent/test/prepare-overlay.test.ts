import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { addAbortListener } from 'node:events';
import {
  access,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { PrepareSourceGitOverlayPayload } from '@rbo/protocol';
import { type GitUrlAllowlist, computeRepoKey, normalizeRepositoryUrl } from '@rbo/shared';
import { applyGitOverlay, captureGitOverlaySnapshot } from '@rbo/snapshot';
import { createGitFixtureRepo } from '@rbo/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentJobExecutor } from '../src/executor/index.js';
import { hasPendingWorktreeCleanup } from '../src/recovery/worktree-cleanup.js';
import * as mirrorGit from '../src/repos/mirror-git.js';
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

async function prepareLocalOverlay(stateDir: string) {
  const reposDir = join(stateDir, 'repos');
  const repoPath = join(reposDir, computeRepoKey(canonicalUrl));
  const fixture = await createGitFixtureRepo({
    committed: [{ path: 'base.txt', content: 'base' }],
  });
  try {
    await runGit(fixture.root, ['remote', 'add', 'origin', canonicalUrl]);
    const captured = await captureGitOverlaySnapshot({
      projectRoot: fixture.root,
      allowedProjectRoots: [fixture.root],
      sourcePolicy: { include_untracked: true, include_ignored: [], secret_policy: 'allow' },
      contentStorageDir: join(stateDir, 'capture'),
      repoUrl: canonicalUrl,
    });
    await mkdir(repoPath, { recursive: true });
    await runGit(repoPath, ['clone', '--mirror', fixture.root, 'mirror.git']);
    return { fixture, reposDir, manifest: captured.manifest };
  } catch (error) {
    await fixture.cleanup();
    throw error;
  }
}

function localOverlayPrepare(
  offer: ReturnType<typeof baseLeaseOffer>,
  manifest: PrepareSourceGitOverlayPayload['manifest'],
  fetchRefs: string[],
): PrepareSourceGitOverlayPayload {
  return {
    source_mode: 'git_overlay',
    attempt_id: offer.attempt_id,
    lease_id: offer.lease_id,
    lease_epoch: offer.lease_epoch,
    repo: {
      url: canonicalUrl,
      canonical_id: normalizeRepositoryUrl(canonicalUrl),
      branch: 'main',
      base_commit: manifest.repo.base_commit,
      fetch_refs: fetchRefs,
    },
    overlay: {
      download_url: 'https://controller.test/overlay',
      data_token: 'overlay-token',
      expected_size_bytes: 1,
      expected_sha256: '0'.repeat(64),
    },
    manifest,
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

  it.each([true, false])(
    'handles overlay preparation when bundle contains the base: %s',
    async (baseInBundle) => {
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
          base_commit: baseInBundle ? head : '0'.repeat(40),
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
          (frame) =>
            frame.type === 'source_need' && frame.payload?.reason === 'base_commit_missing',
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

      if (!baseInBundle) {
        expect(socket.sent).toContainEqual(
          expect.objectContaining({
            type: 'job_exit',
            payload: expect.objectContaining({
              outcome: 'failed',
              failure_category: 'repo_fetch',
              failure_message: expect.stringContaining('snapshot_mode=full'),
            }),
          }),
        );
        expect(socket.sent.some((frame) => frame.type === 'source_ready')).toBe(false);
        expect(executor.getActiveJobs()).toEqual([]);
        return;
      }

      expect(socket.sent.some((frame) => frame.type === 'source_ready')).toBe(true);
      const projectPath = join(stateDir, 'workspaces', attemptId, 'project');
      expect(await readFile(join(projectPath, 'bundle.txt'), 'utf8')).toBe('from-overlay');
    },
  );
});

describe('git_overlay cancel while the mirror is busy', () => {
  let stateDir: string;
  let fixture: Awaited<ReturnType<typeof createGitFixtureRepo>> | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await fixture?.cleanup();
    if (stateDir) {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  function stallMirrorFetch() {
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const run = mirrorGit.runGitMutation;
    const git = vi
      .spyOn(mirrorGit, 'runGitMutation')
      .mockImplementation(async (owner, cwd, args) => {
        if (args[0] === 'clone') {
          throw new Error('expected a seeded local mirror');
        }
        if (args[0] === 'fetch') {
          entered.resolve();
          await finish.promise;
          return;
        }
        await run(owner, cwd, args);
      });
    return { entered, finish, git };
  }

  it.each(['cancel', 'disconnect', 'lease expiry'] as const)(
    'releases the source slot on %s before the mirror fetch settles',
    async (action) => {
      stateDir = await mkdtemp(join(tmpdir(), 'rbo-overlay-stalled-fetch-'));
      const local = await prepareLocalOverlay(stateDir);
      fixture = local.fixture;
      const socket = mockSocket();
      const executor = new AgentJobExecutor(socket, {
        stateDir,
        repoCacheDir: stateDir,
        controllerFingerprint: 'sha256:deadbeef',
        gitAllowlist: allowlist,
        repoCache: DEFAULT_REPO_CACHE_CONFIG,
      });
      const contender = new RepoMirrorManager({
        reposDir: local.reposDir,
        allowlist,
        repoCache: DEFAULT_REPO_CACHE_CONFIG,
      });
      const baseOffer = baseLeaseOffer('att_fetch', 'lease_fetch');
      const offer = {
        ...baseOffer,
        job_request: { ...baseOffer.job_request, risk_level: 'hardware' as const },
        lease_ttl_seconds: 5,
      };
      const prepare = localOverlayPrepare(offer, local.manifest, [
        'refs/heads/main',
        'refs/heads/next',
      ]);
      const { entered, finish, git } = stallMirrorFetch();

      if (action === 'lease expiry') {
        vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
      }
      executor.handleLeaseOffer(offer);
      const preparing = executor.handlePrepareSource(prepare);
      let stopped: Promise<void> | undefined;
      try {
        await Promise.race([
          entered.promise,
          preparing.then(() => {
            throw new Error('expected a mirror fetch');
          }),
        ]);
        if (action === 'cancel') {
          stopped = executor.handleCancelJob({ ...prepare, grace_seconds: 1 });
        } else if (action === 'disconnect') {
          stopped = executor.abandonOnDisconnect();
        } else {
          await vi.advanceTimersByTimeAsync(5_000);
          vi.useRealTimers();
        }

        await vi.waitFor(() => expect(executor.isBusy()).toBe(false));
        await stopped;
        await preparing;
        await expect(access(join(stateDir, 'workspaces', offer.attempt_id))).rejects.toMatchObject({
          code: 'ENOENT',
        });
        expect(socket.sent.some((frame) => frame.type === 'source_ready')).toBe(false);
        expect(socket.sent.some((frame) => frame.type === 'source_need')).toBe(false);
        const exit = socket.sent.find((frame) => frame.type === 'job_exit');
        if (action === 'disconnect') {
          expect(exit).toBeUndefined();
        } else {
          expect(exit?.payload).toMatchObject({
            failure_category: action === 'cancel' ? 'cancelled' : 'lease_expired',
          });
        }

        executor.handleLeaseOffer(baseLeaseOffer('att_next', 'lease_next'));
        expect(executor.getActiveAttemptId()).toBe('att_next');
        await expect(contender.ensureMirror(canonicalUrl)).rejects.toThrow(/Fetch lock held/);
      } finally {
        vi.useRealTimers();
        finish.resolve();
        await preparing;
        await stopped;
        await executor.forceAbandon();
        await vi.waitFor(() => contender.ensureMirror(canonicalUrl));
      }
      expect(git).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['same manager', 'another manager'] as const)(
    'waits for a mirror owner in %s before removing a cancelled attempt worktree',
    async (owner) => {
      stateDir = await mkdtemp(join(tmpdir(), 'rbo-overlay-deferred-cleanup-'));
      const local = await prepareLocalOverlay(stateDir);
      fixture = local.fixture;
      const socket = mockSocket();
      const config = {
        stateDir,
        repoCacheDir: stateDir,
        controllerFingerprint: 'sha256:deadbeef',
        gitAllowlist: allowlist,
        repoCache: DEFAULT_REPO_CACHE_CONFIG,
        maxJobs: 2,
      };
      const executor = new AgentJobExecutor(socket, config);
      let cleanupExecutor = executor;
      const offer = baseLeaseOffer('att_checkout', 'lease_checkout');
      const checkout = localOverlayPrepare(offer, local.manifest, []);
      const fetchOffer = baseLeaseOffer('att_fetch', 'lease_fetch');
      const fetch = localOverlayPrepare(fetchOffer, local.manifest, ['refs/heads/main']);
      const otherManager = new RepoMirrorManager({
        reposDir: local.reposDir,
        allowlist,
        repoCache: DEFAULT_REPO_CACHE_CONFIG,
      });
      const repoKey = computeRepoKey(canonicalUrl);
      const workspace = join(stateDir, 'workspaces', checkout.attempt_id);
      const downloading = Promise.withResolvers<void>();
      const downloads = executor as unknown as {
        downloadSnapshotFile: (
          ...args: [string, string, string, number, string, AbortSignal]
        ) => Promise<void>;
      };
      vi.spyOn(downloads, 'downloadSnapshotFile').mockImplementationOnce(
        async (_url, _token, _path, _size, _sha, signal) => {
          const cancelled = Promise.withResolvers<never>();
          const listener = addAbortListener(signal, () => cancelled.reject(signal.reason));
          downloading.resolve();
          try {
            return await cancelled.promise;
          } finally {
            listener[Symbol.dispose]();
          }
        },
      );
      const { entered, finish, git } = stallMirrorFetch();

      executor.handleLeaseOffer(offer);
      const checkingOut = executor.handlePrepareSource(checkout);
      let fetching: Promise<void> | undefined;
      let cancelling: Promise<void> | undefined;
      try {
        await Promise.race([
          downloading.promise,
          checkingOut.then(() => {
            throw new Error('expected an overlay download');
          }),
        ]);
        if (owner === 'same manager') {
          executor.handleLeaseOffer(fetchOffer);
          fetching = executor.handlePrepareSource(fetch);
        } else {
          fetching = otherManager.fetchRefs(canonicalUrl, fetch.repo.fetch_refs);
        }
        await Promise.race([
          entered.promise,
          fetching.then(() => {
            throw new Error('expected a mirror fetch');
          }),
        ]);

        cancelling = executor.handleCancelJob({ ...checkout, grace_seconds: 1 });
        const remaining = owner === 'same manager' ? fetch.attempt_id : null;
        await vi.waitFor(() => expect(executor.getActiveAttemptId()).toBe(remaining));
        await cancelling;
        await checkingOut;
        await expect(access(join(workspace, 'project'))).resolves.toBeUndefined();
        expect(hasPendingWorktreeCleanup(stateDir, checkout.attempt_id)).toBe(true);
        const heldMetadata = await otherManager.readMetadata(repoKey);
        expect(heldMetadata?.active_worktree_count).toBe(1);
        expect(git.mock.calls.map(([, , args]) => args.slice(0, 2))).toEqual([
          ['worktree', 'add'],
          ['fetch', '--no-tags'],
        ]);

        executor.handleLeaseOffer(offer);
        expect(socket.sent.at(-1)).toMatchObject({ type: 'lease_reject' });
        if (owner === 'another manager') {
          // A restarted Executor must fence the workspace before its first scan.
          const restartedSocket = mockSocket();
          cleanupExecutor = new AgentJobExecutor(restartedSocket, config);
          cleanupExecutor.handleLeaseOffer(offer);
          expect(restartedSocket.sent.at(-1)).toMatchObject({ type: 'lease_reject' });
        }
        await cleanupExecutor.retryPendingWorktreeCleanup();
        await expect(access(join(workspace, 'project'))).resolves.toBeUndefined();
        if (owner === 'same manager') {
          await executor.handleCancelJob({ ...fetch, grace_seconds: 1 });
          await fetching;
        }
        expect(executor.isBusy()).toBe(false);
      } finally {
        finish.resolve();
        await executor.forceAbandon();
        await Promise.all([checkingOut, fetching, cancelling]);
        await vi.waitFor(
          async () => {
            await cleanupExecutor.retryPendingWorktreeCleanup();
            await expect(access(workspace)).rejects.toMatchObject({ code: 'ENOENT' });
          },
          { timeout: 10_000 },
        );
      }
      const cleanedMetadata = await otherManager.readMetadata(repoKey);
      expect(cleanedMetadata?.active_worktree_count).toBe(0);
      expect(hasPendingWorktreeCleanup(stateDir, checkout.attempt_id)).toBe(false);
      expect(git.mock.calls.map(([, , args]) => args.slice(0, 2))).toEqual([
        ['worktree', 'add'],
        ['fetch', '--no-tags'],
        ['worktree', 'remove'],
        ['worktree', 'prune'],
      ]);
    },
  );
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

      const linkStat = await lstat(join(projectPath, 'link.txt'));
      expect(linkStat.isSymbolicLink()).toBe(true);
      expect(await readFile(join(projectPath, 'link.txt'), 'utf8')).toBe('target-bytes');
    },
  );

  // PLATFORM-GAP: git omits empty untracked directories from porcelain v2
  it.skip('preserves empty untracked directories through overlay capture and apply', async () => {
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
  });
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
