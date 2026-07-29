import { PrepareSourceGitOverlayPayloadSchema } from '@rbo/protocol';
import { isAllowedRepositoryUrl } from '@rbo/shared';
/**
 * Round-2: prior P0/P1 fixes remain green.
 */
import { describe, expect, it } from 'vitest';

describe('REVIEW R2: prior fixes still hold', () => {
  it('default-style host allowlist accepts github SSH URLs', () => {
    expect(
      isAllowedRepositoryUrl('git@github.com:kuzyasun/esp32-boilerplate.git', {
        schemes: ['https', 'ssh'],
        hosts: ['github.com'],
      }),
    ).toBe(true);
  });

  it('prepare_source accepts fetch_refs for targeted fetch', () => {
    const parsed = PrepareSourceGitOverlayPayloadSchema.parse({
      source_mode: 'git_overlay',
      attempt_id: 'att_1',
      lease_id: 'lease_1',
      lease_epoch: 1,
      repo: {
        url: 'git@github.com:kuzyasun/esp32-boilerplate.git',
        canonical_id: 'github.com/kuzyasun/esp32-boilerplate',
        branch: 'master',
        base_commit: 'abc',
        fetch_refs: ['refs/heads/master'],
      },
      overlay: {
        download_url: 'https://example/o',
        data_token: 't',
        expected_size_bytes: 1,
        expected_sha256: 'ab',
      },
    });
    expect(parsed.repo.fetch_refs.length).toBeGreaterThan(0);
  });
});
