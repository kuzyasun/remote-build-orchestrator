import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendChunk,
  iterUnacked,
  openAttemptSpool,
  readAck,
  totalBytes,
  writeAck,
} from '../src/spool.js';

describe('AttemptSpool', () => {
  let spoolDir: string;

  afterEach(async () => {
    if (spoolDir) {
      await rm(spoolDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('allocates sequences starting at 1 and appends to disk before return', async () => {
    spoolDir = await mkdtemp(join(tmpdir(), 'rbo-spool-'));
    const spool = await openAttemptSpool(spoolDir);

    const first = await appendChunk(spool, 'stdout', 'hello');
    expect(first.sequence).toBe(1);

    const stdout = await readFile(join(spoolDir, 'stdout.log'), 'utf8');
    expect(stdout).toBe('hello');

    const index = (await readFile(join(spoolDir, 'chunks.jsonl'), 'utf8')).trim();
    expect(JSON.parse(index)).toMatchObject({
      sequence: 1,
      stream: 'stdout',
      byte_offset: 0,
      byte_length: Buffer.byteLength('hello'),
    });

    const second = await appendChunk(spool, 'stderr', 'err');
    expect(second.sequence).toBe(2);
  });

  it('writeAck atomically replaces ack.json', async () => {
    spoolDir = await mkdtemp(join(tmpdir(), 'rbo-spool-ack-'));
    const spool = await openAttemptSpool(spoolDir);
    await appendChunk(spool, 'stdout', 'a');

    await writeAck(spool, 1);
    expect(await readAck(spool)).toBe(1);

    const raw = await readFile(join(spoolDir, 'ack.json'), 'utf8');
    expect(JSON.parse(raw)).toEqual({ acked_sequence: 1 });
  });

  it('writeAck tolerates concurrent same-ms writers without ENOENT', async () => {
    spoolDir = await mkdtemp(join(tmpdir(), 'rbo-spool-ack-race-'));
    const spool = await openAttemptSpool(spoolDir);

    await Promise.all(Array.from({ length: 40 }, (_, i) => writeAck(spool, i + 1)));

    const acked = await readAck(spool);
    expect(acked).toBeGreaterThanOrEqual(1);
    expect(acked).toBeLessThanOrEqual(40);
  });

  it('writeAck recreates missing parent directory', async () => {
    spoolDir = await mkdtemp(join(tmpdir(), 'rbo-spool-ack-mkdir-'));
    const nested = join(spoolDir, 'att_missing', 'logs');
    const spool = {
      dir: nested,
      logs: {
        logDir: nested,
        stdoutPath: join(nested, 'stdout.log'),
        stderrPath: join(nested, 'stderr.log'),
        eventsPath: join(nested, 'events.jsonl'),
        chunksPath: join(nested, 'chunks.jsonl'),
      },
      chunksPath: join(nested, 'chunks.jsonl'),
      ackPath: join(nested, 'ack.json'),
      nextSequence: 1,
      streamOffsets: { stdout: 0, stderr: 0 },
    };

    await writeAck(spool, 7);
    expect(await readAck(spool)).toBe(7);
  });

  it('iterUnacked returns only sequences > afterSequence in order', async () => {
    spoolDir = await mkdtemp(join(tmpdir(), 'rbo-spool-iter-'));
    const spool = await openAttemptSpool(spoolDir);
    await appendChunk(spool, 'stdout', 'one');
    await appendChunk(spool, 'stderr', 'two');
    await appendChunk(spool, 'stdout', 'three');
    await writeAck(spool, 1);

    const chunks: Array<{ sequence: number; stream: string; bytes: string }> = [];
    for await (const chunk of iterUnacked(spool, await readAck(spool))) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { sequence: 2, stream: 'stderr', bytes: 'two' },
      { sequence: 3, stream: 'stdout', bytes: 'three' },
    ]);
  });

  it('iterUnacked is empty after all chunks are acked', async () => {
    spoolDir = await mkdtemp(join(tmpdir(), 'rbo-spool-empty-'));
    const spool = await openAttemptSpool(spoolDir);
    await appendChunk(spool, 'stdout', 'only');
    await writeAck(spool, 1);

    const chunks = [];
    for await (const chunk of iterUnacked(spool, 1)) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([]);
  });

  it('totalBytes grows with appended stream bytes', async () => {
    spoolDir = await mkdtemp(join(tmpdir(), 'rbo-spool-bytes-'));
    const spool = await openAttemptSpool(spoolDir);
    expect(await totalBytes(spool)).toBe(0);

    await appendChunk(spool, 'stdout', 'abc');
    expect(await totalBytes(spool)).toBe(3);

    await appendChunk(spool, 'stderr', 'de');
    expect(await totalBytes(spool)).toBe(5);
  });

  it('openAttemptSpool resumes sequence from existing chunks.jsonl', async () => {
    spoolDir = await mkdtemp(join(tmpdir(), 'rbo-spool-resume-'));
    await mkdir(spoolDir, { recursive: true });
    await writeFile(join(spoolDir, 'stdout.log'), 'hi');
    await writeFile(join(spoolDir, 'stderr.log'), '');
    await writeFile(join(spoolDir, 'events.jsonl'), '');
    await writeFile(
      join(spoolDir, 'chunks.jsonl'),
      `${JSON.stringify({ sequence: 1, stream: 'stdout', byte_offset: 0, byte_length: 2 })}\n`,
    );
    await writeFile(join(spoolDir, 'ack.json'), JSON.stringify({ acked_sequence: 1 }));

    const spool = await openAttemptSpool(spoolDir);
    const next = await appendChunk(spool, 'stdout', '!');
    expect(next.sequence).toBe(2);
    expect(await readAck(spool)).toBe(1);
  });

  it('recovers after truncated index tail and preserves unindexed stream tail offsets', async () => {
    spoolDir = await mkdtemp(join(tmpdir(), 'rbo-spool-recover-tail-'));
    await writeFile(join(spoolDir, 'stdout.log'), 'indexed-orphan');
    await writeFile(join(spoolDir, 'stderr.log'), '');
    await writeFile(join(spoolDir, 'events.jsonl'), '');
    await writeFile(
      join(spoolDir, 'chunks.jsonl'),
      `${JSON.stringify({ sequence: 4, stream: 'stdout', byte_offset: 0, byte_length: 7 })}\n{"sequence":5,"stream":"stdout"`,
    );

    const spool = await openAttemptSpool(spoolDir);
    expect(spool.nextSequence).toBe(5);
    expect(spool.streamOffsets.stdout).toBe(14);
    await appendChunk(spool, 'stdout', 'tail');

    const stdout = await readFile(join(spoolDir, 'stdout.log'), 'utf8');
    expect(stdout).toBe('indexed-orphan' + 'tail');
    const chunks = [];
    for await (const chunk of iterUnacked(spool, 4)) chunks.push(chunk);
    expect(chunks).toEqual([{ sequence: 5, stream: 'stdout', bytes: 'tail' }]);
  });

  it('rejects index records whose offset plus length overflows safe integers', async () => {
    spoolDir = await mkdtemp(join(tmpdir(), 'rbo-spool-overflow-'));
    await writeFile(join(spoolDir, 'stdout.log'), 'x');
    await writeFile(join(spoolDir, 'stderr.log'), '');
    await writeFile(join(spoolDir, 'events.jsonl'), '');
    await writeFile(
      join(spoolDir, 'chunks.jsonl'),
      `${JSON.stringify({ sequence: 1, stream: 'stdout', byte_offset: Number.MAX_SAFE_INTEGER, byte_length: 1 })}\n`,
    );
    const spool = await openAttemptSpool(spoolDir);
    expect(spool.nextSequence).toBe(1);
    expect(spool.streamOffsets.stdout).toBe(1);
  });
});
