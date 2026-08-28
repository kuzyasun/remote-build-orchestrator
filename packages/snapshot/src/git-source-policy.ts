import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { RboError } from '@rbo/shared';
import { gitStatusPorcelainV2, normalizeWirePath, resolveInside } from './git-status.js';

const execFileAsync = promisify(execFile);

const LFS_POINTER_PREFIX = 'version https://git-lfs.github.com/spec/v1';

export type SubmoduleState = 'clean' | 'uninitialized' | 'dirty' | 'conflict';

export interface SubmoduleStatusEntry {
  path: string;
  state: SubmoduleState;
  commit: string;
}

export interface GitSourceRequirements {
  /** Repository declares submodules that a git_overlay Agent must init. */
  submodules: boolean;
  /** Repository uses Git LFS; Agent must materialize LFS objects. */
  lfs: boolean;
}

async function runGit(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync('git', args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
      env: env ? { ...process.env, ...env } : process.env,
    });
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const message = err.stderr?.trim() || err.message;
    throw new Error(`git ${args.join(' ')} failed: ${message}`);
  }
}

/** Parse `git submodule status --recursive` lines. */
export function parseSubmoduleStatus(output: string): SubmoduleStatusEntry[] {
  const entries: SubmoduleStatusEntry[] = [];
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line) {
      continue;
    }
    const prefix = line[0];
    const rest = line.slice(1).trim();
    const match = /^([0-9a-f]{7,40})\s+(\S+)(?:\s+\((.+)\))?/.exec(rest);
    if (!match) {
      continue;
    }
    const commit = match[1] as string;
    const path = normalizeWirePath(match[2] as string);
    let state: SubmoduleState;
    if (prefix === ' ') {
      state = 'clean';
    } else if (prefix === '-') {
      state = 'uninitialized';
    } else if (prefix === '+') {
      state = 'dirty';
    } else if (prefix === 'U') {
      state = 'conflict';
    } else {
      state = 'dirty';
    }
    entries.push({ path, state, commit });
  }
  return entries;
}

export async function gitSubmoduleStatus(repoRoot: string): Promise<SubmoduleStatusEntry[]> {
  try {
    const { stdout } = await runGit(repoRoot, ['submodule', 'status', '--recursive']);
    return parseSubmoduleStatus(stdout);
  } catch {
    throw new RboError(
      'materialization',
      'Unable to inspect submodule status. Retry the snapshot capture.',
      true,
      { reason: 'submodule_status_failed' },
    );
  }
}

export async function hasGitModulesFile(repoRoot: string): Promise<boolean> {
  try {
    await readFile(join(repoRoot, '.gitmodules'), 'utf8');
    return true;
  } catch {
    return false;
  }
}

export function isLfsPointer(content: Buffer | string): boolean {
  // Slice BEFORE decoding: an LFS pointer is a short ASCII header, so only the
  // first bytes can ever match. Decoding the whole buffer first turned every
  // captured file into a UTF-8 string just to read ~130 bytes of it — on a repo
  // with a few hundred MB of tracked binaries (CAD/PCB assets) that is minutes
  // of CPU in one non-yielding call, which also blocks the event loop.
  const text =
    typeof content === 'string' ? content.slice(0, 200) : content.subarray(0, 200).toString('utf8');
  return text.startsWith(LFS_POINTER_PREFIX);
}

export async function gitLfsTrackedPaths(repoRoot: string): Promise<string[]> {
  try {
    const { stdout } = await runGit(repoRoot, ['lfs', 'ls-files', '-n']);
    return stdout
      .split('\n')
      .map((line) => normalizeWirePath(line.trim()))
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

async function walkSubmoduleFiles(
  repoRoot: string,
  submodulePath: string,
  relativePrefix = '',
): Promise<string[]> {
  const absolute = resolveInside(repoRoot, submodulePath);
  const paths: string[] = [];
  const entries = await readdir(absolute, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.git') {
      continue;
    }
    const rel = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
    const wirePath = normalizeWirePath(join(submodulePath, rel).replace(/\\/g, '/'));
    if (entry.isDirectory()) {
      paths.push(...(await walkSubmoduleFiles(repoRoot, submodulePath, rel)));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      paths.push(wirePath);
    }
  }
  return paths.sort();
}

export async function enumerateSubmoduleContentPaths(
  repoRoot: string,
  submodules: SubmoduleStatusEntry[],
): Promise<string[]> {
  const paths: string[] = [];
  for (const submodule of submodules) {
    if (submodule.state !== 'clean') {
      continue;
    }
    paths.push(...(await walkSubmoduleFiles(repoRoot, submodule.path)));
  }
  return paths.sort();
}

function submoduleFailure(
  reason: 'dirty_submodule' | 'uninitialized_submodule',
  path: string,
  state: SubmoduleState,
): never {
  throw new RboError('materialization', `Submodule not ready for capture: ${path}`, false, {
    reason,
    path,
    state,
  });
}

/** Fail closed when submodules are missing, dirty, or conflicted (§11.14). */
export async function assertSubmodulesReadyForCapture(
  repoRoot: string,
): Promise<SubmoduleStatusEntry[]> {
  const hasModules = await hasGitModulesFile(repoRoot);
  if (!hasModules) {
    return [];
  }
  const statuses = await gitSubmoduleStatus(repoRoot);
  if (statuses.length === 0 && hasModules) {
    throw new RboError(
      'materialization',
      'Repository declares submodules but none are initialized',
      false,
      { reason: 'uninitialized_submodule' },
    );
  }
  for (const entry of statuses) {
    if (entry.state === 'uninitialized') {
      submoduleFailure('uninitialized_submodule', entry.path, entry.state);
    }
    if (entry.state === 'dirty' || entry.state === 'conflict') {
      submoduleFailure('dirty_submodule', entry.path, entry.state);
    }
    const subRoot = resolveInside(repoRoot, entry.path);
    const subStatus = await gitStatusPorcelainV2(subRoot);
    if (subStatus.entries.length > 0) {
      submoduleFailure('dirty_submodule', entry.path, 'dirty');
    }
  }
  return statuses;
}

/** Fail closed when submodules are uninitialized or conflicted for git_overlay capture (§11.14 / Approach A). */
export async function assertSubmodulesReadyForOverlayCapture(
  repoRoot: string,
): Promise<SubmoduleStatusEntry[]> {
  const hasModules = await hasGitModulesFile(repoRoot);
  if (!hasModules) {
    return [];
  }
  const statuses = await gitSubmoduleStatus(repoRoot);
  if (statuses.length === 0 && hasModules) {
    throw new RboError(
      'materialization',
      'Repository declares submodules but none are initialized. Run git submodule update --init --recursive in the project root, then retry the job.',
      false,
      { reason: 'uninitialized_submodule' },
    );
  }
  for (const entry of statuses) {
    if (entry.state === 'uninitialized') {
      throw new RboError(
        'materialization',
        `Submodule '${entry.path}' is not initialized. Run git submodule update --init --recursive in the project root, then retry the job.`,
        false,
        { reason: 'uninitialized_submodule', path: entry.path, state: entry.state },
      );
    }
    if (entry.state === 'conflict') {
      throw new RboError(
        'materialization',
        `Submodule '${entry.path}' has conflicts. Resolve conflicts before capture.`,
        false,
        { reason: 'submodule_conflict', path: entry.path, state: entry.state },
      );
    }
  }
  return statuses;
}

/** Fail when captured paths contain LFS pointer bytes instead of materialized content (§11.15). */
// TODO(§11.15 follow-up): transfer local-only LFS objects as explicit blobs in overlay/full payloads.
export async function assertLfsContentMaterialized(
  repoRoot: string,
  wirePaths: string[],
): Promise<void> {
  const missing: string[] = [];
  for (const wirePath of wirePaths) {
    const absolute = resolveInside(repoRoot, wirePath);
    try {
      const content = await readFile(absolute);
      if (isLfsPointer(content)) {
        missing.push(wirePath);
      }
    } catch {
      const tracked = await gitLfsTrackedPaths(repoRoot);
      if (tracked.includes(wirePath)) {
        missing.push(wirePath);
      }
    }
  }
  if (missing.length > 0) {
    throw new RboError(
      'materialization',
      `Git LFS content missing for: ${missing.sort().join(', ')}`,
      false,
      { reason: 'lfs_content_missing', paths: missing.sort() },
    );
  }
}

async function repoDeclaresLfs(repoRoot: string): Promise<boolean> {
  const tracked = await gitLfsTrackedPaths(repoRoot);
  if (tracked.length > 0) {
    return true;
  }
  try {
    const attrs = await readFile(join(repoRoot, '.gitattributes'), 'utf8');
    return /filter\s*=\s*lfs/i.test(attrs);
  } catch {
    return false;
  }
}

export async function detectGitSourceRequirements(
  repoRoot: string,
): Promise<GitSourceRequirements> {
  const [hasModules, lfs] = await Promise.all([
    hasGitModulesFile(repoRoot),
    repoDeclaresLfs(repoRoot),
  ]);
  return {
    submodules: hasModules,
    lfs,
  };
}

export function expandFullSnapshotPaths(
  basePaths: string[],
  submoduleGitlinkPaths: Set<string>,
  submoduleContentPaths: string[],
): string[] {
  const withoutGitlinks = basePaths.filter((path) => !submoduleGitlinkPaths.has(path));
  const combined = new Set<string>([...withoutGitlinks, ...submoduleContentPaths]);
  return [...combined].map(normalizeWirePath).sort();
}

export async function collectSubmoduleGitlinkPaths(repoRoot: string): Promise<Set<string>> {
  const statuses = await gitSubmoduleStatus(repoRoot);
  return new Set(statuses.map((entry) => entry.path));
}
