import { RboError } from '@rbo/shared';
import { describe, expect, it } from 'vitest';
import { applyGitOverlay, materializeFullSnapshot } from '../src/materialize.js';

describe('materialize manifest validation', () => {
  it('materializeFullSnapshot rejects git_overlay manifests as RboError', async () => {
    const overlayManifest = {
      schema_version: 1,
      content_id: `sha256:${'a'.repeat(64)}`,
      repo: {
        canonical_id: 'example.com/repo',
        url: 'https://example.com/repo.git',
        branch: 'main',
        base_commit: 'abc123',
        head_is_pushed: true,
      },
      workspace: { main_mount: 'project', cwd: '.' },
      overlay: { files: [], deletions: [] },
      additional_roots: [],
      payload: {
        mode: 'git_overlay',
        format: 'tar',
        compression: 'zstd',
        sha256: 'b'.repeat(64),
        size: 1,
      },
    };

    await expect(
      materializeFullSnapshot({
        manifest: overlayManifest,
        archivePath: 'missing.tar.zst',
        workspaceRoot: 'C:\\tmp\\rbo-test-ws',
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof RboError &&
        error.category === 'materialization' &&
        error.message.includes('Invalid full snapshot manifest'),
    );
  });

  it('applyGitOverlay rejects full manifests as RboError', async () => {
    const fullManifest = {
      schema_version: 1,
      content_id: `sha256:${'a'.repeat(64)}`,
      workspace: { main_mount: 'project', cwd: '.' },
      source: { files: [], empty_directories: [] },
      additional_roots: [],
      payload: {
        mode: 'full',
        format: 'tar',
        compression: 'zstd',
        sha256: 'b'.repeat(64),
        size: 1,
      },
    };

    await expect(
      applyGitOverlay({
        manifest: fullManifest,
        archivePath: 'missing.tar.zst',
        workspaceRoot: 'C:\\tmp\\rbo-test-ws',
        projectPath: 'C:\\tmp\\rbo-test-ws\\project',
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof RboError &&
        error.category === 'materialization' &&
        error.message.includes('Invalid git_overlay snapshot manifest'),
    );
  });
});
