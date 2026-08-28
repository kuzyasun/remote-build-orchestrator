import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type AttemptLogPaths,
  type ChunkIndexEntry,
  ensureAttemptLogs,
  iterChunkIndexEntries,
  iterIndexedChunkBytesAfter,
} from './logs.js';

export type { ChunkIndexEntry };

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

export async function openAttemptSpool(spoolDir: string): Promise<AttemptSpool> {
  const logs = await ensureAttemptLogs(spoolDir);
  const chunksPath = logs.chunksPath;
  const ackPath = join(spoolDir, 'ack.json');

  try {
    let bytesRead = 0;
    let lastNewline = -1;
    let lastByte = -1;
    for await (const chunk of createReadStream(chunksPath)) {
      const data = chunk as Buffer;
      const newline = data.lastIndexOf(0x0a);
      if (newline >= 0) lastNewline = bytesRead + newline;
      bytesRead += data.length;
      lastByte = data[data.length - 1] ?? lastByte;
    }
    if (bytesRead > 0 && lastByte !== 0x0a) {
      await truncate(chunksPath, lastNewline < 0 ? 0 : lastNewline + 1);
    }
  } catch {
    // ensureAttemptLogs normally creates this file; tolerate concurrent cleanup.
  }

  try {
    await readFile(ackPath);
  } catch {
    await writeFile(ackPath, JSON.stringify({ acked_sequence: 0 }));
  }

  let nextSequence = 1;
  const streamOffsets = { stdout: 0, stderr: 0 };
  for await (const entry of iterChunkIndexEntries(logs)) {
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
  const indexOffset = (await stat(spool.chunksPath)).size;
  await appendFile(spool.chunksPath, `${JSON.stringify(entry)}\n`);
  if (sequence % 128 === 0) {
    await appendFile(
      join(spool.dir, 'chunks.checkpoints.jsonl'),
      `${JSON.stringify({ sequence: sequence - 1, byte_offset: indexOffset })}\n`,
    );
  }

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
  // Unique tmp name: concurrent log_acks in the same ms must not share a path
  // (otherwise one rename steals the other's tmp → ENOENT crash on the Agent).
  const payload = JSON.stringify({ acked_sequence: sequence });
  await mkdir(dirname(spool.ackPath), { recursive: true });

  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    const tmpPath = `${spool.ackPath}.${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(tmpPath, payload);
      // Windows cannot always rename over an existing file while another writer
      // races; remove then rename, with retries for residual EPERM/EACCES.
      if (process.platform === 'win32') {
        await rm(spool.ackPath, { force: true }).catch(() => undefined);
      }
      await rename(tmpPath, spool.ackPath);
      return;
    } catch (error) {
      lastError = error;
      await rm(tmpPath, { force: true }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 5 + attempt * 5));
    }
  }
  throw lastError;
}

export async function* iterUnacked(
  spool: AttemptSpool,
  afterSequence: number,
): AsyncIterable<SpoolChunk> {
  for await (const chunk of iterIndexedChunkBytesAfter(spool.logs, afterSequence)) {
    yield {
      sequence: chunk.sequence,
      stream: chunk.stream,
      bytes: chunk.bytes.toString('utf8'),
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
