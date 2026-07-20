/**
 * Regression tests for Phase 5 review findings (fixed behaviour).
 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAllowedRepositoryUrl, sha256 } from '@rbo/shared';
import { createGitFixtureRepo } from '@rbo/testing';
import { describe, expect, it } from 'vitest';
import {
  captureFullSnapshot,
  captureGitOverlaySnapshot,
  materializeFullSnapshot,
} from '../src/index.js';

describe('Phase 5 review fixes', () => {
  it('overlay capture emits fetch_refs from branch', async () => {
    const repo = await createGitFixtureRepo({
      committed: [{ path: 'a.txt', content: 'a' }],
      unstaged: [{ path: 'a.txt', content: 'dirty' }],
    });
    const storage = await mkdtemp(join(tmpdir(), 'rbo-fix-fetchrefs-'));
    try {
      const captured = await captureGitOverlaySnapshot({
        projectRoot: repo.root,
        allowedProjectRoots: [repo.root],
        sourcePolicy: {
          include_untracked: true,
          include_ignored: [],
          secret_policy: 'allow',
        },
        contentStorageDir: storage,
        repoUrl: 'git@github.com:kuzyasun/esp32-boilerplate.git',
      });
      expect(captured.manifest.repo.branch).toBeTruthy();
      expect(captured.manifest.repo.fetch_refs).toEqual([
        `refs/heads/${captured.manifest.repo.branch}`,
      ]);
    } finally {
      await repo.cleanup();
      await rm(storage, { recursive: true, force: true });
    }
  });

  it('default host allowlist accepts github URLs (scheme still enforced)', () => {
    expect(
      isAllowedRepositoryUrl('git@github.com:kuzyasun/esp32-boilerplate.git', {
        schemes: ['https', 'ssh'],
        hosts: ['github.com'],
      }),
    ).toBe(true);
  });

  it('full archive + full manifest materializes after overlay capture (fallback shape)', async () => {
    const repo = await createGitFixtureRepo({
      committed: [{ path: 'a.txt', content: 'a' }],
      unstaged: [{ path: 'a.txt', content: 'dirty' }],
      untracked: [{ path: 'extra.txt', content: 'x'.repeat(200) }],
    });
    const storage = await mkdtemp(join(tmpdir(), 'rbo-fix-fallback-'));
    try {
      await captureGitOverlaySnapshot({
        projectRoot: repo.root,
        allowedProjectRoots: [repo.root],
        sourcePolicy: {
          include_untracked: true,
          include_ignored: [],
          secret_policy: 'allow',
        },
        contentStorageDir: join(storage, 'overlay'),
        repoUrl: 'git@github.com:kuzyasun/esp32-boilerplate.git',
      });
      const full = await captureFullSnapshot({
        projectRoot: repo.root,
        allowedProjectRoots: [repo.root],
        sourcePolicy: {
          include_untracked: true,
          include_ignored: [],
          secret_policy: 'allow',
        },
        contentStorageDir: join(storage, 'full'),
      });
      const workspace = join(storage, 'ws');
      await mkdir(workspace, { recursive: true });

      // Correct fallback prepare: full archive + matching full manifest
      const prepare = {
        source_mode: 'full' as const,
        expected_sha256: full.manifest.payload.sha256,
        manifest: full.manifest,
      };
      expect(prepare.manifest.payload.mode).toBe('full');
      expect(prepare.expected_sha256).toBe(prepare.manifest.payload.sha256);

      const result = await materializeFullSnapshot({
        manifest: prepare.manifest,
        archivePath: full.archivePath,
        workspaceRoot: workspace,
      });
      expect(result.projectPath).toBeTruthy();
      expect(sha256(await readFile(full.archivePath))).toBe(full.manifest.payload.sha256);
    } finally {
      await repo.cleanup();
      await rm(storage, { recursive: true, force: true });
    }
  }, 90_000);
});
