import { isAbsolute, relative, resolve } from 'node:path';
import { sha256 } from './hashing.js';

export function normalizePath(pathStr: string): string {
  const normalized = pathStr.replace(/\\/g, '/');
  if (normalized.length > 1 && normalized.endsWith('/')) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

// TODO(Phase 3): compare real paths (fs.realpath) — lexical containment does not
// detect symlink/junction/reparse-point escapes required by §29 and Phase 3.
export function isPathContained(parentPath: string, childPath: string): boolean {
  const resolvedParent = resolve(parentPath);
  const resolvedChild = resolve(childPath);
  const rel = relative(resolvedParent, resolvedChild);
  return !rel.startsWith('..') && !isAbsolute(rel);
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
