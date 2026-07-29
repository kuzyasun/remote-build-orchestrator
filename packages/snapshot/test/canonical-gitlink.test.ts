import { describe, expect, it } from 'vitest';
import { attachContentId } from '../src/canonical.js';
import type { GitOverlaySnapshotManifest } from '../src/index.js';

describe('canonical content_id with gitlinks', () => {
  const baseManifest: Omit<GitOverlaySnapshotManifest, 'content_id'> = {
    schema_version: 1,
    repo: {
      canonical_id: 'test-repo',
      url: 'https://github.com/example/test-repo.git',
      branch: 'main',
      base_commit: '1'.repeat(40),
      head_is_pushed: true,
    },
    workspace: {
      main_mount: '.',
      cwd: '.',
    },
    overlay: {
      files: [
        {
          path: 'vendor/submodule',
          type: 'gitlink',
          mode: '160000',
          commit: 'a'.repeat(40),
        },
      ],
      deletions: [],
      empty_directories: [],
    },
    additional_roots: [],
    payload: {
      mode: 'git_overlay',
      format: 'tar',
      compression: 'zstd',
      sha256: 'c'.repeat(64),
      size: 100,
    },
  };

  it('generates content_id for git_overlay manifest with gitlink', () => {
    const manifest = attachContentId(baseManifest);
    expect(manifest.content_id).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('produces different content_id when gitlink commit changes', () => {
    const manifest1 = attachContentId(baseManifest);

    const modifiedManifest: Omit<GitOverlaySnapshotManifest, 'content_id'> = {
      ...baseManifest,
      overlay: {
        ...baseManifest.overlay,
        files: [
          {
            path: 'vendor/submodule',
            type: 'gitlink',
            mode: '160000',
            commit: 'b'.repeat(40),
          },
        ],
      },
    };
    const manifest2 = attachContentId(modifiedManifest);

    expect(manifest1.content_id).not.toEqual(manifest2.content_id);
  });
});
