import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type GitUrlAllowlist, isAllowedRepositoryUrl } from '@rbo/shared';

const execFileAsync = promisify(execFile);

export interface GitStatusEntry {
  path: string;
  /** Present for renames/copies (porcelain v2 field 9). */
  origPath?: string;
  /** X/Y status from porcelain v2 (e.g. " M", "MM", "??"). */
  xy: string;
  kind: 'tracked' | 'untracked' | 'ignored';
  /** Porcelain v2 4-character submodule state (e.g. "S...", "N..."). */
  submodule?: string;
}

export interface GitRepositoryInfo {
  root: string;
  head: string;
  branch: string | null;
  remoteUrl: string | null;
}

export interface GitStatusSnapshot {
  head: string;
  branch: string | null;
  entries: GitStatusEntry[];
}

export interface FileIdentity {
  path: string;
  type: 'file' | 'symlink' | 'directory' | 'missing';
  size: number;
  mtimeMs: number;
  fileId: string | null;
}

async function runGit(
  cwd: string,
  args: string[],
  encoding: BufferEncoding | 'buffer' = 'utf8',
): Promise<{ stdout: string | Buffer; stderr: string }> {
  try {
    return (await execFileAsync('git', args, {
      cwd,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      encoding: encoding === 'buffer' ? undefined : encoding,
    })) as { stdout: string | Buffer; stderr: string };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const message = err.stderr?.trim() || err.message;
    throw new Error(`git ${args.join(' ')} failed: ${message}`);
  }
}

/** Parse `git status --porcelain=v2 -z --untracked-files=all` NUL-separated output. */
export function parsePorcelainV2(output: Buffer | string): GitStatusEntry[] {
  const buf = typeof output === 'string' ? Buffer.from(output, 'utf8') : output;
  const entries: GitStatusEntry[] = [];
  let offset = 0;

  while (offset < buf.length) {
    const end = buf.indexOf(0, offset);
    const lineEnd = end === -1 ? buf.length : end;
    const line = buf.subarray(offset, lineEnd).toString('utf8');
    offset = end === -1 ? buf.length : end + 1;
    if (!line) {
      continue;
    }

    const kind = line[0];
    if (kind === '?') {
      entries.push({ path: line.slice(2), xy: '??', kind: 'untracked' });
      continue;
    }
    if (kind === '!') {
      entries.push({ path: line.slice(2), xy: '!!', kind: 'ignored' });
      continue;
    }
    if (kind === '1' || kind === '2') {
      const fields = line.split(' ');
      const xy = fields[1] ?? '';
      const sub = fields[2];
      if (kind === '1') {
        const path = fields[fields.length - 1] ?? '';
        entries.push({ path, xy, kind: 'tracked', ...(sub ? { submodule: sub } : {}) });
      } else {
        // Rename/copy: `<line with path>` NUL `<origPath>` NUL
        const path = fields[fields.length - 1] ?? '';
        const origEnd = buf.indexOf(0, offset);
        const origPath = buf
          .subarray(offset, origEnd === -1 ? buf.length : origEnd)
          .toString('utf8');
        offset = origEnd === -1 ? buf.length : origEnd + 1;
        entries.push({ path, origPath, xy, kind: 'tracked', ...(sub ? { submodule: sub } : {}) });
      }
      continue;
    }
    if (kind === 'u') {
      const parts = line.split('\t');
      const path = parts[1] ?? '';
      entries.push({ path, xy: 'UU', kind: 'tracked' });
    }
  }

  return entries;
}

export async function gitRevParseHead(repoRoot: string): Promise<string> {
  const { stdout } = await runGit(repoRoot, ['rev-parse', 'HEAD']);
  return String(stdout).trim();
}

export async function gitSymbolicRefShort(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(repoRoot, ['symbolic-ref', '--short', 'HEAD']);
    return String(stdout).trim() || null;
  } catch {
    return null;
  }
}

export async function gitStatusPorcelainV2(repoRoot: string): Promise<GitStatusSnapshot> {
  const { stdout } = await runGit(
    repoRoot,
    ['status', '--porcelain=v2', '-z', '--untracked-files=all'],
    'buffer',
  );
  const head = await gitRevParseHead(repoRoot);
  const branch = await gitSymbolicRefShort(repoRoot);
  return {
    head,
    branch,
    entries: parsePorcelainV2(stdout as Buffer),
  };
}

export async function gitFindRoot(startPath: string): Promise<string> {
  const { stdout } = await runGit(startPath, ['rev-parse', '--show-toplevel']);
  return String(stdout).trim();
}

export async function gitRemoteOriginUrl(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(repoRoot, ['remote', 'get-url', 'origin']);
    return String(stdout).trim() || null;
  } catch {
    return null;
  }
}

export interface GitRemoteFetchUrl {
  name: string;
  url: string;
}

/** Unique `(name, fetch-url)` pairs from `git remote -v`. */
export async function gitListRemoteFetchUrls(repoRoot: string): Promise<GitRemoteFetchUrl[]> {
  const { stdout } = await runGit(repoRoot, ['remote', '-v']);
  const remotes: GitRemoteFetchUrl[] = [];
  const seen = new Set<string>();
  for (const line of String(stdout).split(/\r?\n/)) {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)\s*$/.exec(line.trim());
    if (!match) {
      continue;
    }
    const name = match[1] ?? '';
    const url = match[2] ?? '';
    const key = `${name}\0${url}`;
    if (!name || !url || seen.has(key)) {
      continue;
    }
    seen.add(key);
    remotes.push({ name, url });
  }
  return remotes;
}

function orderRemotesPreferOrigin(remotes: GitRemoteFetchUrl[]): GitRemoteFetchUrl[] {
  return [
    ...remotes.filter((remote) => remote.name === 'origin'),
    ...remotes.filter((remote) => remote.name !== 'origin'),
  ];
}

/**
 * Prefer `origin` when present; otherwise the first configured fetch remote.
 * Used for manifests when no allowlist is in play.
 */
export async function resolveRepositoryRemoteUrl(repoRoot: string): Promise<string | null> {
  const remotes = orderRemotesPreferOrigin(await gitListRemoteFetchUrls(repoRoot));
  return remotes[0]?.url ?? null;
}

/**
 * Prefer allowlisted `origin`, else any other allowlisted fetch remote.
 * Controllers must use this for overlay eligibility instead of origin-only lookup.
 */
export async function resolveAllowlistedRemoteUrl(
  repoRoot: string,
  allowlist: GitUrlAllowlist,
): Promise<string | null> {
  for (const remote of orderRemotesPreferOrigin(await gitListRemoteFetchUrls(repoRoot))) {
    if (isAllowedRepositoryUrl(remote.url, allowlist)) {
      return remote.url;
    }
  }
  return null;
}

export async function describeRepository(repoRoot: string): Promise<GitRepositoryInfo> {
  const [head, branch, remoteUrl] = await Promise.all([
    gitRevParseHead(repoRoot),
    gitSymbolicRefShort(repoRoot),
    resolveRepositoryRemoteUrl(repoRoot),
  ]);
  return { root: repoRoot, head, branch, remoteUrl };
}

export async function gitLsFilesZ(repoRoot: string): Promise<string[]> {
  const { stdout } = await runGit(repoRoot, ['ls-files', '-z'], 'buffer');
  return parseNulSeparatedPaths(stdout as Buffer);
}

export async function gitLsFilesStageModes(repoRoot: string): Promise<Map<string, string>> {
  const { stdout } = await runGit(repoRoot, ['ls-files', '-s', '-z'], 'buffer');
  const modes = new Map<string, string>();
  const buf = stdout as Buffer;
  let offset = 0;
  while (offset < buf.length) {
    const end = buf.indexOf(0, offset);
    const lineEnd = end === -1 ? buf.length : end;
    const line = buf.subarray(offset, lineEnd).toString('utf8');
    offset = end === -1 ? buf.length : end + 1;
    if (!line) {
      continue;
    }
    const parts = line.split(/\s+/);
    const mode = parts[0];
    const path = parts.slice(3).join(' ');
    if (mode && path) {
      modes.set(path, mode);
    }
  }
  return modes;
}

function parseNulSeparatedPaths(buf: Buffer): string[] {
  const paths: string[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const end = buf.indexOf(0, offset);
    const lineEnd = end === -1 ? buf.length : end;
    const path = buf.subarray(offset, lineEnd).toString('utf8');
    offset = end === -1 ? buf.length : end + 1;
    if (path) {
      paths.push(path);
    }
  }
  return paths;
}

export async function gitLsFilesOthersExcludeStandard(repoRoot: string): Promise<string[]> {
  const { stdout } = await runGit(
    repoRoot,
    ['ls-files', '--others', '--exclude-standard', '-z'],
    'buffer',
  );
  return parseNulSeparatedPaths(stdout as Buffer);
}

export async function gitLsFilesOthersIgnored(
  repoRoot: string,
  paths: string[],
): Promise<string[]> {
  if (paths.length === 0) {
    return [];
  }
  const { stdout } = await runGit(
    repoRoot,
    ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...paths],
    'buffer',
  );
  return parseNulSeparatedPaths(stdout as Buffer);
}

export function normalizeWirePath(pathStr: string): string {
  return pathStr.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function resolveInside(root: string, relativePath: string): string {
  return join(root, relativePath);
}
