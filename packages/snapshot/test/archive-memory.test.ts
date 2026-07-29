import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createZstdTarArchive, writeZstdTarArchiveFile } from '../src/archive.js';
import { captureFullSnapshot } from '../src/capture.js';

const execFileAsync = promisify(execFile);

describe('writeZstdTarArchiveFile memory hygiene', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it('writes archive to disk, returns no payload buffer, and hashes the on-disk bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rbo-archive-'));
    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    const entries = [
      {
        path: 'a.txt',
        mode: 0o644,
        type: 'file' as const,
        content: Buffer.from('hello-a'),
      },
      {
        path: 'b.txt',
        mode: 0o644,
        type: 'file' as const,
        content: Buffer.from('hello-b'),
      },
    ];
    const outPath = join(dir, 'out.tar.zst');
    const written = await writeZstdTarArchiveFile(outPath, entries);

    expect(written.format).toBe('tar');
    expect(written.compression).toBe('zstd');
    expect('data' in written).toBe(false);

    const onDisk = await readFile(outPath);
    expect(createHash('sha256').update(onDisk).digest('hex')).toBe(written.sha256);
    expect(onDisk.length).toBe(written.size);

    // Streaming zstd may differ from sync helper; both must decompress to the same tar.
    const inMemory = createZstdTarArchive(entries);
    const { decompressTarZstd, parseTarArchive } = await import('../src/archive.js');
    const streamedEntries = parseTarArchive(decompressTarZstd(onDisk));
    const syncEntries = parseTarArchive(decompressTarZstd(inMemory.data));
    expect(streamedEntries.map((e) => ({ path: e.path, size: e.content.length }))).toEqual(
      syncEntries.map((e) => ({ path: e.path, size: e.content.length })),
    );
  });

  it('full capture drops in-memory file buffers after writing the archive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rbo-cap-mem-'));
    const storage = await mkdtemp(join(tmpdir(), 'rbo-cap-store-'));
    cleanups.push(async () => {
      await rm(root, { recursive: true, force: true });
      await rm(storage, { recursive: true, force: true });
    });
    await execFileAsync('git', ['init'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['config', 'user.email', 't@e.com'], {
      cwd: root,
      windowsHide: true,
    });
    await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: root, windowsHide: true });
    await writeFile(join(root, 'blob.bin'), Buffer.alloc(64 * 1024, 7));
    await execFileAsync('git', ['add', '.'], { cwd: root, windowsHide: true });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: root, windowsHide: true });

    const captured = await captureFullSnapshot({
      projectRoot: root,
      allowedProjectRoots: [root],
      cwd: '.',
      sourcePolicy: {
        include_untracked: true,
        include_ignored: [],
        secret_policy: 'block',
      },
      contentStorageDir: storage,
    });

    expect(captured.retainedContentBytes).toBe(0);
    const onDisk = await readFile(captured.archivePath);
    expect(onDisk.length).toBe(captured.manifest.payload.size);
    expect(createHash('sha256').update(onDisk).digest('hex')).toBe(
      captured.manifest.payload.sha256,
    );
  });
});
