import { describe, expect, it } from 'vitest';
import {
  type GitUrlAllowlist,
  assertAllowedRepositoryUrl,
  isAllowedRepositoryUrl,
} from '../src/git-allowlist.js';

const allowlist: GitUrlAllowlist = {
  schemes: ['https', 'ssh'],
  hosts: ['github.com', 'gitlab.example.com'],
  repository_prefixes: ['kuzyasun/', 'org/'],
};

describe('Git URL allowlist (§10.4)', () => {
  it('accepts SSH and HTTPS forms of an allowed host/prefix', () => {
    expect(isAllowedRepositoryUrl('git@github.com:kuzyasun/esp32-boilerplate.git', allowlist)).toBe(
      true,
    );
    expect(
      isAllowedRepositoryUrl('https://github.com/kuzyasun/esp32-boilerplate.git', allowlist),
    ).toBe(true);
  });

  it('rejects file://, local paths, and external helpers', () => {
    expect(isAllowedRepositoryUrl('file:///C:/repos/app.git', allowlist)).toBe(false);
    expect(isAllowedRepositoryUrl('C:/repos/app.git', allowlist)).toBe(false);
    expect(isAllowedRepositoryUrl('/home/me/repos/app.git', allowlist)).toBe(false);
    expect(isAllowedRepositoryUrl('ext::sh -c evil', allowlist)).toBe(false);
  });

  it('rejects unknown hosts and prefix mismatches', () => {
    expect(isAllowedRepositoryUrl('git@evil.com:kuzyasun/esp32-boilerplate.git', allowlist)).toBe(
      false,
    );
    expect(isAllowedRepositoryUrl('https://github.com/other/repo.git', allowlist)).toBe(false);
  });

  it('throws a deterministic error via assertAllowedRepositoryUrl', () => {
    expect(() => assertAllowedRepositoryUrl('file:///tmp/x.git', allowlist)).toThrow(
      /not allowed|rejected/i,
    );
  });

  it('denies empty hosts; * unrestricted; scheme still enforced', () => {
    expect(
      isAllowedRepositoryUrl('git@github.com:kuzyasun/esp32-boilerplate.git', {
        schemes: ['https', 'ssh'],
        hosts: [],
      }),
    ).toBe(false);
    expect(
      isAllowedRepositoryUrl('git@evil.example:attacker/malware.git', {
        schemes: ['https', 'ssh'],
        hosts: ['*'],
      }),
    ).toBe(true);
    expect(
      isAllowedRepositoryUrl('file:///C:/repos/app.git', {
        schemes: ['https', 'ssh'],
        hosts: ['*'],
      }),
    ).toBe(false);
  });
});
