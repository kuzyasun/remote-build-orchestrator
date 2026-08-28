import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const streamCalls: unknown[][] = [];
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      streamCalls.push(args);
      return actual.createReadStream(...args);
    },
  };
});

import { ensureAttemptLogs, readLastChunkSequence } from '../src/logs.js';

describe('log checkpoint seeking', () => {
  let dir = '';

  afterEach(async () => {
    streamCalls.length = 0;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('seeks from a positive checkpoint when finding the last sequence', async () => {
    dir = await mkdtemp(join(tmpdir(), 'rbo-log-reader-last-sequence-seek-'));
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
      const checkpointOffset = indexLines.slice(0, sequence - 1).join('').length;
      return `${JSON.stringify({ sequence: sequence - 1, byte_offset: checkpointOffset })}\n`;
    });
    await writeFile(join(dir, 'chunks.checkpoints.jsonl'), checkpointLines.join(''));

    expect(await readLastChunkSequence(logs)).toBe(1024);
    expect(
      streamCalls.some(([, options]) => {
        return typeof options === 'object' && options !== null && Number(options.start) > 0;
      }),
    ).toBe(true);
  });
});
