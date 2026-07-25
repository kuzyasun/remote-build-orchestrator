import { describe, expect, it } from 'vitest';
import { listGitlinkPins } from '../src/materialize.js';

describe('materialize gitlink pin helpers', () => {
  it('extracts gitlink pins from manifest in order', () => {
    const manifest = {
      schema_version: 1,
      content_id: `sha256:${'a'.repeat(64)}`,
      repo: {
        canonical_id: 'test',
        url: 'https://github.com/example/test.git',
        branch: 'main',
        base_commit: '1'.repeat(40),
        head_is_pushed: false,
      },
      workspace: { main_mount: 'project', cwd: '.' },
      overlay: {
        files: [
          { path: 'vendor/a', type: 'gitlink', mode: '160000', commit: '2'.repeat(40) },
          { path: 'src/main.ts', type: 'file', mode: '100644', size: 10, sha256: 'b'.repeat(64) },
          { path: 'vendor/a/b', type: 'gitlink', mode: '160000', commit: '3'.repeat(40) },
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

    const pins = listGitlinkPins(manifest);
    expect(pins).toEqual([
      { path: 'vendor/a', commit: '2'.repeat(40) },
      { path: 'vendor/a/b', commit: '3'.repeat(40) },
    ]);
  });
});
