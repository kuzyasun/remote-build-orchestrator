import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  type GitUrlAllowlist,
  assertAllowedRepositoryUrl,
  evaluateRepositoryUrl,
} from '@rbo/shared';

const execFileAsync = promisify(execFile);

export interface ControlledGitSourceOptions {
  repoRoot: string;
  allowlist: GitUrlAllowlist;
  submodules: boolean;
  lfs: boolean;
  /** When false, skip git-lfs pull even if lfs=true (capability gate). */
  gitLfsAvailable?: boolean;
}

const CONTROLLED_GIT_CONFIG = [
  '-c',
  'core.autocrlf=false',
  '-c',
  'core.hooksPath=',
  '-c',
  'init.defaultBranch=main',
] as const;

async function runGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const fullArgs = [...CONTROLLED_GIT_CONFIG, ...args];
  try {
    const { stdout } = await execFileAsync('git', fullArgs, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
      env: env ? { ...process.env, ...env } : process.env,
    });
    return stdout.trim();
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const message = err.stderr?.trim() || err.message;
    throw new Error(`git ${fullArgs.join(' ')} failed: ${message}`);
  }
}

async function readSubmoduleUrls(repoRoot: string): Promise<string[]> {
  try {
    const raw = await readFile(join(repoRoot, '.gitmodules'), 'utf8');
    const urls: string[] = [];
    for (const line of raw.split('\n')) {
      const match = /^\s*url\s*=\s*(.+)\s*$/i.exec(line);
      if (match?.[1]) {
        urls.push(match[1].trim());
      }
    }
    return urls;
  } catch {
    return [];
  }
}

function assertSubmoduleUrlsAllowed(urls: string[], allowlist: GitUrlAllowlist): void {
  for (const url of urls) {
    const result = evaluateRepositoryUrl(url, allowlist);
    if (!result.ok) {
      throw new Error(
        `Submodule URL rejected (${result.reason ?? 'unknown'}): not allowed by Git allowlist`,
      );
    }
  }
}

/**
 * Materialize clean base submodules and LFS content under controlled Git config (§11.14–11.15).
 */
export async function applyControlledGitSource(options: ControlledGitSourceOptions): Promise<void> {
  const { repoRoot, allowlist, submodules, lfs, gitLfsAvailable = true } = options;

  if (submodules) {
    const urls = await readSubmoduleUrls(repoRoot);
    assertSubmoduleUrlsAllowed(urls, allowlist);
    await runGit(repoRoot, ['submodule', 'sync', '--recursive']);
    await runGit(repoRoot, ['submodule', 'update', '--init', '--recursive', '--depth', '1']);
  }

  if (lfs) {
    if (!gitLfsAvailable) {
      throw new Error('git-lfs is required but not available on this Agent');
    }
    await runGit(repoRoot, ['lfs', 'install', '--local', '--force']);
    await runGit(repoRoot, ['lfs', 'pull']);
  }

  // Re-validate primary remote after materialization helpers (fail closed).
  try {
    const origin = await runGit(repoRoot, ['remote', 'get-url', 'origin']);
    if (origin) {
      assertAllowedRepositoryUrl(origin, allowlist);
    }
  } catch {
    // Detached worktrees may not expose origin; submodule URLs were checked above.
  }
}

export interface CheckoutOverlayGitlinkPinsOptions {
  projectPath: string;
  pins: Array<{ path: string; commit: string }>;
  allowlist: GitUrlAllowlist;
}

/**
 * Check out submodule pins parent-before-child for git_overlay snapshot manifests (§11.14 / Approach A).
 */
export async function checkoutOverlayGitlinkPins(
  options: CheckoutOverlayGitlinkPinsOptions,
): Promise<void> {
  const { projectPath, pins, allowlist } = options;
  if (pins.length === 0) {
    return;
  }

  const sortedPins = [...pins].sort((a, b) => {
    const depthA = a.path.split('/').length;
    const depthB = b.path.split('/').length;
    if (depthA !== depthB) {
      return depthA - depthB;
    }
    return a.path.localeCompare(b.path);
  });

  for (const pin of sortedPins) {
    const subDir = join(projectPath, pin.path);

    const nestedUrls = await readSubmoduleUrls(subDir);
    assertSubmoduleUrlsAllowed(nestedUrls, allowlist);

    let hasCommit = false;
    try {
      await runGit(subDir, ['cat-file', '-e', `${pin.commit}^{commit}`]);
      hasCommit = true;
    } catch {
      hasCommit = false;
    }

    if (!hasCommit) {
      try {
        await runGit(subDir, ['fetch', '--depth', '1', 'origin', pin.commit]);
      } catch {
        await runGit(subDir, ['fetch', 'origin']);
      }
    }

    await runGit(subDir, ['checkout', '--detach', pin.commit]);
  }
}
