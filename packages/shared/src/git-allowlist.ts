import { normalizeRepositoryUrl } from './paths.js';

/**
 * Configured Git remote allowlist (§10.4).
 * Both Controller and Agent enforce the same rules before clone/fetch/bundle.
 */
export interface GitUrlAllowlist {
  /** Allowed URL schemes, e.g. `https`, `ssh`. Never includes `file`. */
  schemes: readonly string[];
  /**
   * Allowed hosts (case-insensitive), e.g. `github.com`.
   * Empty denies all hosts. Use a single `*` entry for unrestricted hosts.
   */
  hosts: readonly string[];
  /**
   * Optional repository path prefixes under the host (case-sensitive path).
   * Example: `kuzyasun/` matches `github.com/kuzyasun/esp32-boilerplate`.
   * When omitted or empty, any path under an allowed host is accepted.
   */
  repository_prefixes?: readonly string[];
}

export type GitUrlRejectReason =
  | 'empty'
  | 'file_scheme'
  | 'local_path'
  | 'external_helper'
  | 'unsupported_scheme'
  | 'unknown_host'
  | 'prefix_mismatch'
  | 'unparseable';

export interface GitUrlAllowlistResult {
  ok: boolean;
  reason?: GitUrlRejectReason;
  canonical_id?: string;
  scheme?: string;
  host?: string;
  path?: string;
}

const EXTERNAL_HELPER = /^[A-Za-z][A-Za-z0-9+.-]*::/;

function detectScheme(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^file:/i.test(trimmed)) {
    return 'file';
  }
  if (/^https:\/\//i.test(trimmed)) {
    return 'https';
  }
  if (/^http:\/\//i.test(trimmed)) {
    return 'http';
  }
  if (/^ssh:\/\//i.test(trimmed)) {
    return 'ssh';
  }
  if (/^git:\/\//i.test(trimmed)) {
    return 'git';
  }
  // scp-like git@host:path
  if (/^[^@/\s]+@[^:/\s]+:/.test(trimmed)) {
    return 'ssh';
  }
  return null;
}

function looksLikeLocalPath(raw: string): boolean {
  const trimmed = raw.trim();
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
    return true;
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) {
    return true;
  }
  if (trimmed.startsWith('./') || trimmed.startsWith('.\\') || trimmed.startsWith('../')) {
    return true;
  }
  return false;
}

/**
 * Validate a repository URL against the allowlist.
 * Does not perform network I/O. Reuses {@link normalizeRepositoryUrl} for identity.
 */
export function evaluateRepositoryUrl(
  rawUrl: string,
  allowlist: GitUrlAllowlist,
): GitUrlAllowlistResult {
  const trimmed = rawUrl?.trim() ?? '';
  if (!trimmed) {
    return { ok: false, reason: 'empty' };
  }
  if (EXTERNAL_HELPER.test(trimmed)) {
    return { ok: false, reason: 'external_helper' };
  }
  if (/^file:/i.test(trimmed)) {
    return { ok: false, reason: 'file_scheme' };
  }
  if (looksLikeLocalPath(trimmed)) {
    return { ok: false, reason: 'local_path' };
  }

  const scheme = detectScheme(trimmed);
  if (!scheme) {
    return { ok: false, reason: 'unparseable' };
  }

  const allowedSchemes = new Set(allowlist.schemes.map((s) => s.toLowerCase()));
  if (!allowedSchemes.has(scheme.toLowerCase())) {
    return { ok: false, reason: 'unsupported_scheme', scheme };
  }

  let canonical: string;
  try {
    canonical = normalizeRepositoryUrl(trimmed);
  } catch {
    return { ok: false, reason: 'unparseable', scheme };
  }

  const slash = canonical.indexOf('/');
  const host = (slash === -1 ? canonical : canonical.slice(0, slash)).toLowerCase();
  const path = slash === -1 ? '' : canonical.slice(slash + 1);

  const allowedHosts = new Set(allowlist.hosts.map((h) => h.toLowerCase()));
  // Empty hosts denies all remotes. Explicit `*` means unrestricted hosts.
  const hostsUnrestricted = allowedHosts.has('*');
  if (!hostsUnrestricted && (allowedHosts.size === 0 || !allowedHosts.has(host))) {
    return { ok: false, reason: 'unknown_host', scheme, host, path };
  }

  const prefixes = allowlist.repository_prefixes ?? [];
  if (prefixes.length > 0) {
    const matched = prefixes.some((prefix) => path === prefix || path.startsWith(prefix));
    if (!matched) {
      return { ok: false, reason: 'prefix_mismatch', scheme, host, path, canonical_id: canonical };
    }
  }

  return { ok: true, scheme, host, path, canonical_id: canonical };
}

export function isAllowedRepositoryUrl(rawUrl: string, allowlist: GitUrlAllowlist): boolean {
  return evaluateRepositoryUrl(rawUrl, allowlist).ok;
}

export function assertAllowedRepositoryUrl(rawUrl: string, allowlist: GitUrlAllowlist): string {
  const result = evaluateRepositoryUrl(rawUrl, allowlist);
  if (!result.ok || !result.canonical_id) {
    throw new Error(
      `Repository URL rejected (${result.reason ?? 'unknown'}): not allowed by Git allowlist`,
    );
  }
  return result.canonical_id;
}
