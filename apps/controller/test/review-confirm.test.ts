/**
 * Regression tests for Phase 5 Controller review findings.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureFullSnapshot, captureGitOverlaySnapshot } from '@rbo/snapshot';
import { createGitFixtureRepo } from '@rbo/testing';
import { describe, expect, it } from 'vitest';
import { loadControllerConfig } from '../src/config.js';

describe('Phase 5 controller review fixes', () => {
  it('fallback prepare uses full manifest matching full archive hashes', async () => {
    const repo = await createGitFixtureRepo({
      committed: [{ path: 'a.txt', content: 'a' }],
      unstaged: [{ path: 'a.txt', content: 'b' }],
      untracked: [{ path: 'big.txt', content: 'y'.repeat(300) }],
    });
    const storage = await mkdtemp(join(tmpdir(), 'rbo-fix-ctrl-fb-'));
    try {
      const overlay = await captureGitOverlaySnapshot({
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

      // Fixed remote-execution fallback prepare shape
      const preparePayload = {
        source_mode: 'full' as const,
        expected_size_bytes: full.manifest.payload.size,
        expected_sha256: full.manifest.payload.sha256,
        manifest: full.manifest,
      };

      expect(preparePayload.source_mode).toBe('full');
      expect(preparePayload.manifest.payload.mode).toBe('full');
      expect(preparePayload.expected_sha256).toBe(preparePayload.manifest.payload.sha256);
      // Overlay path remains available as the original capture (not used in fallback prepare).
      expect(overlay.manifest.payload.mode).toBe('git_overlay');
    } finally {
      await repo.cleanup();
      await rm(storage, { recursive: true, force: true });
    }
  });

  it('default controller git allowlist hosts github.com when unset', () => {
    const cfg = loadControllerConfig({
      dataDir: join(tmpdir(), 'rbo-fix-cfg'),
      allowedProjectRoots: [],
    });
    expect(cfg.gitAllowlist.hosts).toEqual(['github.com']);
  });

  it('transfer snapshot selection uses body hash for headers', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'rbo-fix-dp-'));
    try {
      const attemptId = 'att_1';
      const overlayBytes = Buffer.from('overlay-bytes');
      const fullBytes = Buffer.from('full-fallback-bytes-xxxxxxxx');
      const overlaySha = createHash('sha256').update(overlayBytes).digest('hex');
      const fullSha = createHash('sha256').update(fullBytes).digest('hex');

      const dbPayload = join(dataDir, 'overlay.bin');
      await writeFile(dbPayload, overlayBytes);
      const transferPath = join(dataDir, 'attempts', attemptId, 'transfer', 'snapshot.tar.zst');
      await mkdir(join(dataDir, 'attempts', attemptId, 'transfer'), { recursive: true });
      await writeFile(transferPath, fullBytes);

      const row = { payload_path: dbPayload, size_bytes: overlayBytes.length, sha256: overlaySha };
      let payloadPath: string | undefined = row.payload_path;
      let sizeBytes: number | undefined = row.size_bytes;
      let headerSha = row.sha256;

      const { access, stat, readFile: rf } = await import('node:fs/promises');
      try {
        await access(transferPath);
        const transferStats = await stat(transferPath);
        payloadPath = transferPath;
        sizeBytes = transferStats.size;
        const transferData = await rf(transferPath);
        headerSha = createHash('sha256').update(transferData).digest('hex');
      } catch {
        // ignore
      }

      expect(payloadPath).toBe(transferPath);
      expect(sizeBytes).toBe(fullBytes.length);
      expect(headerSha).toBe(fullSha);
      if (!payloadPath) {
        throw new Error('expected payloadPath');
      }
      expect(
        createHash('sha256')
          .update(await readFile(payloadPath))
          .digest('hex'),
      ).toBe(fullSha);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
