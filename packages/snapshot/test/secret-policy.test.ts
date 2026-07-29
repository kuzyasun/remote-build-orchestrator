import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SECRET_DENYLIST,
  findSecretPolicyViolations,
  isSecretBlocked,
} from '../src/secret-policy.js';

describe('secret-policy (§11.12)', () => {
  it('blocks default denylist paths in block mode', () => {
    expect(isSecretBlocked('.env', 'block')).toBe(true);
    expect(isSecretBlocked('.env.local', 'block')).toBe(true);
    expect(isSecretBlocked('certs/server.pem', 'block')).toBe(true);
    expect(isSecretBlocked('secrets.prod.json', 'block')).toBe(true);
    expect(isSecretBlocked('.aws/credentials', 'block')).toBe(true);
    expect(isSecretBlocked('.ssh/id_rsa', 'block')).toBe(true);
    expect(isSecretBlocked('id_rsa', 'block')).toBe(true);
    expect(isSecretBlocked('credentials.json', 'block')).toBe(true);
  });

  it('allows normal source files in block mode', () => {
    expect(isSecretBlocked('src/main.ts', 'block')).toBe(false);
    expect(isSecretBlocked('README.md', 'block')).toBe(false);
  });

  it('returns violations but does not block in warn mode', () => {
    const violations = findSecretPolicyViolations('.env', 'warn');
    expect(violations).toHaveLength(1);
    expect(isSecretBlocked('.env', 'warn')).toBe(false);
  });

  it('allows everything in allow mode', () => {
    expect(findSecretPolicyViolations('.env', 'allow')).toHaveLength(0);
    expect(isSecretBlocked('id_rsa', 'allow')).toBe(false);
  });

  it('exports the full default denylist from §11.12', () => {
    expect(DEFAULT_SECRET_DENYLIST).toEqual(
      expect.arrayContaining([
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
      ]),
    );
  });
});
