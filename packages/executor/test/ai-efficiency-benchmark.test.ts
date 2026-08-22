import { mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendIndexedLogChunk,
  ensureAttemptLogs,
  iterIndexedChunkBytesAfter,
  iterIndexedChunksAfter,
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
  it('reads one indexed page near the end of an 8 MiB spool', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rbo-ai-log-tail-'));
    try {
      const logs = await ensureAttemptLogs(dir);
      const chunkBytes = 1024;
      const chunkCount = (8 * 1024 * 1024) / chunkBytes;
      const entries: string[] = [];
      const checkpoints: string[] = [];
      let indexOffset = 0;
      for (let sequence = 1; sequence <= chunkCount; sequence += 1) {
        if (sequence % 128 === 0) {
          checkpoints.push(
            `${JSON.stringify({ sequence: sequence - 1, byte_offset: indexOffset })}\n`,
          );
        }
        const line = `${JSON.stringify({
          sequence,
          stream: 'stdout',
          byte_offset: (sequence - 1) * chunkBytes,
          byte_length: chunkBytes,
        })}\n`;
        entries.push(line);
        indexOffset += Buffer.byteLength(line, 'utf8');
      }
      await writeFile(logs.stdoutPath, Buffer.alloc(8 * 1024 * 1024, 0x78));
      await writeFile(logs.chunksPath, entries.join(''));
      await writeFile(logs.chunksCheckpointPath as string, checkpoints.join(''));

      const afterSequence = chunkCount - 128;
      const checkpoint = JSON.parse(
        checkpoints.find((line) => JSON.parse(line).sequence === afterSequence - 1) as string,
      ) as { byte_offset: number };
      const [indexSize, checkpointSize] = await Promise.all([
        stat(logs.chunksPath).then((result) => result.size),
        stat(logs.chunksCheckpointPath as string).then((result) => result.size),
      ]);
      const before = memory();
      const started = performance.now();
      const page: Array<{ sequence: number; stream: string; text: string }> = [];
      for await (const chunk of iterIndexedChunkBytesAfter(logs, afterSequence)) {
        page.push({
          sequence: chunk.sequence,
          stream: chunk.stream,
          text: chunk.bytes.toString('utf8'),
        });
      }
      const response = {
        job_id: 'job_benchmark',
        attempt_id: 'att_benchmark',
        mode: 'logs',
        chunks: page,
        returned_bytes: page.reduce(
          (total, chunk) => total + Buffer.byteLength(chunk.text, 'utf8'),
          0,
        ),
        has_more: false,
        truncated: false,
      };
      const responseJsonBytes = Buffer.byteLength(JSON.stringify(response), 'utf8');
      measurement('indexed_log_page_8MiB', started, before, {
        bytes_read_upper_bound:
          checkpointSize + (indexSize - checkpoint.byte_offset) + response.returned_bytes,
        bytes_written: 0,
        checkpoint_bytes_scanned: checkpointSize,
        index_bytes_scanned_upper_bound: indexSize - checkpoint.byte_offset,
        payload_bytes_read: response.returned_bytes,
        response_json_bytes: responseJsonBytes,
        chunks_returned: page.length,
        comparison: {
          mode: 'head_only',
          baseline_available: false,
          historical_delta_available: false,
          reason: 'The removed whole-file readLogTail fixture is not a reproducible baseline.',
        },
      });
      expect(page).toHaveLength(128);
      expect(response.returned_bytes).toBe(128 * chunkBytes);
      expect(indexSize - checkpoint.byte_offset).toBeLessThan(16 * 1024);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.env.RBO_AI_BENCHMARK_1GIB !== '1')(
    'reads one indexed page near the end of an opt-in 1 GiB spool',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'rbo-ai-log-tail-1gib-'));
      try {
        const logs = await ensureAttemptLogs(dir);
        const chunk = Buffer.alloc(1024 * 1024, 0x78);
        const handle = await open(logs.stdoutPath, 'w');
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
        } finally {
          await handle.close();
        }
        const tailBytes = 1024;
        const entry = {
          sequence: 1,
          stream: 'stdout',
          byte_offset: 1024 * 1024 * 1024 - tailBytes,
          byte_length: tailBytes,
        };
        await writeFile(logs.chunksPath, `${JSON.stringify(entry)}\n`);
        const before = memory();
        const started = performance.now();
        const page: Array<{ sequence: number; stream: string; text: string }> = [];
        for await (const indexedChunk of iterIndexedChunkBytesAfter(logs, 0)) {
          page.push({
            sequence: indexedChunk.sequence,
            stream: indexedChunk.stream,
            text: indexedChunk.bytes.toString('utf8'),
          });
        }
        const responseJsonBytes = Buffer.byteLength(JSON.stringify({ chunks: page }), 'utf8');
        measurement('indexed_log_page_1GiB_opt_in', started, before, {
          bytes_read_upper_bound: tailBytes + Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1,
          bytes_written: 1024 * 1024 * 1024,
          payload_bytes_read: tailBytes,
          response_json_bytes: responseJsonBytes,
          chunks_returned: page.length,
          comparison: {
            mode: 'head_only',
            baseline_available: false,
            historical_delta_available: false,
            reason: 'The removed whole-file readLogTail fixture is not a reproducible baseline.',
          },
        });
        expect(page).toHaveLength(1);
        expect(Buffer.byteLength(page[0]?.text ?? '', 'utf8')).toBe(tailBytes);
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
