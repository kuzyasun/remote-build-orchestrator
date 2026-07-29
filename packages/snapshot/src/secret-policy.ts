export type SecretPolicyMode = 'block' | 'warn' | 'allow';

/** Default secret denylist patterns from §11.12 (relative POSIX paths). */
export const DEFAULT_SECRET_DENYLIST: readonly string[] = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'id_rsa',
  'id_ed25519',
  'credentials.json',
  'secrets.*',
  '.aws/',
  '.ssh/',
];

export interface SecretPolicyViolation {
  path: string;
  pattern: string;
}

function normalizeSecretPath(pathStr: string): string {
  return pathStr.replace(/\\/g, '/').replace(/^\.\//, '');
}

function matchPattern(pathStr: string, pattern: string): boolean {
  const path = normalizeSecretPath(pathStr);
  const pat = pattern.replace(/\\/g, '/');

  if (pat.endsWith('/')) {
    return path === pat.slice(0, -1) || path.startsWith(pat) || path.includes(`/${pat}`);
  }

  if (pat.startsWith('*.')) {
    const suffix = pat.slice(1);
    const base = path.split('/').pop() ?? path;
    return base.endsWith(suffix) || base === pat.slice(2);
  }

  if (pat.includes('*')) {
    const regex = new RegExp(
      `^${pat
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')}$`,
    );
    const base = path.split('/').pop() ?? path;
    return regex.test(path) || regex.test(base);
  }

  if (pat.endsWith('.*')) {
    const prefix = pat.slice(0, -2);
    const base = path.split('/').pop() ?? path;
    return base === prefix || base.startsWith(`${prefix}.`);
  }

  return path === pat || path.endsWith(`/${pat}`) || path.split('/').pop() === pat;
}

export function findSecretPolicyViolations(
  pathStr: string,
  mode: SecretPolicyMode,
  denylist: readonly string[] = DEFAULT_SECRET_DENYLIST,
): SecretPolicyViolation[] {
  if (mode === 'allow') {
    return [];
  }
  const violations: SecretPolicyViolation[] = [];
  for (const pattern of denylist) {
    if (matchPattern(pathStr, pattern)) {
      violations.push({ path: normalizeSecretPath(pathStr), pattern });
    }
  }
  return violations;
}

export function isSecretBlocked(
  pathStr: string,
  mode: SecretPolicyMode,
  denylist: readonly string[] = DEFAULT_SECRET_DENYLIST,
): boolean {
  return mode === 'block' && findSecretPolicyViolations(pathStr, mode, denylist).length > 0;
}
