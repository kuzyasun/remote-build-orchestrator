import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitFixtureFileSpec {
  path: string;
  content?: string;
  mode?: '100644' | '100755' | '120000';
  /** Required when mode is 120000 — stored as git index symlink target text. */
  symlinkTarget?: string;
}

export interface GitFixtureRepoSpec {
  committed?: GitFixtureFileSpec[];
  staged?: GitFixtureFileSpec[];
  /** Modifications to committed files left unstaged in the worktree. */
  unstaged?: GitFixtureFileSpec[];
  untracked?: GitFixtureFileSpec[];
  /** Paths removed from the index (staged deletion). */
  deleted?: string[];
  /** Files written and listed in .gitignore (not tracked). */
  ignored?: GitFixtureFileSpec[];
  gitConfig?: Record<string, string>;
}

export interface GitFixtureRepo {
  root: string;
  cleanup: () => Promise<void>;
}

export interface GitStateSnapshot {
  head: string;
  branch: string | null;
  statusPorcelain: string;
  indexTree: string;
}

async function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync('git', args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
    });
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const message = err.stderr?.trim() || err.message;
    throw new Error(`git ${args.join(' ')} failed: ${message}`);
  }
}

async function writeIndexSymlink(repoRoot: string, file: GitFixtureFileSpec): Promise<void> {
  const target = file.symlinkTarget ?? file.content ?? '';
  const blobPath = join(repoRoot, `.rbo-symlink-blob-${Date.now()}`);
  await writeFile(blobPath, target, 'utf8');
  const { stdout: objectSha } = await runGit(repoRoot, ['hash-object', '-w', blobPath]);
  await rm(blobPath, { force: true });
  await runGit(repoRoot, [
    'update-index',
    '--add',
    '--cacheinfo',
    `120000,${objectSha.trim()},${file.path}`,
  ]);
}

async function writeFixtureFile(repoRoot: string, file: GitFixtureFileSpec): Promise<void> {
  const absolute = join(repoRoot, file.path);
  await mkdir(dirname(absolute), { recursive: true });

  if (file.mode === '120000') {
    await writeIndexSymlink(repoRoot, file);
    return;
  }

  await writeFile(absolute, file.content ?? '', 'utf8');
  if (file.mode === '100755') {
    await chmod(absolute, 0o755);
  }
  await runGit(repoRoot, ['add', '--', file.path]);
  if (file.mode === '100755') {
    await runGit(repoRoot, ['update-index', '--chmod=+x', '--', file.path]);
  }
}

/** Canonical git fixture harness (§0.2 invariant checks, Phase 3+). */
export async function createGitFixtureRepo(spec: GitFixtureRepoSpec = {}): Promise<GitFixtureRepo> {
  const root = await mkdtemp(join(tmpdir(), 'rbo-git-fixture-'));
  await runGit(root, ['init']);
  await runGit(root, ['config', 'user.email', 'test@example.com']);
  await runGit(root, ['config', 'user.name', 'Test User']);
  await runGit(root, ['config', 'core.autocrlf', 'false']);

  for (const [key, value] of Object.entries(spec.gitConfig ?? {})) {
    await runGit(root, ['config', key, value]);
  }

  for (const file of spec.committed ?? []) {
    const absolute = join(root, file.path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, file.content ?? '', 'utf8');
    if (file.mode === '100755') {
      await chmod(absolute, 0o755);
    }
    await runGit(root, ['add', '--', file.path]);
    if (file.mode === '100755') {
      await runGit(root, ['update-index', '--chmod=+x', '--', file.path]);
    }
  }
  if ((spec.committed ?? []).length > 0) {
    await runGit(root, ['commit', '-m', 'fixture-commit']);
  }

  for (const file of spec.staged ?? []) {
    if (file.mode === '120000') {
      await writeFixtureFile(root, file);
    } else {
      const absolute = join(root, file.path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, file.content ?? '', 'utf8');
      if (file.mode === '100755') {
        await chmod(absolute, 0o755);
      }
      await runGit(root, ['add', '--', file.path]);
      if (file.mode === '100755') {
        await runGit(root, ['update-index', '--chmod=+x', '--', file.path]);
      }
    }
  }

  for (const file of spec.unstaged ?? []) {
    const absolute = join(root, file.path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, file.content ?? '', 'utf8');
    if (file.mode === '100755') {
      await chmod(absolute, 0o755);
    }
  }

  for (const file of spec.untracked ?? []) {
    const absolute = join(root, file.path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, file.content ?? '', 'utf8');
    if (file.mode === '100755') {
      await chmod(absolute, 0o755);
    }
  }

  for (const path of spec.deleted ?? []) {
    await runGit(root, ['rm', '--', path]);
  }

  const ignoredFiles = spec.ignored ?? [];
  if (ignoredFiles.length > 0) {
    const ignoreLines = ignoredFiles.map((f) => f.path).join('\n');
    await writeFile(join(root, '.gitignore'), `${ignoreLines}\n`, 'utf8');
    for (const file of ignoredFiles) {
      const absolute = join(root, file.path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, file.content ?? '', 'utf8');
    }
  }

  return {
    root,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Capture git state for §0.2 invariant comparison. */
export async function captureGitState(repoRoot: string): Promise<GitStateSnapshot> {
  // Run sequentially: concurrent git commands on the same repo contend for
  // .git/index.lock (especially on Windows).
  const { stdout: head } = await runGit(repoRoot, ['rev-parse', 'HEAD']);
  const { stdout: branchRaw } = await runGit(repoRoot, ['symbolic-ref', '--short', 'HEAD']).catch(
    () => ({ stdout: '', stderr: '' }),
  );
  const { stdout: status } = await runGit(repoRoot, [
    'status',
    '--porcelain=v2',
    '-z',
    '--untracked-files=all',
  ]);
  const { stdout: indexTree } = await runGit(repoRoot, ['write-tree']);

  const branch = branchRaw.trim() || null;
  return {
    head: head.trim(),
    branch,
    statusPorcelain: status,
    indexTree: indexTree.trim(),
  };
}

function formatGitStateDiff(before: GitStateSnapshot, after: GitStateSnapshot): string {
  const lines: string[] = ['Git state changed after operation (§0.2 invariant violated):'];
  if (before.head !== after.head) {
    lines.push(`  HEAD: ${before.head} → ${after.head}`);
  }
  if (before.branch !== after.branch) {
    lines.push(`  branch: ${before.branch ?? '(detached)'} → ${after.branch ?? '(detached)'}`);
  }
  if (before.indexTree !== after.indexTree) {
    lines.push(`  indexTree: ${before.indexTree} → ${after.indexTree}`);
  }
  if (before.statusPorcelain !== after.statusPorcelain) {
    lines.push('  statusPorcelain changed');
    lines.push(`    before: ${JSON.stringify(before.statusPorcelain)}`);
    lines.push(`    after:  ${JSON.stringify(after.statusPorcelain)}`);
  }
  return lines.join('\n');
}

/** Throws with a clear diff when §0.2 git invariants are violated. */
export function assertGitStateUnchanged(before: GitStateSnapshot, after: GitStateSnapshot): void {
  if (
    before.head === after.head &&
    before.branch === after.branch &&
    before.indexTree === after.indexTree &&
    before.statusPorcelain === after.statusPorcelain
  ) {
    return;
  }
  throw new Error(formatGitStateDiff(before, after));
}
