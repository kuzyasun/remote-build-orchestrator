import { PrepareSourceGitOverlayPayloadSchema } from '@rbo/protocol';
/**
 * Regression: prepare_source git_overlay carries fetch_refs for targeted fetch.
 */
import { describe, expect, it } from 'vitest';

describe('Phase 5 agent prepare fetch_refs', () => {
  it('accepts non-empty fetch_refs derived from branch', () => {
    const parsed = PrepareSourceGitOverlayPayloadSchema.parse({
      source_mode: 'git_overlay',
      attempt_id: 'att_1',
      lease_id: 'lease_1',
      lease_epoch: 1,
      repo: {
        url: 'git@github.com:kuzyasun/esp32-boilerplate.git',
        canonical_id: 'github.com/kuzyasun/esp32-boilerplate',
        branch: 'master',
        base_commit: 'abc123',
        fetch_refs: ['refs/heads/master'],
      },
      overlay: {
        download_url: 'https://example/overlay',
        data_token: 'tok',
        expected_size_bytes: 1,
        expected_sha256: 'deadbeef',
      },
    });
    expect(parsed.repo.fetch_refs).toEqual(['refs/heads/master']);
    expect(parsed.repo.fetch_refs.length > 0).toBe(true);
  });
});
