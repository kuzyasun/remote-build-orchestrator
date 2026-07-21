import { createHash } from 'node:crypto';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { streamDownloadWithLimits } from '../src/executor/stream-download-with-limits.js';

describe('streamDownloadWithLimits', () => {
  let tempDir: string;
  let destPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'rbo-stream-download-'));
    destPath = join(tempDir, 'snapshot.bin');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('rejects and unlinks dest when stream exceeds expectedSize mid-stream', async () => {
    const expectedSize = 4;
    const chunkA = Buffer.alloc(3, 0x61);
    const chunkB = Buffer.alloc(3, 0x62);
    const source = Readable.from([chunkA, chunkB]);

    await expect(
      streamDownloadWithLimits(source, destPath, expectedSize, 'deadbeef'),
    ).rejects.toThrow(`Downloaded size 6 mismatch with expected ${expectedSize}`);

    await expect(access(destPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('accepts exact size and matching sha256', async () => {
    const body = Buffer.from('hello snapshot');
    const expectedSize = body.length;
    const expectedSha256 = createHash('sha256').update(body).digest('hex');
    const source = Readable.from([body.subarray(0, 4), body.subarray(4)]);

    await streamDownloadWithLimits(source, destPath, expectedSize, expectedSha256);

    await expect(access(destPath)).resolves.toBeUndefined();
  });

  it('rejects undersize at finish and unlinks dest', async () => {
    const body = Buffer.from('short');
    const expectedSize = body.length + 8;
    const expectedSha256 = createHash('sha256').update(body).digest('hex');
    const source = Readable.from([body]);

    await expect(
      streamDownloadWithLimits(source, destPath, expectedSize, expectedSha256),
    ).rejects.toThrow(`Downloaded size ${body.length} mismatch with expected ${expectedSize}`);

    await expect(access(destPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects sha256 mismatch at finish and unlinks dest', async () => {
    const body = Buffer.from('payload');
    const expectedSize = body.length;
    const source = Readable.from([body]);

    await expect(
      streamDownloadWithLimits(source, destPath, expectedSize, '0'.repeat(64)),
    ).rejects.toThrow(/sha256 .* mismatch with expected/);

    await expect(access(destPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
