import { realpath as fsRealpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { sha256 } from './hashing.js';

export function normalizePath(pathStr: string): string {
  const normalized = pathStr.replace(/\\/g, '/');
  if (normalized.length > 1 && normalized.endsWith('/')) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

/**
 * Safe relative path for job cwd / additional_roots.mount_path (§28.2).
 * Rejects absolute, drive-letter, UNC (`//` / `\\`), empty segments, and `..`.
 * When `allowDot` is true, `.` is accepted (cwd default).
 */
export function isSafeRelativePath(value: string, options?: { allowDot?: boolean }): boolean {
  const normalized = value.replace(/\\/g, '/');
  if (normalized === '' || normalized === '.') {
    return options?.allowDot === true;
  }
  if (
    normalized.startsWith('/') ||
    normalized.startsWith('//') ||
    normalized.startsWith('\\\\') ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.includes('://')
  ) {
    return false;
  }
  const parts = normalized.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    return false;
  }
  return true;
}

/** Resolve symlinks/junctions and verify `childPath` stays inside `parentPath` (§29, Phase 3). */
export async function assertRealPathContained(
  parentPath: string,
  childPath: string,
): Promise<void> {
  const [realParent, realChild] = await Promise.all([
    fsRealpath(parentPath),
    fsRealpath(childPath),
  ]);
  if (!isPathContained(realParent, realChild)) {
    throw new Error(`Path escapes allowed root: ${childPath}`);
  }
}

export async function resolveRealPath(pathStr: string): Promise<string> {
  return fsRealpath(pathStr);
}

// Lexical containment only — prefer assertRealPathContained for security checks.
export function isPathContained(parentPath: string, childPath: string): boolean {
  const resolvedParent = resolve(parentPath);
  const resolvedChild = resolve(childPath);
  const rel = relative(resolvedParent, resolvedChild);
  return !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Resolve a job `source.cwd` under `projectPath` with lexical + realpath containment.
 * Rejects absolute paths and `..` even before the directory exists.
 */
export async function resolveContainedCwd(
  projectPath: string,
  cwd: string | undefined,
): Promise<string> {
  const raw = !cwd || cwd === '.' ? '' : cwd.replace(/\\/g, '/');
  if (!raw) {
    return resolveRealPath(projectPath);
  }
  if (!isSafeRelativePath(raw)) {
    throw new Error(`cwd escapes project root: ${cwd}`);
  }
  const joined = resolve(projectPath, raw);
  if (!isPathContained(projectPath, joined)) {
    throw new Error(`cwd escapes project root: ${cwd}`);
  }
  const { access, mkdir } = await import('node:fs/promises');
  try {
    await access(joined);
  } catch {
    await mkdir(joined, { recursive: true });
  }
  await assertRealPathContained(projectPath, joined);
  return resolveRealPath(joined);
}

export function normalizeRepositoryUrl(rawUrl: string): string {
  let url = rawUrl.trim().replace(/\/+$/, '');
  if (url.toLowerCase().endsWith('.git')) {
    url = url.slice(0, -4);
  }

  const hadScheme = /^(https?|ssh|git):\/\//i.test(url);
  url = url.replace(/^(https?|ssh|git):\/\//i, '').replace(/^[^@/]+@/, '');

  // scp-like syntax (git@host:path) uses ':' as the host/path separator;
  // URL forms use ':' only for an explicit port.
  let host: string;
  let path: string;
  const scp = hadScheme ? null : url.match(/^([^:/]+):(.+)$/);
  if (scp) {
    host = scp[1] as string;
    path = scp[2] as string;
  } else {
    const slash = url.indexOf('/');
    host = slash === -1 ? url : url.slice(0, slash);
    path = slash === -1 ? '' : url.slice(slash + 1);
  }

  // Only the host is case-insensitive; repository paths may be case-sensitive.
  host = host.replace(/:\d+$/, '').toLowerCase();
  path = normalizePath(path).replace(/^\/+/, '');
  return path ? `${host}/${path}` : host;
}

export function computeRepoKey(rawUrl: string): string {
  const canonical = normalizeRepositoryUrl(rawUrl);
  return sha256(canonical);
}
