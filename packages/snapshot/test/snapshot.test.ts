import { describe, expect, it } from 'vitest';
import { SnapshotInstanceSchema, SnapshotManifestSchema } from '../src/index.js';

const GIT_OVERLAY_MANIFEST = {
  schema_version: 1,
  content_id: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  repo: {
    canonical_id: 'github.com/kuzyasun/esp32-boilerplate',
    url: 'git@github.com:kuzyasun/esp32-boilerplate.git',
    branch: 'master',
    base_commit: '54ec0b915decc6bab3efc94cb7184d3f44e16736',
    head_is_pushed: false,
  },
  workspace: {
    main_mount: 'project',
    cwd: 'project',
  },
  overlay: {
    files: [
      {
        path: 'main/app_main.c',
        type: 'file',
        mode: '100644',
        size: 12890,
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      },
      {
        path: 'scripts/run_qemu.sh',
        type: 'file',
        mode: '100755',
        size: 1024,
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      },
      {
        path: 'config/link-to-shared',
        type: 'symlink',
        mode: '120000',
        target: '../shared',
      },
    ],
    deletions: ['main/obsolete.c'],
    empty_directories: ['build/empty'],
  },
  additional_roots: [
    {
      id: 'dtracker-shared',
      mount: 'additional/dtracker-shared',
      file_count: 42,
      total_size: 123456,
      tree_sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    },
  ],
  payload: {
    mode: 'git_overlay',
    format: 'tar',
    compression: 'zstd',
    sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    size: 345678,
  },
};

const FULL_MANIFEST = {
  schema_version: 1,
  content_id: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  workspace: {
    main_mount: 'project',
    cwd: 'project',
  },
  source: {
    files: [
      {
        path: 'main/app_main.c',
        type: 'file',
        mode: '100644',
        size: 12890,
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      },
    ],
    empty_directories: [],
  },
  additional_roots: [],
  payload: {
    mode: 'full',
    format: 'tar',
    compression: 'zstd',
    sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    size: 345678,
  },
};

describe('Snapshot Manifest (Sections 11.4 and 12.1)', () => {
  it('should validate a git_overlay manifest matching §11.4', () => {
    const parsed = SnapshotManifestSchema.parse(GIT_OVERLAY_MANIFEST);
    if (parsed.payload.mode !== 'git_overlay') {
      throw new Error('expected git_overlay branch');
    }
    expect(parsed.repo.base_commit).toBe('54ec0b915decc6bab3efc94cb7184d3f44e16736');
    expect(parsed.overlay.files).toHaveLength(3);
    expect(parsed.overlay.deletions).toContain('main/obsolete.c');
    expect(parsed.overlay.empty_directories).toContain('build/empty');
    expect(parsed.additional_roots[0]?.mount).toBe('additional/dtracker-shared');
  });

  it('should validate a full manifest with source.files and no repo/overlay (§12.1)', () => {
    const parsed = SnapshotManifestSchema.parse(FULL_MANIFEST);
    if (parsed.payload.mode !== 'full') {
      throw new Error('expected full branch');
    }
    expect(parsed.source.files).toHaveLength(1);
  });

  it('should reject a git_overlay manifest without repo.base_commit', () => {
    const { repo, ...rest } = GIT_OVERLAY_MANIFEST;
    expect(() =>
      SnapshotManifestSchema.parse({
        ...rest,
        repo: { ...repo, base_commit: null },
      }),
    ).toThrow();
  });

  it('should reject a full manifest that carries an overlay block', () => {
    expect(() =>
      SnapshotManifestSchema.parse({
        ...FULL_MANIFEST,
        overlay: GIT_OVERLAY_MANIFEST.overlay,
      }),
    ).toThrow();
  });

  it('should reject a git_overlay manifest without overlay files/deletions', () => {
    const { overlay, ...rest } = GIT_OVERLAY_MANIFEST;
    expect(() => SnapshotManifestSchema.parse(rest)).toThrow();
  });

  it('should use Git mode strings, rejecting numeric modes (§11.7)', () => {
    expect(() =>
      SnapshotManifestSchema.parse({
        ...GIT_OVERLAY_MANIFEST,
        overlay: {
          ...GIT_OVERLAY_MANIFEST.overlay,
          files: [
            {
              path: 'main/app_main.c',
              type: 'file',
              mode: 0o644,
              size: 12890,
              sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            },
          ],
        },
      }),
    ).toThrow();
  });

  it('should keep runtime metadata out of the canonical manifest (§11.16)', () => {
    // snapshot_id / captured_at belong to the snapshot instance, not the content manifest.
    expect(Object.keys(SnapshotManifestSchema.parse(GIT_OVERLAY_MANIFEST))).not.toContain(
      'snapshot_id',
    );

    const instance = SnapshotInstanceSchema.parse({
      snapshot_id: 'snp_01J1234567890ABCDEFGHJKMNP',
      content_id: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      captured_at: new Date().toISOString(),
    });
    expect(instance.snapshot_id).toBe('snp_01J1234567890ABCDEFGHJKMNP');
  });

  it('should reject main_mount / additional mount paths that escape the workspace', () => {
    expect(() =>
      SnapshotManifestSchema.parse({
        ...FULL_MANIFEST,
        workspace: { main_mount: '../../outside', cwd: 'project' },
      }),
    ).toThrow();
    expect(() =>
      SnapshotManifestSchema.parse({
        ...GIT_OVERLAY_MANIFEST,
        additional_roots: [
          {
            ...GIT_OVERLAY_MANIFEST.additional_roots[0],
            mount: '../escape',
          },
        ],
      }),
    ).toThrow();
  });
});
