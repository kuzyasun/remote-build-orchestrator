import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { type GitUrlAllowlist, assertAllowedRepositoryUrl, createLogger } from '@rbo/shared';
import type { RepoMirrorManager } from '../repos/mirror.js';

const logger = createLogger('agent.worktree-cleanup');
const CLEANUP_BATCH_SIZE = 8;
const ATTEMPT_ID = /^att_[a-zA-Z0-9_-]{1,80}$/;

function intentDir(stateDir: string): string {
  return join(stateDir, 'pending-worktree-cleanup');
}

function intentPath(stateDir: string, attemptId: string): string {
  if (!ATTEMPT_ID.test(attemptId)) {
    throw new Error('Invalid attempt ID for worktree cleanup');
  }
  return join(intentDir(stateDir), attemptId);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

export function hasPendingWorktreeCleanup(stateDir: string, attemptId: string): boolean {
  if (!ATTEMPT_ID.test(attemptId)) {
    return false;
  }
  try {
    lstatSync(intentPath(stateDir, attemptId));
    return true;
  } catch (error) {
    return !isMissing(error);
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    if (!(await lstat(path)).isDirectory()) {
      throw new Error(`Worktree cleanup expected a directory at ${path}`);
    }
    return true;
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
    return false;
  }
}

export class WorktreeCleanup {
  private readonly inProgress = new Map<string, Promise<void>>();
  private readonly unwritten = new Map<string, string>();
  private lastRetried = '';
  private retrying = false;

  constructor(
    private readonly stateDir: string,
    private readonly allowlist: GitUrlAllowlist,
    private readonly mirrors: Pick<RepoMirrorManager, 'tryCleanupWorktree'>,
  ) {}

  hasPending(attemptId: string): boolean {
    return (
      this.unwritten.has(attemptId) ||
      this.inProgress.has(attemptId) ||
      hasPendingWorktreeCleanup(this.stateDir, attemptId)
    );
  }

  enqueue(attemptId: string, repoUrl: string): Promise<void> {
    if (!this.unwritten.has(attemptId) && !this.inProgress.has(attemptId)) {
      this.unwritten.set(attemptId, repoUrl);
    }
    return this.tryCleanup(attemptId);
  }

  async retryPending(isActive: (attemptId: string) => boolean): Promise<void> {
    if (this.retrying) {
      return;
    }
    this.retrying = true;
    try {
      const dir = intentDir(this.stateDir);
      const persisted = (await isDirectory(dir)) ? await readdir(dir) : [];
      const ids = [...new Set([...persisted, ...this.unwritten.keys()])]
        .filter((id) => ATTEMPT_ID.test(id))
        .sort();
      const start = ids.findIndex((id) => id > this.lastRetried);
      const offset = Math.max(0, start);
      const ordered = [...ids.slice(offset), ...ids.slice(0, offset)];
      for (const attemptId of ordered.slice(0, CLEANUP_BATCH_SIZE)) {
        this.lastRetried = attemptId;
        if (!isActive(attemptId) && !this.inProgress.has(attemptId)) {
          await this.tryCleanup(attemptId);
        }
      }
    } catch (error) {
      if (!isMissing(error)) {
        logger.warn('could not scan pending worktree cleanup', { error: String(error) });
      }
    } finally {
      this.retrying = false;
    }
  }

  private tryCleanup(attemptId: string): Promise<void> {
    const current = this.inProgress.get(attemptId);
    if (current) {
      return current;
    }
    const cleanup = this.cleanup(attemptId)
      .catch((error) => {
        logger.warn('worktree cleanup remains pending', { attemptId, error: String(error) });
      })
      .finally(() => this.inProgress.delete(attemptId));
    this.inProgress.set(attemptId, cleanup);
    return cleanup;
  }

  private async cleanup(attemptId: string): Promise<void> {
    const pendingRepo = this.unwritten.get(attemptId);
    if (pendingRepo !== undefined) {
      await this.persist(attemptId, pendingRepo);
      this.unwritten.delete(attemptId);
    }
    const repoUrl = await this.readIntent(attemptId);
    if (repoUrl === undefined) {
      return;
    }
    const workspace = await this.resolveWorkspace(attemptId);
    await this.mirrors.tryCleanupWorktree(
      repoUrl,
      join(workspace, 'project'),
      async () => {
        // Revalidate after acquiring the shared mirror lock. Another Agent may
        // have completed the cleanup after this Agent read the intent.
        if ((await this.readIntent(attemptId)) !== repoUrl) {
          return false;
        }
        if ((await this.resolveWorkspace(attemptId)) !== workspace) {
          throw new Error('Worktree cleanup workspace changed before the mirror lock was acquired');
        }
        return true;
      },
      async () => {
        await rm(workspace, { recursive: true, force: true });
        const retired = join(intentDir(this.stateDir), `.retired-${randomUUID()}`);
        await rename(intentPath(this.stateDir, attemptId), retired);
        await rm(retired, { recursive: true, force: true });
      },
    );
  }

  private async persist(attemptId: string, repoUrl: string): Promise<void> {
    const path = intentPath(this.stateDir, attemptId);
    assertAllowedRepositoryUrl(repoUrl, this.allowlist);
    const dir = intentDir(this.stateDir);
    await mkdir(dir, { recursive: true });
    await isDirectory(dir);
    const staged = await mkdtemp(join(dir, '.intent-'));
    try {
      await writeFile(join(staged, 'repo-url'), repoUrl, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
        flush: true,
      });
      try {
        // A nonempty intent directory cannot be replaced by another publisher.
        await rename(staged, path);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST' && code !== 'ENOTEMPTY' && code !== 'EPERM') {
          throw error;
        }
        const existing = await this.readIntent(attemptId);
        if (existing === undefined) {
          throw error;
        }
        if (existing !== repoUrl) {
          throw new Error('Conflicting persisted worktree cleanup intent');
        }
      }
    } finally {
      await rm(staged, { recursive: true, force: true });
    }
  }

  private async readIntent(attemptId: string): Promise<string | undefined> {
    const path = intentPath(this.stateDir, attemptId);
    try {
      if (!(await isDirectory(intentDir(this.stateDir))) || !(await isDirectory(path))) {
        return undefined;
      }
      const urlPath = join(path, 'repo-url');
      if (!(await lstat(urlPath)).isFile()) {
        throw new Error('Worktree cleanup intent is not a regular file');
      }
      const repoUrl = await readFile(urlPath, 'utf8');
      assertAllowedRepositoryUrl(repoUrl, this.allowlist);
      return repoUrl;
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
      return undefined;
    }
  }

  private async resolveWorkspace(attemptId: string): Promise<string> {
    const state = await realpath(this.stateDir);
    const workspaces = join(state, 'workspaces');
    const workspace = join(workspaces, attemptId);
    if ((await isDirectory(workspaces)) && (await isDirectory(workspace))) {
      await isDirectory(join(workspace, 'project'));
    }
    return workspace;
  }
}
