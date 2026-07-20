import { appendFile, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type AttemptLogPaths, ensureAttemptLogs } from './logs.js';

export interface ChunkIndexEntry {
  sequence: number;
  stream: 'stdout' | 'stderr';
  byte_offset: number;
  byte_length: number;
}

export interface SpoolChunk {
  sequence: number;
  stream: 'stdout' | 'stderr';
  bytes: string;
}

export interface AttemptSpool {
  dir: string;
  logs: AttemptLogPaths;
  chunksPath: string;
  ackPath: string;
  /** Next sequence to assign (1-based). */
  nextSequence: number;
  /** Running byte offsets per stream (end of file). */
  streamOffsets: { stdout: number; stderr: number };
}

async function readChunksFile(path: string): Promise<ChunkIndexEntry[]> {
  try {
    const content = await readFile(path, 'utf8');
    if (!content.trim()) {
      return [];
    }
    const entries: ChunkIndexEntry[] = [];
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      entries.push(JSON.parse(line) as ChunkIndexEntry);
    }
    return entries;
  } catch {
    return [];
  }
}

export async function openAttemptSpool(spoolDir: string): Promise<AttemptSpool> {
  const logs = await ensureAttemptLogs(spoolDir);
  const chunksPath = join(spoolDir, 'chunks.jsonl');
  const ackPath = join(spoolDir, 'ack.json');

  try {
    await readFile(chunksPath);
  } catch {
    await writeFile(chunksPath, '');
  }
  try {
    await readFile(ackPath);
  } catch {
    await writeFile(ackPath, JSON.stringify({ acked_sequence: 0 }));
  }

  const entries = await readChunksFile(chunksPath);
  let nextSequence = 1;
  const streamOffsets = { stdout: 0, stderr: 0 };
  for (const entry of entries) {
    if (entry.sequence >= nextSequence) {
      nextSequence = entry.sequence + 1;
    }
    const end = entry.byte_offset + entry.byte_length;
    if (end > streamOffsets[entry.stream]) {
      streamOffsets[entry.stream] = end;
    }
  }

  // Prefer live file sizes if they exceed indexed offsets (defensive).
  for (const stream of ['stdout', 'stderr'] as const) {
    const path = stream === 'stdout' ? logs.stdoutPath : logs.stderrPath;
    try {
      const size = (await stat(path)).size;
      if (size > streamOffsets[stream]) {
        streamOffsets[stream] = size;
      }
    } catch {
      // ignore
    }
  }

  return {
    dir: spoolDir,
    logs,
    chunksPath,
    ackPath,
    nextSequence,
    streamOffsets,
  };
}

export async function appendChunk(
  spool: AttemptSpool,
  stream: 'stdout' | 'stderr',
  bytes: string | Buffer,
): Promise<{ sequence: number }> {
  const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
  const sequence = spool.nextSequence;
  const byte_offset = spool.streamOffsets[stream];
  const byte_length = buf.byteLength;

  const path = stream === 'stdout' ? spool.logs.stdoutPath : spool.logs.stderrPath;
  await appendFile(path, buf);

  const entry: ChunkIndexEntry = { sequence, stream, byte_offset, byte_length };
  await appendFile(spool.chunksPath, `${JSON.stringify(entry)}\n`);

  spool.nextSequence = sequence + 1;
  spool.streamOffsets[stream] = byte_offset + byte_length;

  return { sequence };
}

export async function readAck(spool: AttemptSpool): Promise<number> {
  try {
    const raw = await readFile(spool.ackPath, 'utf8');
    const parsed = JSON.parse(raw) as { acked_sequence?: unknown };
    return typeof parsed.acked_sequence === 'number' && Number.isFinite(parsed.acked_sequence)
      ? parsed.acked_sequence
      : 0;
  } catch {
    return 0;
  }
}

export async function writeAck(spool: AttemptSpool, sequence: number): Promise<void> {
  const tmpPath = `${spool.ackPath}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify({ acked_sequence: sequence });
  await writeFile(tmpPath, payload);
  await rename(tmpPath, spool.ackPath);
}

export async function* iterUnacked(
  spool: AttemptSpool,
  afterSequence: number,
): AsyncIterable<SpoolChunk> {
  const entries = await readChunksFile(spool.chunksPath);
  const stdoutContent = await readFile(spool.logs.stdoutPath);
  const stderrContent = await readFile(spool.logs.stderrPath);

  for (const entry of entries) {
    if (entry.sequence <= afterSequence) {
      continue;
    }
    const file = entry.stream === 'stdout' ? stdoutContent : stderrContent;
    const slice = file.subarray(entry.byte_offset, entry.byte_offset + entry.byte_length);
    yield {
      sequence: entry.sequence,
      stream: entry.stream,
      bytes: slice.toString('utf8'),
    };
  }
}

export async function totalBytes(spool: AttemptSpool): Promise<number> {
  let total = 0;
  for (const path of [spool.logs.stdoutPath, spool.logs.stderrPath]) {
    try {
      total += (await stat(path)).size;
    } catch {
      // ignore missing
    }
  }
  return total;
}
