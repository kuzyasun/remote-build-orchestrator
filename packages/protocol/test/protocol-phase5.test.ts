import { describe, expect, it } from 'vitest';
import {
  BundleDownloadPayloadSchema,
  PrepareSourcePayloadSchema,
  SourceNeedPayloadSchema,
  SourceNeedReasonSchema,
} from '../src/messages.js';

describe('Phase 5 Protocol Schemas', () => {
  it('enumerates exact source_need reasons', () => {
    expect(SourceNeedReasonSchema.options).toEqual([
      'base_present',
      'base_commit_missing',
      'bundle_required',
      'full_snapshot_required',
      'repo_fetch_failed',
    ]);
  });

  it('validates source_need with typed reason', () => {
    const valid = SourceNeedPayloadSchema.safeParse({
      attempt_id: 'att_1',
      lease_id: 'lease_1',
      lease_epoch: 1,
      reason: 'base_commit_missing',
    });
    expect(valid.success).toBe(true);

    const bad = SourceNeedPayloadSchema.safeParse({
      attempt_id: 'att_1',
      lease_id: 'lease_1',
      lease_epoch: 1,
      reason: 'please_fetch_somehow',
    });
    expect(bad.success).toBe(false);
  });

  it('validates prepare_source full mode without changing Phase 4 fields', () => {
    const valid = PrepareSourcePayloadSchema.safeParse({
      source_mode: 'full',
      attempt_id: 'att_1',
      lease_id: 'lease_1',
      lease_epoch: 1,
      download_url: 'https://127.0.0.1:7411/data/v1/attempts/att_1/snapshot',
      data_token: 'tok',
      expected_size_bytes: 10,
      expected_sha256: 'abc',
    });
    expect(valid.success).toBe(true);
  });

  it('validates prepare_source git_overlay with repo + overlay transfer', () => {
    const valid = PrepareSourcePayloadSchema.safeParse({
      source_mode: 'git_overlay',
      attempt_id: 'att_1',
      lease_id: 'lease_1',
      lease_epoch: 1,
      repo: {
        url: 'git@github.com:kuzyasun/esp32-boilerplate.git',
        canonical_id: 'github.com/kuzyasun/esp32-boilerplate',
        branch: 'master',
        base_commit: '54ec0b915decc6bab3efc94cb7184d3f44e16736',
        fetch_refs: ['refs/heads/master'],
      },
      overlay: {
        download_url: 'https://127.0.0.1:7411/data/v1/attempts/att_1/overlay',
        data_token: 'tok',
        expected_size_bytes: 2048,
        expected_sha256: 'deadbeef',
      },
    });
    expect(valid.success).toBe(true);

    const missingRepo = PrepareSourcePayloadSchema.safeParse({
      source_mode: 'git_overlay',
      attempt_id: 'att_1',
      lease_id: 'lease_1',
      lease_epoch: 1,
      overlay: {
        download_url: 'https://127.0.0.1:7411/data/v1/attempts/att_1/overlay',
        data_token: 'tok',
        expected_size_bytes: 2048,
        expected_sha256: 'deadbeef',
      },
    });
    expect(missingRepo.success).toBe(false);
  });

  it('rejects prepare_source without source_mode', () => {
    const parsed = PrepareSourcePayloadSchema.safeParse({
      attempt_id: 'att_1',
      lease_id: 'lease_1',
      lease_epoch: 1,
      download_url: 'https://example/snapshot',
      data_token: 'tok',
      expected_size_bytes: 1,
      expected_sha256: 'x',
    });
    expect(parsed.success).toBe(false);
  });

  it('validates bundle_download transfer descriptor', () => {
    const valid = BundleDownloadPayloadSchema.safeParse({
      attempt_id: 'att_1',
      lease_id: 'lease_1',
      lease_epoch: 1,
      download_url: 'https://127.0.0.1:7411/data/v1/attempts/att_1/bundle',
      data_token: 'tok',
      expected_size_bytes: 4096,
      expected_sha256: 'cafe',
    });
    expect(valid.success).toBe(true);
  });
});
