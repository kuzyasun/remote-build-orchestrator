import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendIndexedLogChunk,
  ensureAttemptLogs,
  iterChunkIndexEntriesAfter,
  iterIndexedChunkBytesAfter,
  iterIndexedChunksAfter,
  readChunkIndexEntries,
  readChunkIndexTail,
  readLastChunkSequence,
} from '../src/logs.js';

describe('sequence-indexed log reader', () => {
  let dir = '';

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('uses durable sequence order and byte offsets for UTF-8 chunks', async () => {
    dir = await mkdtemp(join(tmpdir(), 'rbo-log-reader-'));
    const logs = await ensureAttemptLogs(dir);
    await appendIndexedLogChunk(logs, 'stderr', Buffer.from('err'), 1);
    await appendIndexedLogChunk(logs, 'stdout', Buffer.from('до'), 2);

    const chunks = [];
    for await (const chunk of iterIndexedChunksAfter(logs, 0)) chunks.push(chunk);
    expect(chunks).toEqual([
      { sequence: 1, stream: 'stderr', text: 'err' },
      { sequence: 2, stream: 'stdout', text: 'до' },
    ]);
  });

  it('preserves raw bytes when a UTF-8 scalar is split across chunks', async () => {
    dir = await mkdtemp(join(tmpdir(), 'rbo-log-reader-split-utf8-'));
    const logs = await ensureAttemptLogs(dir);
    const scalar = Buffer.from('€');
    await appendIndexedLogChunk(logs, 'stdout', scalar.subarray(0, 1), 1);
    await appendIndexedLogChunk(logs, 'stdout', scalar.subarray(1), 2);
    const chunks = [];
    for await (const chunk of iterIndexedChunkBytesAfter(logs, 0)) chunks.push(chunk.bytes);
    expect(Buffer.concat(chunks)).toEqual(scalar);
  });

  it('ignores duplicate, invalid, and crash-truncated index records', async () => {
    dir = await mkdtemp(join(tmpdir(), 'rbo-log-reader-tail-'));
    const logs = await ensureAttemptLogs(dir);
    await writeFile(logs.stdoutPath, Buffer.from('valid'));
    await writeFile(
      logs.chunksPath,
      `${JSON.stringify({ sequence: 3, stream: 'stdout', byte_offset: 0, byte_length: 5 })}\n${JSON.stringify({ sequence: 3, stream: 'stdout', byte_offset: 0, byte_length: 5 })}\n${JSON.stringify({ sequence: 4, stream: 'stdout', byte_offset: 4, byte_length: 10 })}\n{"sequence":5,"stream":"stdout"`,
    );

    expect(await readChunkIndexEntries(logs)).toEqual([
      { sequence: 3, stream: 'stdout', byte_offset: 0, byte_length: 5 },
    ]);
    const chunks = [];
    for await (const chunk of iterIndexedChunksAfter(logs, 0)) chunks.push(chunk);
    expect(chunks).toHaveLength(1);
  });

  it('resynchronizes after an oversized corrupt index line', async () => {
    dir = await mkdtemp(join(tmpdir(), 'rbo-log-reader-oversize-'));
    const logs = await ensureAttemptLogs(dir);
    await writeFile(logs.stdoutPath, Buffer.from('ok'));
    const oversized = 'x'.repeat(1024 * 1024 + 1);
    await writeFile(
      logs.chunksPath,
      `${oversized}\n${JSON.stringify({ sequence: 1, stream: 'stdout', byte_offset: 0, byte_length: 2 })}\n`,
    );
    expect(await readChunkIndexEntries(logs)).toEqual([
      { sequence: 1, stream: 'stdout', byte_offset: 0, byte_length: 2 },
    ]);
  });

  it('seeks high cursors through a durable sparse checkpoint after restart', async () => {
    dir = await mkdtemp(join(tmpdir(), 'rbo-log-reader-checkpoint-'));
    let logs = await ensureAttemptLogs(dir);
    const indexLines: string[] = [];
    let offset = 0;
    for (let sequence = 1; sequence <= 1024; sequence++) {
      const bytes = Buffer.from(`chunk-${sequence}\n`);
      indexLines.push(
        `${JSON.stringify({ sequence, stream: 'stdout', byte_offset: offset, byte_length: bytes.length })}\n`,
      );
      offset += bytes.length;
    }
    await writeFile(logs.stdoutPath, Buffer.alloc(offset, 120));
    await writeFile(logs.chunksPath, indexLines.join(''));
    const checkpointLines = Array.from({ length: 8 }, (_, index) => {
      const sequence = (index + 1) * 128;
      const checkpointOffset = indexLines.slice(0, sequence).join('').length;
      return `${JSON.stringify({ sequence: sequence - 1, byte_offset: checkpointOffset })}\n`;
    });
    const checkpointPath = join(dir, 'chunks.checkpoints.jsonl');
    await writeFile(checkpointPath, checkpointLines.join(''));
    const checkpoints = await readFile(checkpointPath, 'utf8');
    expect(checkpoints).toContain('"sequence":895');

    // Re-open to model restart; the iterator must start at the checkpointed
    // byte offset and return a strict, duplicate-free chronological suffix.
    logs = await ensureAttemptLogs(dir);
    const entries = [];
    for await (const entry of iterChunkIndexEntriesAfter(logs, 900)) entries.push(entry);
    expect(entries.map((entry) => entry.sequence)).toEqual(
      Array.from({ length: 124 }, (_, index) => index + 901),
    );
  });

  it('falls back safely when checkpoints are absent, truncated, or point at bad records', async () => {
    dir = await mkdtemp(join(tmpdir(), 'rbo-log-reader-checkpoint-fallback-'));
    const logs = await ensureAttemptLogs(dir);
    const indexLines: string[] = [];
    for (let sequence = 1; sequence <= 256; sequence++) {
      indexLines.push(
        `${JSON.stringify({ sequence, stream: 'stdout', byte_offset: sequence - 1, byte_length: 1 })}\n`,
      );
    }
    await writeFile(logs.stdoutPath, Buffer.alloc(256, 120));
    await writeFile(logs.chunksPath, indexLines.join(''));
    await writeFile(
      join(dir, 'chunks.checkpoints.jsonl'),
      '{"sequence":127,"byte_offset":999999}\n{"sequence":',
    );
    const entries = [];
    for await (const entry of iterChunkIndexEntriesAfter(logs, 200)) entries.push(entry);
    expect(entries.map((entry) => entry.sequence)).toEqual(
      Array.from({ length: 56 }, (_, index) => index + 201),
    );
  });

  it('recovers the real last sequence after restart with a corrupt newest checkpoint', async () => {
    dir = await mkdtemp(join(tmpdir(), 'rbo-log-reader-last-sequence-'));
    const logs = await ensureAttemptLogs(dir);
    const indexLines: string[] = [];
    for (let sequence = 1; sequence <= 1024; sequence++) {
      indexLines.push(
        `${JSON.stringify({ sequence, stream: 'stdout', byte_offset: sequence - 1, byte_length: 1 })}\n`,
      );
    }
    await writeFile(logs.stdoutPath, Buffer.alloc(1024, 120));
    await writeFile(logs.chunksPath, indexLines.join(''));
    const checkpointLines = Array.from({ length: 8 }, (_, index) => {
      const sequence = (index + 1) * 128;
      const checkpointOffset = indexLines.slice(0, sequence).join('').length;
      return `${JSON.stringify({ sequence: sequence - 1, byte_offset: checkpointOffset })}\n`;
    });
    checkpointLines[checkpointLines.length - 1] = '{"sequence":1023,"byte_offset":999999}\n';
    await writeFile(join(dir, 'chunks.checkpoints.jsonl'), checkpointLines.join(''));

    expect(await readLastChunkSequence(logs)).toBe(1024);
  });

  it('uses caller-provided in-memory stream offset when supplied', async () => {
    dir = await mkdtemp(join(tmpdir(), 'rbo-log-reader-offset-'));
    const logs = await ensureAttemptLogs(dir);
    const first = await appendIndexedLogChunk(logs, 'stdout', 'chunk-1', 1, 0);
    expect(first.entry).toEqual({
      sequence: 1,
      stream: 'stdout',
      byte_offset: 0,
      byte_length: Buffer.byteLength('chunk-1'),
    });

    const secondOffset = first.entry.byte_offset + first.entry.byte_length;
    const second = await appendIndexedLogChunk(logs, 'stdout', 'chunk-2', 2, secondOffset);
    expect(second.entry).toEqual({
      sequence: 2,
      stream: 'stdout',
      byte_offset: secondOffset,
      byte_length: Buffer.byteLength('chunk-2'),
    });

    const third = await appendIndexedLogChunk(logs, 'stderr', 'err-1', 3, 0);
    expect(third.entry).toEqual({
      sequence: 3,
      stream: 'stderr',
      byte_offset: 0,
      byte_length: Buffer.byteLength('err-1'),
    });

    const chunks = [];
    for await (const chunk of iterIndexedChunksAfter(logs, 0)) chunks.push(chunk);
    expect(chunks).toEqual([
      { sequence: 1, stream: 'stdout', text: 'chunk-1' },
      { sequence: 2, stream: 'stdout', text: 'chunk-2' },
      { sequence: 3, stream: 'stderr', text: 'err-1' },
    ]);
  });

  it('reads a bounded suffix without replaying the complete index', async () => {
    dir = await mkdtemp(join(tmpdir(), 'rbo-log-reader-tail-index-'));
    const logs = await ensureAttemptLogs(dir);
    for (let sequence = 1; sequence <= 300; sequence += 1) {
      await appendIndexedLogChunk(
        logs,
        sequence % 2 ? 'stdout' : 'stderr',
        `x${sequence}`,
        sequence,
      );
    }
    const tail = await readChunkIndexTail(logs, 3);
    expect(tail.map((entry) => entry.sequence)).toEqual([298, 299, 300]);
  });
});
