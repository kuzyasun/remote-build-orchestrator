import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendIndexedLogChunk,
  ensureAttemptLogs,
  iterIndexedChunksAfter,
  readLogTail,
} from '../src/logs.js';

function memory(): { heap: number; rss: number } {
  const usage = process.memoryUsage();
  return { heap: usage.heapUsed, rss: usage.rss };
}

function measurement(
  scenario: string,
  started: number,
  before: ReturnType<typeof memory>,
  extra: Record<string, unknown>,
) {
  const after = memory();
  console.log(
    JSON.stringify({
      scenario,
      elapsed_ms: Number((performance.now() - started).toFixed(3)),
      heap_delta_bytes: after.heap - before.heap,
      rss_delta_bytes: after.rss - before.rss,
      ...extra,
    }),
  );
}

describe('AI efficiency benchmark harnesses (small profile)', () => {
  it('reads the tail of an 8 MiB spool', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rbo-ai-log-tail-'));
    try {
      const path = join(dir, 'stdout.log');
      const content = `${'x'.repeat(8 * 1024 * 1024 - 32)}\nline-a\nline-b\nline-c\n`;
      await writeFile(path, content);
      const before = memory();
      const started = performance.now();
      const result = await readLogTail(path, 3);
      measurement('log_tail_8MiB', started, before, {
        bytes_read: Buffer.byteLength(content),
        bytes_written: 0,
        lines_returned: result.lines.length,
        tail_bytes: result.bytes,
      });
      expect(result.lines).toEqual(['line-a', 'line-b', 'line-c']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.env.RBO_AI_BENCHMARK_1GIB !== '1')(
    'reads the tail of an opt-in 1 GiB spool',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'rbo-ai-log-tail-1gib-'));
      try {
        const path = join(dir, 'stdout.log');
        const chunk = Buffer.alloc(1024 * 1024, 0x78);
        const handle = await open(path, 'w');
        try {
          for (let written = 0; written < 1024 * 1024 * 1024; written += chunk.length) {
            let offset = 0;
            while (offset < chunk.length) {
              const result = await handle.write(chunk.subarray(offset));
              if (result.bytesWritten <= 0) {
                throw new Error('1 GiB benchmark fixture write made no progress');
              }
              offset += result.bytesWritten;
            }
          }
          const suffix = Buffer.from('\nline-a\nline-b\nline-c\n');
          let offset = 0;
          while (offset < suffix.length) {
            const result = await handle.write(suffix.subarray(offset));
            if (result.bytesWritten <= 0) {
              throw new Error('1 GiB benchmark suffix write made no progress');
            }
            offset += result.bytesWritten;
          }
        } finally {
          await handle.close();
        }
        const before = memory();
        const started = performance.now();
        const result = await readLogTail(path, 3);
        measurement('log_tail_1GiB_opt_in', started, before, {
          bytes_read: result.bytes,
          bytes_written: 1024 * 1024 * 1024 + Buffer.byteLength('\nline-a\nline-b\nline-c\n'),
          lines_returned: result.lines.length,
          tail_bytes: result.bytes,
        });
        expect(result.lines).toEqual(['line-a', 'line-b', 'line-c']);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    180_000,
  );

  it('replays alternating stdout/stderr chunks in sequence order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rbo-ai-log-replay-'));
    try {
      const logs = await ensureAttemptLogs(dir);
      const expected: string[] = [];
      let bytesWritten = 0;
      for (let sequence = 1; sequence <= 200; sequence += 1) {
        const stream = sequence % 2 === 0 ? 'stderr' : 'stdout';
        const text = `${stream}-${sequence}\n`;
        expected.push(text);
        bytesWritten += Buffer.byteLength(text);
        await appendIndexedLogChunk(logs, stream, text, sequence);
      }
      const before = memory();
      const started = performance.now();
      const actual: string[] = [];
      const sequences: number[] = [];
      for await (const chunk of iterIndexedChunksAfter(logs, 0)) {
        actual.push(chunk.text);
        sequences.push(chunk.sequence);
      }
      measurement('alternating_log_replay', started, before, {
        bytes_read: bytesWritten,
        bytes_written: bytesWritten,
        chunks: actual.length,
        duplicate_count: actual.length - new Set(sequences).size,
        missing_count: expected.filter((_, i) => sequences[i] !== i + 1).length,
        order_ok: sequences.every((sequence, i) => sequence === i + 1),
      });
      expect(actual).toEqual(expected);
      expect(sequences).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
