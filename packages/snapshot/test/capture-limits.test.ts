import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitFixtureRepo } from '@rbo/testing';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type SnapshotCaptureLimits,
  captureFullSnapshot,
  captureGitOverlaySnapshot,
} from '../src/capture.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

const permissiveLimits: SnapshotCaptureLimits = {
  maxTotalSourceBytes: 1024 * 1024,
  maxRegularFileCount: 100,
  maxSingleFileBytes: 1024 * 1024,
  maxTemporarySnapshotBytes: 2 * 1024 * 1024,
};

function expectLimit(limitKey: string, actual: number) {
  return expect.objectContaining({
    category: 'validation',
    details: expect.objectContaining({ limit_key: limitKey, actual }),
  });
}

describe('snapshot capture limits (§4.3)', () => {
  it.each([
    [
      'rejects an oversized regular file before full compression',
      [{ path: 'large.bin', content: '123456' }],
      { ...permissiveLimits, maxSingleFileBytes: 5 },
      'max_snapshot_single_file_bytes',
      6,
    ],
    [
      'rejects too many full-capture regular files before compression',
      [
        { path: 'one.txt', content: '1' },
        { path: 'two.txt', content: '2' },
      ],
      { ...permissiveLimits, maxRegularFileCount: 1 },
      'max_snapshot_file_count',
      3,
    ],
    [
      'rejects a full capture whose metadata exceeds total source bytes',
      [
        { path: 'one.txt', content: '123' },
        { path: 'two.txt', content: '456' },
      ],
      { ...permissiveLimits, maxTotalSourceBytes: 5 },
      'max_snapshot_source_bytes',
      10,
    ],
    [
      'rejects a full capture whose estimated temporary tar exceeds its budget',
      [{ path: 'entry.txt', content: 'x' }],
      { ...permissiveLimits, maxTemporarySnapshotBytes: 1024 },
      'max_snapshot_temporary_bytes',
      3072,
    ],
  ])('%s', async (_name, untracked, limits, limitKey, actual) => {
    const repo = await createGitFixtureRepo({
      committed: [{ path: 'base.txt', content: 'base' }],
      untracked,
    });
    cleanups.push(repo.cleanup);
    const storage = await mkdtemp(join(tmpdir(), 'rbo-capture-limits-'));
    cleanups.push(() => rm(storage, { recursive: true, force: true }));

    await expect(
      captureFullSnapshot({
        projectRoot: repo.root,
        allowedProjectRoots: [repo.root],
        sourcePolicy: { include_untracked: true, include_ignored: [], secret_policy: 'allow' },
        contentStorageDir: storage,
        limits,
      }),
    ).rejects.toMatchObject(expectLimit(limitKey, actual));
    expect(await readdir(storage)).toEqual([]);
  });

  it('applies the same metadata limits to dirty git-overlay capture before compression', async () => {
    const repo = await createGitFixtureRepo({
      committed: [{ path: 'tracked.txt', content: 'base' }],
      unstaged: [{ path: 'tracked.txt', content: 'changed' }],
    });
    cleanups.push(repo.cleanup);
    const storage = await mkdtemp(join(tmpdir(), 'rbo-overlay-limits-'));
    cleanups.push(() => rm(storage, { recursive: true, force: true }));

    await expect(
      captureGitOverlaySnapshot({
        projectRoot: repo.root,
        allowedProjectRoots: [repo.root],
        sourcePolicy: { include_untracked: true, include_ignored: [], secret_policy: 'allow' },
        contentStorageDir: storage,
        repoUrl: 'https://github.com/example/repo.git',
        limits: { ...permissiveLimits, maxSingleFileBytes: 6 },
      }),
    ).rejects.toMatchObject(expectLimit('max_snapshot_single_file_bytes', 7));
    expect(await readdir(storage)).toEqual([]);
  });
});
