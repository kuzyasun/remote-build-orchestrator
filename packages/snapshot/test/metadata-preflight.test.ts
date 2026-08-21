import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeZstdTarArchiveCandidate } from '../src/archive.js';
import {
  metadataPreflightExperimentWorkerCounts,
  runMetadataPreflightExperiment,
} from '../src/metadata-preflight.js';

describe('S-05 metadata-preflight experiment helper', () => {
  it.each([0, 2, 9_999] as const)(
    'rejects the unsupported %i-worker profile before it starts metadata work',
    async (workerCount) => {
      await expect(
        runMetadataPreflightExperiment({
          items: [1],
          workerCount,
          async inspect(item) {
            return item;
          },
        }),
      ).rejects.toThrow('workerCount must be one of the S-05 profiles: 1, 4, or 8');
    },
  );

  it.each(metadataPreflightExperimentWorkerCounts)(
    'preserves metadata order with %i workers',
    async (workerCount) => {
      const items = Array.from({ length: 24 }, (_, index) => index);
      const result = await runMetadataPreflightExperiment({
        items,
        workerCount,
        async inspect(item) {
          await new Promise((resolve) => setTimeout(resolve, (items.length - item) % 4));
          return `metadata-${item}`;
        },
      });

      expect(result).toEqual(items.map((item) => `metadata-${item}`));
    },
  );

  it('bounds in-flight metadata work to the configured worker count', async () => {
    let active = 0;
    let peakActive = 0;
    const result = await runMetadataPreflightExperiment({
      items: Array.from({ length: 20 }, (_, index) => index),
      workerCount: 4,
      async inspect(item) {
        active += 1;
        peakActive = Math.max(peakActive, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return item;
      },
    });

    expect(peakActive).toBeLessThanOrEqual(4);
    expect(result).toEqual(Array.from({ length: 20 }, (_, index) => index));
  });

  it('waits for in-flight work and stops dispatching after an inspection failure', async () => {
    const started: number[] = [];
    await expect(
      runMetadataPreflightExperiment({
        items: Array.from({ length: 10 }, (_, index) => index),
        workerCount: 4,
        async inspect(item) {
          started.push(item);
          if (item === 0) {
            throw new Error('metadata failure');
          }
          await new Promise((resolve) => setTimeout(resolve, 2));
          return item;
        },
      }),
    ).rejects.toThrow('metadata failure');

    expect(started).toEqual([0, 1, 2, 3]);
  });

  it('propagates an undefined inspection rejection after in-flight workers settle', async () => {
    await expect(
      runMetadataPreflightExperiment({
        items: [0, 1, 2, 3],
        workerCount: 4,
        async inspect(item) {
          if (item === 0) {
            return Promise.reject(undefined);
          }
          await new Promise((resolve) => setTimeout(resolve, 2));
          return item;
        },
      }),
    ).rejects.toBeUndefined();
  });

  it('preserves the first inspection error when concurrent work also fails', async () => {
    await expect(
      runMetadataPreflightExperiment({
        items: [0, 1, 2, 3],
        workerCount: 4,
        async inspect(item) {
          if (item === 0) {
            await new Promise((resolve) => setTimeout(resolve, 2));
            throw new Error('first metadata failure');
          }
          if (item === 1) {
            await new Promise((resolve) => setTimeout(resolve, 4));
            throw new Error('later metadata failure');
          }
          await new Promise((resolve) => setTimeout(resolve, 6));
          return item;
        },
      }),
    ).rejects.toThrow('first metadata failure');
  });

  it('produces identical sorted archive output for the 1/4/8-worker profiles', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'rbo-metadata-preflight-'));
    const archiveDir = await mkdtemp(join(tmpdir(), 'rbo-metadata-preflight-archive-'));
    try {
      const paths = await Promise.all(
        Array.from({ length: 32 }, async (_, index) => {
          const path = join(fixture, `file-${String(index).padStart(3, '0')}.txt`);
          await writeFile(path, `payload-${index}\n`);
          return path;
        }),
      );
      const archiveHashes: string[] = [];
      for (const workerCount of metadataPreflightExperimentWorkerCounts) {
        const metadata = await runMetadataPreflightExperiment({
          items: [...paths].reverse(),
          workerCount,
          async inspect(path) {
            await new Promise((resolve) => setTimeout(resolve, path.length % 3));
            return path;
          },
        });
        const archive = await writeZstdTarArchiveCandidate(
          join(archiveDir, `profile-${workerCount}.tar.zst`),
          metadata.map((path) => ({
            path: path.slice(fixture.length + 1).replace(/\\/g, '/'),
            mode: 0o644,
            type: 'file' as const,
            contentPath: path,
          })),
        );
        archiveHashes.push(archive.sha256);
        expect(archive.entries.map((entry) => entry.path)).toEqual(
          [...archive.entries.map((entry) => entry.path)].sort((a, b) => a.localeCompare(b)),
        );
        await rm(archive.candidatePath, { force: true });
      }

      expect(new Set(archiveHashes).size).toBe(1);
    } finally {
      await rm(fixture, { recursive: true, force: true });
      await rm(archiveDir, { recursive: true, force: true });
    }
  });
});
