import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createZstdTarArchive,
  decompressTarZstd,
  parseTarArchive,
  writeZstdTarArchiveCandidate,
} from '../src/archive.js';
import { captureFullSnapshot } from '../src/capture.js';

const execFileAsync = promisify(execFile);

describe('writeZstdTarArchiveCandidate memory hygiene', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it('streams contentPath into a private candidate without creating the requested path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rbo-archive-candidate-'));
    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    const sourcePath = join(dir, 'source.bin');
    const requestedPath = join(dir, 'snapshot.tar.zst');
    const source = Buffer.alloc(8 * 1024 * 1024 + 17, 0x5a);
    await writeFile(sourcePath, source);

    const candidate = await writeZstdTarArchiveCandidate(requestedPath, [
      { path: 'source.bin', mode: 0o644, type: 'file', contentPath: sourcePath },
    ]);

    expect(candidate.candidatePath).not.toBe(requestedPath);
    expect(candidate.candidatePath).toContain('.candidate-');
    await expect(readFile(requestedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(candidate.entries).toEqual([
      expect.objectContaining({
        path: 'source.bin',
        size: source.length,
        sha256: createHash('sha256').update(source).digest('hex'),
      }),
    ]);
    const candidateTar = decompressTarZstd(await readFile(candidate.candidatePath));
    const expectedTar = createZstdTarArchive([
      { path: 'source.bin', mode: 0o644, type: 'file', content: source },
    ]);
    expect(candidateTar.equals(decompressTarZstd(expectedTar.data))).toBe(true);
    const parsed = parseTarArchive(candidateTar);
    expect(parsed[0]?.content.equals(source)).toBe(true);
    await rm(candidate.candidatePath, { force: true });
  });

  it('cleans the private candidate when a contentPath cannot be opened', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rbo-archive-failure-'));
    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    const requestedPath = join(dir, 'snapshot.tar.zst');

    await expect(
      writeZstdTarArchiveCandidate(requestedPath, [
        { path: 'missing.bin', mode: 0o644, type: 'file', contentPath: join(dir, 'missing.bin') },
      ]),
    ).rejects.toThrow();
    await expect(readFile(requestedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(dir)).filter((name) => name.includes('.candidate-'))).toEqual([]);
  });

  it('rejects a short/unreadable contentPath and cleans its candidate', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rbo-archive-mutation-'));
    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    const sourcePath = join(dir, 'source-dir');
    const requestedPath = join(dir, 'snapshot.tar.zst');
    await mkdir(sourcePath);
    await expect(
      writeZstdTarArchiveCandidate(requestedPath, [
        { path: 'source.bin', mode: 0o644, type: 'file', contentPath: sourcePath },
      ]),
    ).rejects.toThrow();
    await expect(readFile(requestedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(dir)).filter((name) => name.includes('.candidate-'))).toEqual([]);
  });

  it('rejects a source mutation between the pre-read and post-read handle stats', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rbo-archive-mutation-'));
    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    const sourcePath = join(dir, 'source.bin');
    const requestedPath = join(dir, 'snapshot.tar.zst');
    await writeFile(sourcePath, Buffer.alloc(1024 * 1024, 0x5a));

    const probe = await open(sourcePath, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probe) as typeof probe;
    await probe.close();
    const originalStat = fileHandlePrototype.stat;
    const statSpy = vi.spyOn(fileHandlePrototype, 'stat').mockImplementationOnce(async function (
      this: typeof probe,
      options?: { bigint?: boolean },
    ) {
      const result = await originalStat.call(this, options);
      writeFileSync(sourcePath, Buffer.from([0x51]), { flag: 'r+' });
      return result;
    });
    try {
      await expect(
        writeZstdTarArchiveCandidate(requestedPath, [
          { path: 'source.bin', mode: 0o644, type: 'file', contentPath: sourcePath },
        ]),
      ).rejects.toThrow(/changed while archiving/);
    } finally {
      statSpy.mockRestore();
    }
    await expect(readFile(requestedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(dir)).filter((name) => name.includes('.candidate-'))).toEqual([]);
  });

  it('reports an empty contentPath file and its empty-payload hash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rbo-archive-empty-'));
    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    const sourcePath = join(dir, 'empty.bin');
    const requestedPath = join(dir, 'snapshot.tar.zst');
    await writeFile(sourcePath, Buffer.alloc(0));
    const candidate = await writeZstdTarArchiveCandidate(requestedPath, [
      { path: 'empty.bin', mode: 0o644, type: 'file', contentPath: sourcePath },
    ]);
    expect(candidate.entries).toEqual([
      { path: 'empty.bin', size: 0, sha256: createHash('sha256').update('').digest('hex') },
    ]);
    expect(parseTarArchive(decompressTarZstd(await readFile(candidate.candidatePath)))).toEqual([
      expect.objectContaining({ path: 'empty.bin', type: 'file', content: Buffer.alloc(0) }),
    ]);
    await rm(candidate.candidatePath, { force: true });
  });

  it('rejects a contentPath symlink instead of following it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rbo-archive-symlink-'));
    cleanups.push(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    const sourcePath = join(dir, 'source.bin');
    const linkPath = join(dir, 'source.link');
    const requestedPath = join(dir, 'snapshot.tar.zst');
    await writeFile(sourcePath, Buffer.from('secret-bytes'));
    try {
      await symlink(sourcePath, linkPath);
    } catch {
      return;
    }
    await expect(
      writeZstdTarArchiveCandidate(requestedPath, [
        { path: 'source.bin', mode: 0o644, type: 'file', contentPath: linkPath },
      ]),
    ).rejects.toThrow(/regular file/);
    expect((await readdir(dir)).filter((name) => name.includes('.candidate-'))).toEqual([]);
  });

  it('writes a private candidate, returns no payload buffer, and hashes its on-disk bytes', async () => {
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
    const requestedPath = join(dir, 'out.tar.zst');
    const written = await writeZstdTarArchiveCandidate(requestedPath, entries);

    expect(written.format).toBe('tar');
    expect(written.compression).toBe('zstd');
    expect('data' in written).toBe(false);

    await expect(readFile(requestedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const onDisk = await readFile(written.candidatePath);
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
    await rm(written.candidatePath, { force: true });
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
