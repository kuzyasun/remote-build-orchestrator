import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyDiskPressureCleanup } from '../src/recovery/disk-pressure.js';

describe('applyDiskPressureCleanup cleanupAttemptResources', () => {
  let stateDir: string;

  afterEach(async () => {
    if (stateDir) {
      await rm(stateDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function seedTerminalAttempt(attemptId: string, updatedAtMs: number): Promise<void> {
    stateDir = await mkdtemp(join(tmpdir(), 'rbo-disk-pressure-cleanup-'));
    const workspace = join(stateDir, 'workspaces', attemptId, 'marker.txt');
    const artifacts = join(stateDir, 'artifacts', attemptId, 'out.bin');
    await mkdir(join(workspace, '..'), { recursive: true });
    await mkdir(join(artifacts, '..'), { recursive: true });
    await writeFile(workspace, 'ws');
    await writeFile(artifacts, 'art');
    await mkdir(join(stateDir, 'attempts', attemptId), { recursive: true });
    await writeFile(
      join(stateDir, 'attempts', attemptId, 'metadata.json'),
      JSON.stringify({
        attempt_id: attemptId,
        job_id: 'job_old',
        lease_id: 'l',
        lease_epoch: 1,
        process_identity: 'pid:1',
        status: 'terminal',
        workspace_path: join(stateDir, 'workspaces', attemptId),
        spool_dir: join(stateDir, 'logs', attemptId),
        risk_level: 'normal',
        updated_at: new Date(updatedAtMs).toISOString(),
      }),
    );
  }

  it('invokes cleanupAttemptResources for old terminal attempts before workspace removal', async () => {
    const attemptId = 'att_terminal_old';
    await seedTerminalAttempt(attemptId, Date.now() - 90 * 24 * 60 * 60 * 1000);
    const cleaned: string[] = [];

    await applyDiskPressureCleanup({
      stateDir,
      minFreeBytes: 10_000,
      freeBytes: 100,
      retentionMs: 7 * 24 * 60 * 60 * 1000,
      cleanupAttemptResources: async (id) => {
        cleaned.push(id);
      },
    });

    expect(cleaned).toEqual([attemptId]);
  });

  it('invokes cleanupAttemptResources when sweeping orphan artifact dirs', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'rbo-disk-pressure-orphan-art-'));
    const orphanId = 'att_orphan_art_only';
    const artDir = join(stateDir, 'artifacts', orphanId, 'out.bin');
    await mkdir(join(artDir, '..'), { recursive: true });
    await writeFile(artDir, 'orphan');
    const cleaned: string[] = [];

    await applyDiskPressureCleanup({
      stateDir,
      minFreeBytes: 10_000,
      freeBytes: 100,
      retentionMs: 7 * 24 * 60 * 60 * 1000,
      cleanupAttemptResources: async (id) => {
        cleaned.push(id);
      },
    });

    expect(cleaned).toEqual([orphanId]);
  });

  it('does not invoke cleanupAttemptResources when accepting jobs', async () => {
    const attemptId = 'att_terminal_old';
    await seedTerminalAttempt(attemptId, Date.now() - 90 * 24 * 60 * 60 * 1000);
    const cleaned: string[] = [];

    await applyDiskPressureCleanup({
      stateDir,
      minFreeBytes: 1,
      freeBytes: 10_000_000,
      retentionMs: 7 * 24 * 60 * 60 * 1000,
      cleanupAttemptResources: async (id) => {
        cleaned.push(id);
      },
    });

    expect(cleaned).toEqual([]);
  });
});
