import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { addAbortListener } from 'node:events';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { type GitUrlAllowlist, assertAllowedRepositoryUrl, computeRepoKey } from '@rbo/shared';
import { runGitMutation } from './mirror-git.js';

const execFileAsync = promisify(execFile);

/** Git for Windows rejects extended-length `\\?\` paths passed as CLI arguments. */
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

function worktreePathKey(path: string): string {
  return resolve(toGitOsPath(path));
}

function worktreeLastSegments(path: string): string {
  const tail = join(basename(dirname(path)), basename(path));
  return process.platform === 'win32' ? tail.toLowerCase() : tail;
}

async function realWorktreePathKey(path: string): Promise<string> {
  try {
    return worktreePathKey(await realpath(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    const parent = dirname(path);
    return parent === path
      ? worktreePathKey(path)
      : join(await realWorktreePathKey(parent), basename(worktreePathKey(path)));
  }
}

async function findRegisteredWorktree(paths: string[], worktreePath: string) {
  const target = worktreePathKey(worktreePath);
  const exact = paths.find((path) => worktreePathKey(path) === target);
  if (exact) {
    return exact;
  }

  // Git can record a different spelling for a configured Agent state path.
  const targetName = worktreeLastSegments(target);
  const realTarget = await realWorktreePathKey(worktreePath);
  for (const path of paths) {
    const candidate = worktreePathKey(path);
    if (
      worktreeLastSegments(candidate) === targetName &&
      (await realWorktreePathKey(path)) === realTarget
    ) {
      return path;
    }
  }
}

/** Defaults per design §10.10 / §26. */
export const DEFAULT_REPO_CACHE_CONFIG = {
  max_size_gb: 100,
  min_free_disk_gb: 30,
  retention_days: 30,
} as const;

export interface RepoCacheConfig {
  max_size_gb: number;
  min_free_disk_gb: number;
  retention_days: number;
}

export interface MirrorMetadata {
  repo_key: string;
  canonical_id: string;
  url: string;
  last_used_at: string;
  active_worktree_count: number;
  last_error?: string;
}

export interface RepoMirrorManagerOptions {
  reposDir: string;
  allowlist: GitUrlAllowlist;
  repoCache: RepoCacheConfig;
  /**
   * Test-only hook invoked after acquiring the per-repo fetch/import mutex.
   * Production callers must leave this unset.
   */
  onFetchMutexHeld?: () => void | Promise<void>;
}

interface ResolvedRepo {
  repoKey: string;
  canonicalId: string;
  url: string;
  repoDir: string;
  mirrorPath: string;
}

type GitMutation = (cwd: string, args: string[]) => Promise<void>;

// The lock belongs to the operation. Only a waiter for mirror-only work may leave early.
function waitForMirrorWork<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
  canLeave = () => true,
): Promise<T> {
  if (!signal) {
    return operation;
  }
  let listener: ReturnType<typeof addAbortListener>;
  const cancelled = new Promise<never>((_, reject) => {
    listener = addAbortListener(signal, () => {
      if (canLeave()) {
        reject(signal.reason);
      }
    });
  });
  return Promise.race([operation, cancelled]).finally(() => listener[Symbol.dispose]());
}

class FetchLockHeldError extends Error {
  constructor(
    repoKey: string,
    readonly unverified?: { reason: 'Legacy lock' | 'Abandoned Git mutation marker'; path: string },
  ) {
    const message = `Fetch lock held for ${repoKey}`;
    super(
      unverified
        ? `${message}. ${unverified.reason} at ${unverified.path}. Confirm the owning Agent and its Git processes have exited before removing this lock.`
        : message,
    );
  }
}

function isExitedProcess(rawPid: string): boolean {
  if (!/^[1-9]\d{0,9}$/.test(rawPid) || Number(rawPid) > 0x7fffffff) {
    return false;
  }
  try {
    process.kill(Number(rawPid), 0);
    return false;
  } catch (error) {
    // Treat ambiguous probe failures and reused PIDs as live owners.
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function isExitedOwner(marker: string): boolean {
  const match = /^([1-9]\d*)-[a-f\d-]{36}$/.exec(marker);
  return match !== null && isExitedProcess(match[1]);
}

async function readFetchLock(lockPath: string) {
  try {
    return await readdir(lockPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function removeEmptyFetchLock(lockPath: string): Promise<boolean> {
  try {
    await rmdir(lockPath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return true;
    }
    if (code === 'ENOTEMPTY' || code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

async function runGit(
  args: string[],
  options: { cwd?: string; gitDir?: string } = {},
): Promise<string> {
  const fullArgs = options.gitDir ? ['--git-dir', options.gitDir, ...args] : args;
  try {
    const { stdout } = await execFileAsync('git', fullArgs, {
      cwd: options.cwd ?? options.gitDir,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
    });
    return stdout.trim();
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const message = err.stderr?.trim() || err.message;
    throw new Error(`git ${fullArgs.join(' ')} failed: ${message}`);
  }
}

async function runInMirror(mirrorPath: string, args: string[]): Promise<string> {
  return runGit(args, { cwd: mirrorPath });
}

function remoteRefForFetchRef(fetchRef: string): string {
  const colon = fetchRef.indexOf(':');
  if (colon === -1) {
    if (fetchRef.startsWith('refs/heads/')) {
      const branch = fetchRef.slice('refs/heads/'.length);
      return `refs/remotes/origin/${branch}`;
    }
    return `refs/remotes/origin/${fetchRef}`;
  }
  return fetchRef.slice(colon + 1);
}

export class RepoMirrorManager {
  readonly reposDir: string;
  readonly allowlist: GitUrlAllowlist;
  readonly repoCache: RepoCacheConfig;
  private readonly onFetchMutexHeld?: () => void | Promise<void>;
  private readonly repoMutexes = new Map<string, Set<() => void>>();

  constructor(options: RepoMirrorManagerOptions) {
    this.reposDir = options.reposDir;
    this.allowlist = options.allowlist;
    this.repoCache = options.repoCache;
    this.onFetchMutexHeld = options.onFetchMutexHeld;
  }

  private resolveRepo(url: string): ResolvedRepo {
    const canonicalId = assertAllowedRepositoryUrl(url, this.allowlist);
    const repoKey = computeRepoKey(url);
    const repoDir = join(this.reposDir, repoKey);
    return {
      repoKey,
      canonicalId,
      url,
      repoDir,
      mirrorPath: join(repoDir, 'mirror.git'),
    };
  }

  private async withFetchMutex<T>(
    repo: ResolvedRepo,
    signal: AbortSignal | undefined,
    fn: (mutateGit: GitMutation) => Promise<T>,
  ): Promise<T> {
    return this.withMirrorLock(repo.repoKey, signal, async (mutateGit) => {
      await this.onFetchMutexHeld?.();
      signal?.throwIfAborted();
      return fn(mutateGit);
    });
  }

  private async withMirrorLock<T>(
    repoKey: string,
    signal: AbortSignal | undefined,
    fn: (mutateGit: GitMutation) => Promise<T>,
  ): Promise<T> {
    return this.withRepoMutex(repoKey, signal, async () => {
      const lock = await this.acquireFetchLock(repoKey);
      try {
        signal?.throwIfAborted();
        return await fn((cwd, args) => runGitMutation(lock.ownerPath, cwd, args));
      } finally {
        await lock.release();
      }
    });
  }

  private async withRepoMutex<T>(
    repoKey: string,
    signal: AbortSignal | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    signal?.throwIfAborted();
    const existing = this.repoMutexes.get(repoKey);
    const waiters = existing ?? new Set<() => void>();
    if (existing) {
      await new Promise<void>((resolve, reject) => {
        const start = () => {
          listener?.[Symbol.dispose]();
          resolve();
        };
        const listener =
          signal &&
          addAbortListener(signal, () => {
            waiters.delete(start);
            reject(signal.reason);
          });
        waiters.add(start);
      });
    } else {
      this.repoMutexes.set(repoKey, waiters);
    }
    try {
      signal?.throwIfAborted();
      return await fn();
    } finally {
      const [next] = waiters;
      if (next) {
        waiters.delete(next);
        next();
      } else {
        this.repoMutexes.delete(repoKey);
      }
    }
  }

  private get fetchLocksDir(): string {
    return join(this.reposDir, '.fetch-locks');
  }

  private metadataPath(repoDir: string): string {
    return join(repoDir, 'metadata.json');
  }

  private async acquireFetchLock(
    repoKey: string,
  ): Promise<{ ownerPath: string; release: () => Promise<void> }> {
    const lockPath = join(this.fetchLocksDir, repoKey);
    await mkdir(this.fetchLocksDir, { recursive: true });
    const staged = await mkdtemp(join(this.fetchLocksDir, '.claim-'));
    const owner = `${process.pid}-${randomUUID()}`;
    const ownerPath = join(lockPath, owner);
    const release = async () => {
      await removeEmptyFetchLock(ownerPath);
      await removeEmptyFetchLock(lockPath);
    };
    try {
      await mkdir(join(staged, owner));
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          // Publish the complete owner marker atomically. A nonempty lock directory
          // cannot be overwritten by rename.
          await rename(staged, lockPath);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'EPERM') {
            throw error;
          }
          if (!(await this.reclaimFetchLock(repoKey, lockPath))) {
            break;
          }
          continue;
        }
        try {
          await this.assertNoLegacyFetchLock(repoKey);
        } catch (error) {
          await release();
          throw error;
        }
        return { ownerPath, release };
      }
      throw new FetchLockHeldError(repoKey);
    } finally {
      await rm(staged, { recursive: true, force: true });
    }
  }

  private async reclaimFetchLock(repoKey: string, lockPath: string): Promise<boolean> {
    const owners = await readFetchLock(lockPath);
    if (owners.length === 0) {
      return removeEmptyFetchLock(lockPath);
    }
    const [owner] = owners;
    // Older marker files recorded only the Agent PID. Keep those locks held.
    if (owners.length === 1 && owner.isFile()) {
      throw new FetchLockHeldError(repoKey, {
        reason: 'Legacy lock',
        path: join(lockPath, owner.name),
      });
    }
    if (owners.length !== 1 || !owner.isDirectory()) {
      return false;
    }
    const ownerPath = join(lockPath, owner.name);
    if (isExitedOwner(owner.name) && (await removeEmptyFetchLock(ownerPath))) {
      return removeEmptyFetchLock(lockPath);
    }
    // A marker must survive a launcher crash too. Only the launcher can
    // remove its marker after Git closes. PID checks here only inform the error.
    const mutations = await readFetchLock(ownerPath);
    const abandoned = mutations.find(
      (marker) => marker.isDirectory() && isExitedOwner(marker.name),
    );
    if (abandoned) {
      throw new FetchLockHeldError(repoKey, {
        reason: 'Abandoned Git mutation marker',
        path: join(ownerPath, abandoned.name),
      });
    }
    return false;
  }

  private async assertNoLegacyFetchLock(repoKey: string): Promise<void> {
    const path = join(this.reposDir, repoKey, 'fetch.lock');
    try {
      await access(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
    // A legacy lock carries no record of Git processes that outlived its Agent.
    throw new FetchLockHeldError(repoKey, { reason: 'Legacy lock', path });
  }

  async readMetadata(repoKey: string): Promise<MirrorMetadata | null> {
    const path = this.metadataPath(join(this.reposDir, repoKey));
    try {
      const raw = await readFile(path, 'utf8');
      return JSON.parse(raw) as MirrorMetadata;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  private async writeMetadata(repoDir: string, metadata: MirrorMetadata): Promise<void> {
    await mkdir(repoDir, { recursive: true });
    const path = this.metadataPath(repoDir);
    const tempPath = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
      await rename(tempPath, path);
    } finally {
      await rm(tempPath, { force: true });
    }
  }

  private async touchMetadata(
    repo: ResolvedRepo,
    patch: Partial<Pick<MirrorMetadata, 'active_worktree_count' | 'last_error'>>,
  ): Promise<MirrorMetadata> {
    const existing =
      (await this.readMetadata(repo.repoKey)) ??
      ({
        repo_key: repo.repoKey,
        canonical_id: repo.canonicalId,
        url: repo.url,
        last_used_at: new Date().toISOString(),
        active_worktree_count: 0,
      } satisfies MirrorMetadata);
    const metadata: MirrorMetadata = {
      ...existing,
      ...patch,
      repo_key: repo.repoKey,
      canonical_id: repo.canonicalId,
      url: repo.url,
      last_used_at: new Date().toISOString(),
    };
    await this.writeMetadata(repo.repoDir, metadata);
    return metadata;
  }

  private async mirrorExists(mirrorPath: string): Promise<boolean> {
    try {
      await access(mirrorPath);
      return true;
    } catch {
      return false;
    }
  }

  private async ensureMirrorInitialized(repo: ResolvedRepo, mutateGit: GitMutation): Promise<void> {
    if (await this.mirrorExists(repo.mirrorPath)) {
      return;
    }
    await mkdir(repo.repoDir, { recursive: true });
    await mutateGit(repo.repoDir, ['clone', '--mirror', repo.url, 'mirror.git']);
  }

  async ensureMirror(
    url: string,
    signal?: AbortSignal,
  ): Promise<{ repoKey: string; mirrorPath: string; canonicalId: string }> {
    const repo = this.resolveRepo(url);
    const operation = this.withFetchMutex(repo, signal, async (mutateGit) => {
      try {
        await this.ensureMirrorInitialized(repo, mutateGit);
        await this.touchMetadata(repo, {});
        return {
          repoKey: repo.repoKey,
          mirrorPath: repo.mirrorPath,
          canonicalId: repo.canonicalId,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.touchMetadata(repo, { last_error: message });
        throw error;
      }
    });
    return waitForMirrorWork(operation, signal);
  }

  async hasCommit(repoKey: string, commit: string, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const mirrorPath = join(this.reposDir, repoKey, 'mirror.git');
    if (!(await this.mirrorExists(mirrorPath))) {
      return false;
    }
    signal?.throwIfAborted();
    const operation = runInMirror(mirrorPath, ['cat-file', '-e', `${commit}^{commit}`]).then(
      () => true,
      () => false,
    );
    return waitForMirrorWork(operation, signal);
  }

  async fetchRefs(url: string, fetchRefs: string[], signal?: AbortSignal): Promise<void> {
    const repo = this.resolveRepo(url);
    const operation = this.withFetchMutex(repo, signal, async (mutateGit) => {
      try {
        await this.ensureMirrorInitialized(repo, mutateGit);
        for (const fetchRef of fetchRefs) {
          if (signal?.aborted) {
            break;
          }
          const remoteRef = remoteRefForFetchRef(fetchRef);
          const sourceRef = fetchRef.includes(':') ? fetchRef : `${fetchRef}:${remoteRef}`;
          await mutateGit(repo.mirrorPath, ['fetch', '--no-tags', 'origin', sourceRef]);
        }
        await this.touchMetadata(repo, {});
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.touchMetadata(repo, { last_error: message });
        throw error;
      }
    });
    await waitForMirrorWork(operation, signal);
  }

  async importBundle(
    url: string,
    bundlePath: string,
    bundleId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const repo = this.resolveRepo(url);
    let readingBundle = false;
    const operation = this.withFetchMutex(repo, signal, async (mutateGit) => {
      try {
        await this.ensureMirrorInitialized(repo, mutateGit);
        signal?.throwIfAborted();
        readingBundle = true;
        await runInMirror(repo.mirrorPath, ['bundle', 'verify', toGitOsPath(bundlePath)]);
        signal?.throwIfAborted();
        const headsRaw = await runGit(['bundle', 'list-heads', toGitOsPath(bundlePath)]);
        const heads = headsRaw
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const [sha, ref] = line.split(/\s+/, 2);
            return { sha: sha as string, ref: ref as string };
          });

        for (const head of heads) {
          signal?.throwIfAborted();
          const safeRef = head.ref.replace(/^refs\//, '').replace(/[^A-Za-z0-9._/-]+/g, '_');
          const targetRef = `refs/rbo/bundles/${bundleId}/${safeRef}`;
          await mutateGit(repo.mirrorPath, [
            'fetch',
            '--no-tags',
            toGitOsPath(bundlePath),
            `${head.sha}:${targetRef}`,
          ]);
        }
        await this.touchMetadata(repo, {});
      } catch (error) {
        signal?.throwIfAborted();
        const message = error instanceof Error ? error.message : String(error);
        await this.touchMetadata(repo, { last_error: message });
        throw error;
      }
    });
    // Initialization can clone over the network. After the bundle is in use,
    // the caller must join the operation before removing the attempt directory.
    await waitForMirrorWork(operation, signal, () => !readingBundle);
  }

  async createWorktree(
    url: string,
    baseCommit: string,
    worktreePath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const repo = this.resolveRepo(url);
    await this.withMirrorLock(repo.repoKey, signal, async (mutateGit) => {
      if (!(await this.mirrorExists(repo.mirrorPath))) {
        throw new Error(`Mirror not initialized for ${repo.repoKey}`);
      }
      signal?.throwIfAborted();
      await mkdir(dirname(worktreePath), { recursive: true });
      signal?.throwIfAborted();
      await mutateGit(repo.mirrorPath, [
        'worktree',
        'add',
        '--detach',
        toGitOsPath(worktreePath),
        baseCommit,
      ]);
      const current = (await this.readMetadata(repo.repoKey))?.active_worktree_count ?? 0;
      await this.touchMetadata(repo, { active_worktree_count: current + 1 });
    });
  }

  async removeWorktree(url: string, worktreePath: string): Promise<void> {
    const repo = this.resolveRepo(url);
    await this.withMirrorLock(repo.repoKey, undefined, (mutateGit) =>
      this.removeRegisteredWorktree(repo, worktreePath, mutateGit),
    );
  }

  async tryCleanupWorktree(
    url: string,
    worktreePath: string,
    isPending: () => Promise<boolean>,
    finish: () => Promise<void>,
  ): Promise<void> {
    const repo = this.resolveRepo(url);
    if (this.repoMutexes.has(repo.repoKey)) {
      return;
    }
    try {
      await this.withMirrorLock(repo.repoKey, undefined, async (mutateGit) => {
        if (!(await isPending())) {
          return;
        }
        try {
          await access(repo.mirrorPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
          }
          // An evicted mirror has no registration left to remove.
          await finish();
          return;
        }
        await this.removeRegisteredWorktree(repo, worktreePath, mutateGit);
        await finish();
      });
    } catch (error) {
      if (!(error instanceof FetchLockHeldError) || error.unverified) {
        throw error;
      }
    }
  }

  private async registeredWorktrees(repo: ResolvedRepo): Promise<string[]> {
    const output = await runInMirror(repo.mirrorPath, ['worktree', 'list', '--porcelain', '-z']);
    return output
      .split('\0\0')
      .filter((record) => record.startsWith('worktree ') && !record.split('\0').includes('bare'))
      .map((record) => record.split('\0', 1)[0].slice('worktree '.length));
  }

  private async removeRegisteredWorktree(
    repo: ResolvedRepo,
    worktreePath: string,
    mutateGit: GitMutation,
  ): Promise<void> {
    let registered = await this.registeredWorktrees(repo);
    const registeredPath = await findRegisteredWorktree(registered, worktreePath);
    if (registeredPath) {
      await mutateGit(repo.mirrorPath, [
        'worktree',
        'remove',
        '--force',
        toGitOsPath(registeredPath),
      ]);
      await mutateGit(repo.mirrorPath, ['worktree', 'prune']);
      registered = await this.registeredWorktrees(repo);
    }
    await this.touchMetadata(repo, { active_worktree_count: registered.length });
  }

  private async directorySizeBytes(dir: string): Promise<number> {
    let total = 0;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (full === this.fetchLocksDir) {
        continue;
      }
      if (entry.isDirectory()) {
        total += await this.directorySizeBytes(full);
      } else if (entry.isFile()) {
        const info = await stat(full);
        total += info.size;
      }
    }
    return total;
  }

  async evictMirrors(
    options: {
      stubTotalSizeGb?: number;
      stubFreeDiskGb?: number;
      /** Disk-pressure cleanup keeps its explicit age threshold. */
      inactiveThroughMs?: number;
    } = {},
  ): Promise<string[]> {
    const entries = await readdir(this.reposDir, { withFileTypes: true }).catch(() => []);
    const candidates: Array<{ repoKey: string; metadata: MirrorMetadata; repoDir: string }> = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.fetch-locks') {
        continue;
      }
      const repoDir = join(this.reposDir, entry.name);
      const metadata = await this.readMetadata(entry.name).catch((error) => {
        if (options.inactiveThroughMs === undefined) {
          throw error;
        }
        return null;
      });
      if (!metadata) {
        continue;
      }
      if (metadata.active_worktree_count > 0) {
        continue;
      }
      candidates.push({ repoKey: entry.name, metadata, repoDir });
    }

    const ordered = candidates.sort(
      (a, b) => Date.parse(a.metadata.last_used_at) - Date.parse(b.metadata.last_used_at),
    );
    const pressureCutoff = options.inactiveThroughMs;
    if (pressureCutoff !== undefined) {
      return this.evictCandidates(
        ordered,
        (meta) => Date.parse(meta.last_used_at) <= pressureCutoff,
        true,
      );
    }

    const totalBytes =
      options.stubTotalSizeGb !== undefined
        ? options.stubTotalSizeGb * 1024 ** 3
        : await this.directorySizeBytes(this.reposDir);
    const freeBytes =
      options.stubFreeDiskGb !== undefined
        ? options.stubFreeDiskGb * 1024 ** 3
        : Number.POSITIVE_INFINITY;

    const overSize = totalBytes > this.repoCache.max_size_gb * 1024 ** 3;
    const lowDisk = freeBytes < this.repoCache.min_free_disk_gb * 1024 ** 3;
    const retentionCutoff = Date.now() - this.repoCache.retention_days * 24 * 60 * 60 * 1000;

    if (!overSize && !lowDisk) {
      return this.evictCandidates(
        ordered,
        (meta) => Date.parse(meta.last_used_at) < retentionCutoff,
      );
    }

    return this.evictCandidates(ordered, (meta) => Number.isFinite(Date.parse(meta.last_used_at)));
  }

  private async evictCandidates(
    candidates: Array<{ repoKey: string; repoDir: string; metadata: MirrorMetadata }>,
    eligibleByAge: (meta: MirrorMetadata) => boolean,
    skipErrors = false,
  ): Promise<string[]> {
    const evicted: string[] = [];
    for (const candidate of candidates) {
      const { repoKey, repoDir } = candidate;
      if (this.repoMutexes.has(repoKey) || !eligibleByAge(candidate.metadata)) {
        continue;
      }
      try {
        await this.withMirrorLock(repoKey, undefined, async () => {
          const current = await this.readMetadata(repoKey);
          if (current && current.active_worktree_count === 0 && eligibleByAge(current)) {
            await rm(repoDir, { recursive: true, force: true });
            evicted.push(repoKey);
          }
        });
      } catch (error) {
        if (!(error instanceof FetchLockHeldError) && !skipErrors) {
          throw error;
        }
      }
    }
    return evicted;
  }
}
