import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import {
  type GitUrlAllowlist,
  evaluateRepositoryUrl,
  isPathContained,
  isSafeRelativePath,
} from '@rbo/shared';

const execFileAsync = promisify(execFile);
const GIT_COMMAND_TIMEOUT_MS = 5 * 60_000;
const GIT_LFS_PROBE_TIMEOUT_MS = 10_000;
const TASKKILL_TIMEOUT_MS = 3_000;
const GIT_STOP_TIMEOUT_MS = 5_000;
const GIT_COMMAND_OUTPUT_LIMIT = 64 * 1024 * 1024;

type RunGit = (cwd: string, args: string[], allowNoMatch?: boolean) => Promise<string>;

class ControlledGitExitError extends Error {}

export interface ControlledGitSourceOptions {
  repoRoot: string;
  allowlist: GitUrlAllowlist;
  submodules: boolean;
  lfs: boolean;
  /** When false, skip git-lfs pull even if lfs=true (capability gate). */
  gitLfsAvailable?: boolean;
  signal?: AbortSignal;
}

const CONTROLLED_GIT_CONFIG = [
  '--literal-pathspecs',
  '-c',
  'core.autocrlf=false',
  '-c',
  'core.hooksPath=',
  '-c',
  'init.defaultBranch=main',
  '-c',
  'submodule.recurse=false',
  '-c',
  'fetch.recurseSubmodules=false',
  '-c',
  'protocol.file.allow=never',
  '-c',
  'protocol.ext.allow=never',
] as const;

async function stopGitCommand(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // The process group may have already exited.
    }
  } else {
    try {
      // Keep Git alive until taskkill has inspected its process tree.
      await execFileAsync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        timeout: TASKKILL_TIMEOUT_MS,
        windowsHide: true,
      });
      return;
    } catch {
      // Fall back to the child handle if the tree could not be enumerated.
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // The child may have already exited.
  }
}

function runControlledGitCommand(
  cwd: string | undefined,
  executable: 'git' | 'git-lfs',
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
  allowNoMatch = false,
): Promise<string> {
  signal?.throwIfAborted();
  const command = `${executable} ${args.join(' ')}`;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let interruption: { reason: unknown } | undefined;
    let stopTimer: NodeJS.Timeout | undefined;
    let stopTask: Promise<void> | undefined;
    let spawnError: Error | undefined;
    function cleanup(): void {
      clearTimeout(deadline);
      clearTimeout(stopTimer);
      signal?.removeEventListener('abort', abort);
    }
    function stop(reason: unknown): void {
      if (interruption) return;
      interruption = { reason };
      stopTimer = setTimeout(() => {
        // A stray descendant can hold the pipes open after Git was killed.
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        cleanup();
        reject(reason);
      }, GIT_STOP_TIMEOUT_MS);
      stopTask = stopGitCommand(child);
    }
    function abort(): void {
      stop(signal?.reason);
    }
    function collect(stream: Readable, name: string): () => string {
      const chunks: Buffer[] = [];
      let bytes = 0;
      stream.on('data', (chunk: Buffer) => {
        if (interruption) return;
        bytes += chunk.length;
        if (bytes > GIT_COMMAND_OUTPUT_LIMIT) {
          stop(new Error(`${command} failed: ${name} exceeds the output limit`));
        } else {
          chunks.push(chunk);
        }
      });
      stream.on('error', stop);
      return () => Buffer.concat(chunks, bytes).toString('utf8');
    }

    const stdout = collect(child.stdout, 'stdout');
    const stderr = collect(child.stderr, 'stderr');
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('close', async (code, childSignal) => {
      await stopTask;
      cleanup();
      if (interruption) {
        reject(interruption.reason);
      } else if (spawnError) {
        reject(spawnError);
      } else if (code === 0) {
        resolve(stdout());
      } else {
        const detail = stderr();
        if (allowNoMatch && code === 1 && !detail) {
          resolve('');
        } else {
          reject(
            new ControlledGitExitError(
              `${command} failed: ${detail.trim() || `exited with ${childSignal ?? code}`}`,
            ),
          );
        }
      }
    });
    const deadline = setTimeout(() => {
      stop(new Error(`${command} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function gitRunner(signal?: AbortSignal): RunGit {
  return (cwd, args, allowNoMatch) =>
    runControlledGitCommand(
      cwd,
      'git',
      [...CONTROLLED_GIT_CONFIG, ...args],
      GIT_COMMAND_TIMEOUT_MS,
      signal,
      allowNoMatch,
    );
}

export async function hasControlledGitLfsTrackedFiles(
  repoRoot: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const files = await gitRunner(signal)(repoRoot, ['lfs', 'ls-files', '-n']);
    return files.trim().length > 0;
  } catch (error) {
    signal?.throwIfAborted();
    // A repository can declare LFS attributes even when Git LFS is absent.
    if (error instanceof ControlledGitExitError) return false;
    throw error;
  }
}

export async function isControlledGitLfsAvailable(signal?: AbortSignal): Promise<boolean> {
  try {
    await runControlledGitCommand(
      undefined,
      'git-lfs',
      ['version'],
      GIT_LFS_PROBE_TIMEOUT_MS,
      signal,
    );
    return true;
  } catch (error) {
    signal?.throwIfAborted();
    if (
      error instanceof ControlledGitExitError ||
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return false;
    }
    throw error;
  }
}

async function statIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

interface SubmoduleConfig {
  name: string;
  path?: string;
  url?: string;
}

async function readSubmoduleConfig(repoRoot: string, runGit: RunGit): Promise<SubmoduleConfig[]> {
  const gitmodules = await statIfPresent(join(repoRoot, '.gitmodules'));
  if (!gitmodules) {
    return [];
  }
  if (!gitmodules.isFile()) {
    throw new Error('.gitmodules must be a regular file');
  }
  const config = await runGit(
    repoRoot,
    [
      'config',
      '--no-includes',
      '--file',
      '.gitmodules',
      '--null',
      '--get-regexp',
      '^submodule\\..*\\.(path|url)$',
    ],
    true,
  );
  const modules = new Map<string, SubmoduleConfig>();
  for (const record of config.split('\0').slice(0, -1)) {
    const match = /^submodule\.(.+)\.(path|url)\n([\s\S]*)$/.exec(record);
    if (!match?.[1] || (match[2] !== 'path' && match[2] !== 'url')) {
      throw new Error('Invalid .gitmodules entry');
    }
    const [, name, field, value] = match;
    const module = modules.get(name) ?? { name };
    if (module[field] !== undefined) {
      throw new Error('Duplicate submodule path or URL setting');
    }
    module[field] = value;
    modules.set(name, module);
  }
  return [...modules.values()];
}

function assertSubmoduleUrlAllowed(url: string, allowlist: GitUrlAllowlist): void {
  const result = evaluateRepositoryUrl(url, allowlist);
  if (!result.ok || url.includes('\\') || /\s/.test(url)) {
    throw new Error(
      `Submodule URL rejected (${result.reason ?? 'unparseable'}): not allowed by Git allowlist`,
    );
  }
}

async function assertEffectiveSubmoduleUrlAllowed(
  repoRoot: string,
  remote: string,
  allowlist: GitUrlAllowlist,
  runGit: RunGit,
  gitContext: string[] = [],
): Promise<void> {
  // This expands Git's effective URL (including insteadOf) without opening a transport.
  const effective = await runGit(repoRoot, [...gitContext, 'ls-remote', '--get-url', '--', remote]);
  assertSubmoduleUrlAllowed(effective.replace(/\r?\n$/, ''), allowlist);
}

async function getRegisteredSubmoduleUrl(
  repoRoot: string,
  name: string,
  runGit: RunGit,
): Promise<string> {
  const value = await runGit(
    repoRoot,
    ['config', '--null', '--get', `submodule.${name}.url`],
    true,
  );
  return value.replace(/\0$/, '');
}

async function submodulePath(repoRoot: string, path: string): Promise<string> {
  if (!isSafeRelativePath(path) || path.includes('\\')) {
    throw new Error(`Unsafe submodule path: ${path}`);
  }
  const subDir = join(repoRoot, path);
  if (!isPathContained(repoRoot, subDir)) {
    throw new Error(`Submodule path escapes its repository: ${path}`);
  }
  let parent = repoRoot;
  for (const part of path.split('/')) {
    parent = join(parent, part);
    const existing = await statIfPresent(parent);
    if (!existing) {
      break;
    }
    if (!existing.isDirectory()) {
      throw new Error(`Submodule path has a non-directory component: ${path}`);
    }
  }
  return subDir;
}

async function assertDefaultFetchRemoteAllowed(
  repoRoot: string,
  allowlist: GitUrlAllowlist,
  runGit: RunGit,
  gitContext: string[] = [],
): Promise<void> {
  const branch = await runGit(repoRoot, [...gitContext, 'symbolic-ref', '--quiet', 'HEAD'], true);
  const configuredRemote = branch
    ? await runGit(
        repoRoot,
        [
          ...gitContext,
          'config',
          '--null',
          '--get',
          `branch.${branch.trim().replace(/^refs\/heads\//, '')}.remote`,
        ],
        true,
      )
    : '';
  await assertEffectiveSubmoduleUrlAllowed(
    repoRoot,
    configuredRemote.replace(/\0$/, '') || 'origin',
    allowlist,
    runGit,
    gitContext,
  );
}

async function updateSubmoduleLevel(
  repoRoot: string,
  allowlist: GitUrlAllowlist,
  runGit: RunGit,
): Promise<string[]> {
  const modules = await readSubmoduleConfig(repoRoot, runGit);
  if (modules.length === 0) {
    return [];
  }
  const index = await runGit(repoRoot, ['ls-files', '--stage', '-z']);
  const gitlinks = new Set(
    index.split('\0').flatMap((entry) => {
      const tab = entry.indexOf('\t');
      return entry.startsWith('160000 ') && tab !== -1 && entry.slice(0, tab).endsWith(' 0')
        ? [entry.slice(tab + 1)]
        : [];
    }),
  );
  const children = new Map<string, { name: string; path: string; subDir: string }>();
  for (const module of modules) {
    if (module.url !== undefined && !module.url.startsWith('./') && !module.url.startsWith('../')) {
      assertSubmoduleUrlAllowed(module.url, allowlist);
    }
    if (module.path && gitlinks.has(module.path)) {
      if (
        children.has(module.path) ||
        !isSafeRelativePath(module.name) ||
        module.name.includes('\\')
      ) {
        throw new Error('Invalid or duplicate submodule path mapping');
      }
      children.set(module.path, {
        name: module.name,
        path: module.path,
        subDir: await submodulePath(repoRoot, module.path),
      });
    }
  }
  if (gitlinks.size !== children.size) {
    throw new Error('Missing .gitmodules configuration for a submodule');
  }
  if (children.size === 0) {
    return [];
  }

  const paths = [...children.keys()];
  // init and sync do not fetch; Git resolves relative URLs against the parent remote here.
  await runGit(repoRoot, ['submodule', 'init', '--', ...paths]);
  await runGit(repoRoot, ['submodule', 'sync', '--', ...paths]);
  for (const { name, subDir } of children.values()) {
    const registeredUrl = await getRegisteredSubmoduleUrl(repoRoot, name, runGit);
    assertSubmoduleUrlAllowed(registeredUrl, allowlist);
    await assertEffectiveSubmoduleUrlAllowed(repoRoot, registeredUrl, allowlist, runGit);
    if (await statIfPresent(join(subDir, '.git'))) {
      await assertDefaultFetchRemoteAllowed(subDir, allowlist, runGit);
    } else {
      // Git reuses the stored repository after deinit, even without a .git entry
      // in the worktree. Its fetch configuration can differ from the clone URL.
      const gitDir = (
        await runGit(repoRoot, [
          'rev-parse',
          '--path-format=absolute',
          '--git-path',
          `modules/${name}`,
        ])
      ).replace(/\r?\n$/, '');
      if (await statIfPresent(gitDir)) {
        await assertDefaultFetchRemoteAllowed(repoRoot, allowlist, runGit, [
          `--git-dir=${gitDir}`,
          `--work-tree=${repoRoot}`,
        ]);
      }
    }
  }
  await runGit(repoRoot, ['submodule', 'update', '--checkout', '--depth', '1', '--', ...paths]);
  return [...children.values()].map(({ subDir }) => subDir);
}

/**
 * Materialize clean base submodules and LFS content under controlled Git config (§11.14–11.15).
 */
export async function applyControlledGitSource(options: ControlledGitSourceOptions): Promise<void> {
  const { repoRoot, allowlist, submodules, lfs, gitLfsAvailable = true, signal } = options;
  signal?.throwIfAborted();
  const runGit = gitRunner(signal);

  if (submodules) {
    const pending = [await realpath(repoRoot)];
    for (const parent of pending) {
      signal?.throwIfAborted();
      pending.push(...(await updateSubmoduleLevel(parent, allowlist, runGit)));
    }
  }

  if (lfs) {
    if (!gitLfsAvailable) {
      throw new Error('git-lfs is required but not available on this Agent');
    }
    await runGit(repoRoot, ['lfs', 'install', '--local', '--force']);
    await runGit(repoRoot, ['lfs', 'pull']);
  }
  signal?.throwIfAborted();
}

export interface CheckoutOverlayGitlinkPinsOptions {
  projectPath: string;
  pins: Array<{ path: string; commit: string }>;
  allowlist: GitUrlAllowlist;
  signal?: AbortSignal;
}

/**
 * Check out submodule pins parent-before-child for git_overlay snapshot manifests (§11.14 / Approach A).
 */
export async function checkoutOverlayGitlinkPins(
  options: CheckoutOverlayGitlinkPinsOptions,
): Promise<void> {
  const { projectPath, pins, allowlist, signal } = options;
  signal?.throwIfAborted();
  if (pins.length === 0) {
    return;
  }
  const runGit = gitRunner(signal);

  const sortedPins = [...pins].sort((a, b) => {
    const depthA = a.path.split('/').length;
    const depthB = b.path.split('/').length;
    if (depthA !== depthB) {
      return depthA - depthB;
    }
    return a.path.localeCompare(b.path);
  });

  const repoRoot = await realpath(projectPath);
  for (const pin of sortedPins) {
    signal?.throwIfAborted();
    const subDir = await submodulePath(repoRoot, pin.path);
    if (!(await statIfPresent(join(subDir, '.git')))) {
      throw new Error(`Submodule is not initialized: ${pin.path}`);
    }

    let hasCommit = false;
    try {
      await runGit(subDir, ['cat-file', '-e', `${pin.commit}^{commit}`]);
      hasCommit = true;
    } catch (error) {
      if (!(error instanceof ControlledGitExitError)) throw error;
    }

    if (!hasCommit) {
      await assertEffectiveSubmoduleUrlAllowed(subDir, 'origin', allowlist, runGit);
      try {
        await runGit(subDir, [
          'fetch',
          '--no-recurse-submodules',
          '--depth',
          '1',
          'origin',
          pin.commit,
        ]);
      } catch (error) {
        if (!(error instanceof ControlledGitExitError)) throw error;
        await runGit(subDir, ['fetch', '--no-recurse-submodules', 'origin']);
      }
    }

    await runGit(subDir, ['checkout', '--detach', pin.commit]);
    await updateSubmoduleLevel(subDir, allowlist, runGit);
  }
  signal?.throwIfAborted();
}
