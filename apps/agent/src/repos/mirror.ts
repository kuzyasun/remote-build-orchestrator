import { execFile } from 'node:child_process';
import { access, mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { type GitUrlAllowlist, assertAllowedRepositoryUrl, computeRepoKey } from '@rbo/shared';

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
  private readonly repoMutexes = new Map<string, Promise<void>>();

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

  private async withFetchMutex<T>(repo: ResolvedRepo, fn: () => Promise<T>): Promise<T> {
    return this.withRepoMutex(repo.repoKey, async () => {
      const releaseLock = await this.acquireFetchLock(repo.repoDir);
      try {
        if (this.onFetchMutexHeld) {
          await this.onFetchMutexHeld();
        }
        return await fn();
      } finally {
        await releaseLock();
      }
    });
  }

  private async withRepoMutex<T>(repoKey: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.repoMutexes.get(repoKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = previous.then(() => gate);
    this.repoMutexes.set(repoKey, current);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.repoMutexes.get(repoKey) === current) {
        this.repoMutexes.delete(repoKey);
      }
    }
  }

  private fetchLockPath(repoDir: string): string {
    return join(repoDir, 'fetch.lock');
  }

  private metadataPath(repoDir: string): string {
    return join(repoDir, 'metadata.json');
  }

  private async acquireFetchLock(repoDir: string): Promise<() => Promise<void>> {
    const lockPath = this.fetchLockPath(repoDir);
    await mkdir(repoDir, { recursive: true });
    const handle = await open(lockPath, 'wx');
    await handle.writeFile(`${process.pid}\n`, 'utf8');
    await handle.close();
    return async () => {
      await rm(lockPath, { force: true });
    };
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
    await writeFile(this.metadataPath(repoDir), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
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

  private async ensureMirrorInitialized(repo: ResolvedRepo): Promise<void> {
    if (await this.mirrorExists(repo.mirrorPath)) {
      return;
    }
    await mkdir(repo.repoDir, { recursive: true });
    await runGit(['clone', '--mirror', repo.url, 'mirror.git'], { cwd: repo.repoDir });
  }

  async ensureMirror(
    url: string,
  ): Promise<{ repoKey: string; mirrorPath: string; canonicalId: string }> {
    const repo = this.resolveRepo(url);
    return this.withFetchMutex(repo, async () => {
      try {
        await this.ensureMirrorInitialized(repo);
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
  }

  async hasCommit(repoKey: string, commit: string): Promise<boolean> {
    const mirrorPath = join(this.reposDir, repoKey, 'mirror.git');
    if (!(await this.mirrorExists(mirrorPath))) {
      return false;
    }
    try {
      await runInMirror(mirrorPath, ['cat-file', '-e', `${commit}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }

  async fetchRefs(url: string, fetchRefs: string[]): Promise<void> {
    const repo = this.resolveRepo(url);
    await this.withFetchMutex(repo, async () => {
      try {
        await this.ensureMirrorInitialized(repo);
        for (const fetchRef of fetchRefs) {
          const remoteRef = remoteRefForFetchRef(fetchRef);
          const sourceRef = fetchRef.includes(':') ? fetchRef : `${fetchRef}:${remoteRef}`;
          await runInMirror(repo.mirrorPath, ['fetch', '--no-tags', 'origin', sourceRef]);
        }
        await this.touchMetadata(repo, {});
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.touchMetadata(repo, { last_error: message });
        throw error;
      }
    });
  }

  async importBundle(url: string, bundlePath: string, bundleId: string): Promise<void> {
    const repo = this.resolveRepo(url);
    await this.withFetchMutex(repo, async () => {
      try {
        await this.ensureMirrorInitialized(repo);
        await runInMirror(repo.mirrorPath, ['bundle', 'verify', toGitOsPath(bundlePath)]);
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
          const safeRef = head.ref.replace(/^refs\//, '').replace(/[^A-Za-z0-9._/-]+/g, '_');
          const targetRef = `refs/rbo/bundles/${bundleId}/${safeRef}`;
          await runInMirror(repo.mirrorPath, [
            'fetch',
            '--no-tags',
            toGitOsPath(bundlePath),
            `${head.sha}:${targetRef}`,
          ]);
        }
        await this.touchMetadata(repo, {});
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.touchMetadata(repo, { last_error: message });
        throw error;
      }
    });
  }

  async createWorktree(url: string, baseCommit: string, worktreePath: string): Promise<void> {
    const repo = this.resolveRepo(url);
    if (!(await this.mirrorExists(repo.mirrorPath))) {
      throw new Error(`Mirror not initialized for ${repo.repoKey}`);
    }
    await mkdir(dirname(worktreePath), { recursive: true });
    await runInMirror(repo.mirrorPath, [
      'worktree',
      'add',
      '--detach',
      toGitOsPath(worktreePath),
      baseCommit,
    ]);
    await this.touchMetadata(repo, {
      active_worktree_count:
        ((await this.readMetadata(repo.repoKey))?.active_worktree_count ?? 0) + 1,
    });
  }

  async removeWorktree(url: string, worktreePath: string): Promise<void> {
    const repo = this.resolveRepo(url);
    await runInMirror(repo.mirrorPath, [
      'worktree',
      'remove',
      '--force',
      toGitOsPath(worktreePath),
    ]);
    await runInMirror(repo.mirrorPath, ['worktree', 'prune']);
    const current = (await this.readMetadata(repo.repoKey))?.active_worktree_count ?? 1;
    await this.touchMetadata(repo, {
      active_worktree_count: Math.max(0, current - 1),
    });
  }

  private async isFetchLocked(repoDir: string): Promise<boolean> {
    try {
      await access(this.fetchLockPath(repoDir));
      return true;
    } catch {
      return false;
    }
  }

  private async directorySizeBytes(dir: string): Promise<number> {
    let total = 0;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
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
    } = {},
  ): Promise<string[]> {
    const entries = await readdir(this.reposDir, { withFileTypes: true }).catch(() => []);
    const candidates: Array<{ repoKey: string; metadata: MirrorMetadata; repoDir: string }> = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const repoDir = join(this.reposDir, entry.name);
      const metadata = await this.readMetadata(entry.name);
      if (!metadata) {
        continue;
      }
      if (metadata.active_worktree_count > 0) {
        continue;
      }
      if (await this.isFetchLocked(repoDir)) {
        continue;
      }
      candidates.push({ repoKey: entry.name, metadata, repoDir });
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
      const expired = candidates.filter(
        (item) => Date.parse(item.metadata.last_used_at) < retentionCutoff,
      );
      if (expired.length === 0) {
        return [];
      }
      return this.evictCandidates(
        expired.sort(
          (a, b) => Date.parse(a.metadata.last_used_at) - Date.parse(b.metadata.last_used_at),
        ),
      );
    }

    return this.evictCandidates(
      candidates.sort(
        (a, b) => Date.parse(a.metadata.last_used_at) - Date.parse(b.metadata.last_used_at),
      ),
    );
  }

  private async evictCandidates(
    candidates: Array<{ repoKey: string; repoDir: string }>,
  ): Promise<string[]> {
    const evicted: string[] = [];
    for (const candidate of candidates) {
      await rm(candidate.repoDir, { recursive: true, force: true });
      evicted.push(candidate.repoKey);
    }
    return evicted;
  }
}
