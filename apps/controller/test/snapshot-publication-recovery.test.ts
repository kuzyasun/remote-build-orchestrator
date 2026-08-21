import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireCaptureLease,
  releaseCaptureLease,
  reserveCaptureLease,
} from '../src/jobs/capture-lease.js';
import { persistSnapshot } from '../src/jobs/lifecycle.js';
import { recoverSnapshotPublications } from '../src/recovery/snapshot-publication.js';
import { migrateToLatest, openDatabase } from '../src/storage/database.js';

const capturedAt = new Date('2026-08-21T10:00:00.000Z');
const afterExpiry = new Date('2026-08-21T10:00:01.000Z');

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

describe('snapshot publication startup recovery', () => {
  let dataDir: string;
  let db: ReturnType<typeof openDatabase>;

  beforeEach(async () => {
    dataDir = join(
      process.cwd(),
      'tmp',
      `test-snapshot-publication-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(dataDir, { recursive: true });
    db = openDatabase(':memory:');
    migrateToLatest(db);
  });

  afterEach(async () => {
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function writeOrphan(jobId: string): Promise<{
    directory: string;
    candidate: string;
    gitRequirements: string;
    manifest: string;
    overlay: string;
    payload: string;
    temporary: string;
  }> {
    const directory = join(dataDir, 'snapshots', jobId);
    const candidate = join(directory, 'full-source.tar.zst.g1.candidate-dead-owner');
    const temporary = join(directory, 'manifest.json.g1.tmp-dead-owner');
    const manifest = join(directory, 'manifest.json.g1');
    const payload = join(directory, 'full-source.tar.zst.g1');
    const gitRequirements = join(directory, 'git-source-requirements.json.g1');
    const overlay = join(directory, 'overlay.tar.zst.g2');
    await mkdir(directory, { recursive: true });
    await Promise.all(
      [candidate, temporary, manifest, payload, gitRequirements, overlay].map((path) =>
        writeFile(path, path),
      ),
    );
    return { directory, candidate, gitRequirements, manifest, overlay, payload, temporary };
  }

  it('protects every candidate and final orphan while a capture lease is unexpired', async () => {
    const orphan = await writeOrphan('active-owner');
    const reserved = reserveCaptureLease(
      db,
      { clientId: 'active-client', clientRequestId: 'active-request' },
      { ownerToken: 'active-owner', ttlMs: 10_000, now: () => capturedAt },
    );
    expect(reserved.acquired).toBe(true);

    await expect(recoverSnapshotPublications({ db, dataDir, now: afterExpiry })).resolves.toEqual({
      skippedForActiveLease: true,
      removedFiles: 0,
      removedDirectories: 0,
    });
    await expect(exists(orphan.candidate)).resolves.toBe(true);
    await expect(exists(orphan.temporary)).resolves.toBe(true);
    await expect(exists(orphan.manifest)).resolves.toBe(true);
    await expect(exists(orphan.overlay)).resolves.toBe(true);
    await expect(exists(orphan.payload)).resolves.toBe(true);
  });

  it('cleans stale data once an expired lease has been reclaimed and released', async () => {
    const orphan = await writeOrphan('expired-owner');
    const key = { clientId: 'expired-client', clientRequestId: 'expired-request' };
    const first = reserveCaptureLease(db, key, {
      ownerToken: 'owner-1',
      ttlMs: 1_000,
      now: () => capturedAt,
    });
    expect(first.acquired).toBe(true);
    const reclaimed = acquireCaptureLease(db, key, {
      ownerToken: 'owner-2',
      ttlMs: 1_000,
      now: () => afterExpiry,
    });
    expect(reclaimed).toMatchObject({ acquired: true, reclaimed: true });
    if (!reclaimed.lease) throw new Error('Expected reclaimed lease');
    expect(releaseCaptureLease(db, reclaimed.lease)).toBe(true);

    await expect(recoverSnapshotPublications({ db, dataDir, now: afterExpiry })).resolves.toEqual({
      skippedForActiveLease: false,
      removedFiles: 6,
      removedDirectories: 1,
    });
    await expect(exists(orphan.directory)).resolves.toBe(false);
  });

  it('never deletes a manifest or payload referenced by a snapshot row', async () => {
    const referenced = await writeOrphan('referenced');
    const unreferenced = await writeOrphan('unreferenced');
    persistSnapshot(db, {
      snapshotId: 'snapshot-referenced',
      contentId: 'content-referenced',
      repoId: 'repo-referenced',
      baseCommit: null,
      dirty: true,
      manifestPath: referenced.manifest,
      payloadPath: referenced.payload,
      sizeBytes: 1,
      sha256: 'a'.repeat(64),
    });

    await recoverSnapshotPublications({ db, dataDir, now: afterExpiry });

    await expect(exists(referenced.manifest)).resolves.toBe(true);
    await expect(exists(referenced.payload)).resolves.toBe(true);
    await expect(exists(referenced.gitRequirements)).resolves.toBe(true);
    await expect(exists(referenced.overlay)).resolves.toBe(false);
    await expect(exists(referenced.candidate)).resolves.toBe(false);
    await expect(exists(referenced.temporary)).resolves.toBe(false);
    await expect(exists(unreferenced.directory)).resolves.toBe(false);
  });
});
