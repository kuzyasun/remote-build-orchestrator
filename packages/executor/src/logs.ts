import { createReadStream } from 'node:fs';
import { access, appendFile, mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JobEvent } from '@rbo/protocol';
import { parseJobEventLine } from '@rbo/protocol';

export interface AttemptLogPaths {
  logDir: string;
  stdoutPath: string;
  stderrPath: string;
  eventsPath: string;
  chunksPath: string;
  /** Sparse index accelerator; older callers may omit it and use the derived path. */
  chunksCheckpointPath?: string;
}

interface ChunkIndexCheckpoint {
  sequence: number;
  byte_offset: number;
}

const CHUNK_CHECKPOINT_INTERVAL = 128;
const MAX_CHECKPOINT_LINE_BYTES = 64 * 1024;

function checkpointPath(logs: AttemptLogPaths): string {
  return logs.chunksCheckpointPath ?? join(logs.logDir, 'chunks.checkpoints.jsonl');
}

/** Ordered stdout/stderr chunk index beside durable log files (Controller + Agent spool). */
export interface ChunkIndexEntry {
  sequence: number;
  stream: 'stdout' | 'stderr';
  byte_offset: number;
  byte_length: number;
}

// Corrupt JSONL tails are discarded after this bound so replay never retains
// an unbounded unterminated record in memory.
const MAX_INDEX_LINE_BYTES = 1024 * 1024;

export async function ensureAttemptLogs(logDir: string): Promise<AttemptLogPaths> {
  await mkdir(logDir, { recursive: true });
  const stdoutPath = join(logDir, 'stdout.log');
  const stderrPath = join(logDir, 'stderr.log');
  const eventsPath = join(logDir, 'events.jsonl');
  const chunksPath = join(logDir, 'chunks.jsonl');
  const chunksCheckpointPath = join(logDir, 'chunks.checkpoints.jsonl');
  for (const path of [stdoutPath, stderrPath, eventsPath, chunksPath, chunksCheckpointPath]) {
    try {
      await access(path);
    } catch {
      await writeFile(path, '');
    }
  }
  return { logDir, stdoutPath, stderrPath, eventsPath, chunksPath, chunksCheckpointPath };
}

export async function appendStdout(logs: AttemptLogPaths, chunk: string | Buffer): Promise<void> {
  await appendFile(logs.stdoutPath, chunk);
}

export async function appendStderr(logs: AttemptLogPaths, chunk: string | Buffer): Promise<void> {
  await appendFile(logs.stderrPath, chunk);
}

export async function appendLogChunk(
  logs: AttemptLogPaths,
  stream: 'stdout' | 'stderr',
  chunk: string | Buffer,
): Promise<void> {
  if (stream === 'stderr') {
    await appendStderr(logs, chunk);
  } else {
    await appendStdout(logs, chunk);
  }
}

/**
 * Legacy fallback helper to determine stream file offset via stat().
 * Preferred path is in-memory offset tracking passed to appendIndexedLogChunk.
 */
async function streamByteOffset(
  logs: AttemptLogPaths,
  stream: 'stdout' | 'stderr',
): Promise<number> {
  const path = stream === 'stdout' ? logs.stdoutPath : logs.stderrPath;
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/**
 * Append a log chunk and a matching chunks.jsonl index entry with an explicit
 * sequence (Agent-assigned for remote jobs; Controller-assigned for local).
 * Durable write order: stream file first, then index line.
 */
export async function appendIndexedLogChunk(
  logs: AttemptLogPaths,
  stream: 'stdout' | 'stderr',
  chunk: string | Buffer,
  sequence: number,
  streamOffset?: number,
): Promise<{ entry: ChunkIndexEntry; text: string }> {
  const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
  // Legacy fallback: stat() the stream file if the caller did not supply
  // an in-memory stream offset.
  const byte_offset = streamOffset ?? (await streamByteOffset(logs, stream));
  const byte_length = buf.byteLength;
  const previous = await readLastChunkSequence(logs);
  if (sequence <= previous) {
    throw new Error(
      `Chunk sequence must increase monotonically (previous=${previous}, next=${sequence})`,
    );
  }
  await appendLogChunk(logs, stream, buf);
  const entry: ChunkIndexEntry = { sequence, stream, byte_offset, byte_length };
  const indexOffset = (await stat(logs.chunksPath)).size;
  await appendFile(logs.chunksPath, `${JSON.stringify(entry)}\n`);
  // The checkpoint is an accelerator only. Publish it after its index record
  // is durable so a checkpoint can never point past the canonical index.
  if (sequence % CHUNK_CHECKPOINT_INTERVAL === 0) {
    const checkpoint: ChunkIndexCheckpoint = {
      sequence: sequence - 1,
      byte_offset: indexOffset,
    };
    await appendFile(checkpointPath(logs), `${JSON.stringify(checkpoint)}\n`);
  }
  return { entry, text: buf.toString('utf8') };
}

export async function readLastChunkSequence(logs: AttemptLogPaths): Promise<number> {
  let previous = 0;
  // Reuse the sparse seek path after restart. If its newest checkpoint is
  // invalid, the iterator safely falls back to the canonical index scan.
  for await (const entry of iterChunkIndexEntriesFrom(logs, 0, Number.MAX_SAFE_INTEGER)) {
    previous = entry.sequence;
  }
  return previous;
}

export async function readChunkIndexEntries(logs: AttemptLogPaths): Promise<ChunkIndexEntry[]> {
  const entries: ChunkIndexEntry[] = [];
  for await (const entry of iterChunkIndexEntries(logs)) entries.push(entry);
  return entries;
}

/** Stream durable index records in file order; the writer invariant is increasing sequence. */
export async function* iterChunkIndexEntries(
  logs: AttemptLogPaths,
): AsyncIterable<ChunkIndexEntry> {
  yield* iterChunkIndexEntriesFrom(logs, 0, 0);
}

async function findChunkCheckpoint(
  logs: AttemptLogPaths,
  afterSequence: number,
  indexSize: number,
): Promise<ChunkIndexCheckpoint | undefined> {
  let candidate: ChunkIndexCheckpoint | undefined;
  let pending = '';
  try {
    for await (const chunk of createReadStream(checkpointPath(logs), { encoding: 'utf8' })) {
      pending += chunk;
      if (pending.length > MAX_CHECKPOINT_LINE_BYTES) {
        const newline = pending.indexOf('\n');
        if (newline < 0) {
          pending = '';
          continue;
        }
        pending = pending.slice(newline + 1);
      }
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as Partial<ChunkIndexCheckpoint>;
          if (
            typeof parsed.sequence !== 'number' ||
            !Number.isSafeInteger(parsed.sequence) ||
            parsed.sequence < 0 ||
            parsed.sequence > afterSequence ||
            typeof parsed.byte_offset !== 'number' ||
            !Number.isSafeInteger(parsed.byte_offset) ||
            parsed.byte_offset < 0 ||
            parsed.byte_offset > indexSize ||
            (candidate && parsed.sequence <= candidate.sequence)
          ) {
            continue;
          }
          candidate = parsed as ChunkIndexCheckpoint;
        } catch {
          // Checkpoint corruption is non-fatal; canonical index remains truth.
        }
      }
    }
  } catch {
    return undefined;
  }
  // Checkpoints are append-ordered, so retaining only the newest candidate
  // keeps metadata memory bounded. A corrupt newest candidate intentionally
  // falls back to the canonical index rather than retaining older candidates.
  if (candidate) {
    try {
      const handle = await open(logs.chunksPath, 'r');
      try {
        const probe = Buffer.alloc(4096);
        const result = await handle.read(probe, 0, probe.length, candidate.byte_offset);
        const line = probe.subarray(0, result.bytesRead).toString('utf8').split('\n', 1)[0];
        const parsed = JSON.parse(line) as Partial<ChunkIndexEntry>;
        if (parsed.sequence === candidate.sequence + 1) return candidate;
      } finally {
        await handle.close();
      }
    } catch {
      // Malformed offsets are accelerator misses; canonical scan is safe.
    }
  }
  return undefined;
}

async function* iterChunkIndexEntriesFrom(
  logs: AttemptLogPaths,
  afterSequence: number,
  checkpointSequence: number,
): AsyncIterable<ChunkIndexEntry> {
  try {
    const streamSizes = {
      stdout: (await stat(logs.stdoutPath)).size,
      stderr: (await stat(logs.stderrPath)).size,
    };
    let pending = '';
    let discarding = false;
    const indexSize = (await stat(logs.chunksPath)).size;
    const checkpointBound = checkpointSequence > 0 ? checkpointSequence : afterSequence;
    const checkpoint =
      checkpointBound > 0 ? await findChunkCheckpoint(logs, checkpointBound, indexSize) : undefined;
    const start = checkpoint?.byte_offset ?? 0;
    let previousSequence = checkpoint?.sequence ?? 0;
    for await (const chunk of createReadStream(logs.chunksPath, {
      encoding: 'utf8',
      ...(start > 0 ? { start } : {}),
    })) {
      if (discarding) {
        const newline = chunk.indexOf('\n');
        if (newline < 0) continue;
        discarding = false;
        pending = chunk.slice(newline + 1);
      } else {
        pending += chunk;
      }
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as Partial<ChunkIndexEntry>;
          if (
            (parsed.stream !== 'stdout' && parsed.stream !== 'stderr') ||
            typeof parsed.sequence !== 'number' ||
            !Number.isSafeInteger(parsed.sequence) ||
            parsed.sequence < 1 ||
            typeof parsed.byte_offset !== 'number' ||
            !Number.isSafeInteger(parsed.byte_offset) ||
            parsed.byte_offset < 0 ||
            typeof parsed.byte_length !== 'number' ||
            !Number.isSafeInteger(parsed.byte_length) ||
            parsed.byte_length < 0 ||
            parsed.byte_offset > Number.MAX_SAFE_INTEGER - parsed.byte_length ||
            parsed.byte_offset + parsed.byte_length > streamSizes[parsed.stream] ||
            parsed.sequence <= previousSequence
          ) {
            continue;
          }
          previousSequence = parsed.sequence;
          if (parsed.sequence > afterSequence) yield parsed as ChunkIndexEntry;
        } catch {
          // Ignore malformed lines, including a crash-truncated index tail.
        }
      }
      if (pending.length > MAX_INDEX_LINE_BYTES) {
        pending = '';
        discarding = true;
      }
    }
    // An unterminated final line is a crash tail and intentionally ignored.
  } catch {
    return;
  }
}

/** Stream durable index records strictly after a sequence, seeking via sparse checkpoints. */
export async function* iterChunkIndexEntriesAfter(
  logs: AttemptLogPaths,
  afterSequence: number,
): AsyncIterable<ChunkIndexEntry> {
  yield* iterChunkIndexEntriesFrom(logs, afterSequence, afterSequence);
}

/**
 * Read only the bounded suffix of the durable chunk index. This is intended for
 * diagnostic tails, where replaying the complete historical index would make a
 * small response O(total chunks).
 */
export async function readChunkIndexTail(
  logs: AttemptLogPaths,
  maxEntries: number,
): Promise<ChunkIndexEntry[]> {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) return [];
  try {
    const streamSizes = {
      stdout: (await stat(logs.stdoutPath)).size,
      stderr: (await stat(logs.stderrPath)).size,
    };
    const indexSize = (await stat(logs.chunksPath)).size;
    const handle = await open(logs.chunksPath, 'r');
    try {
      const entries: ChunkIndexEntry[] = [];
      const blockSize = 64 * 1024;
      let position = indexSize;
      let pending = '';
      while (position > 0 && entries.length < maxEntries) {
        const start = Math.max(0, position - blockSize);
        const buffer = Buffer.alloc(position - start);
        const result = await handle.read(buffer, 0, buffer.length, start);
        if (result.bytesRead === 0) break;
        pending = buffer.subarray(0, result.bytesRead).toString('utf8') + pending;
        const lines = pending.split('\n');
        if (start === 0) {
          // The first split element is a complete JSONL record, not a partial prefix.
          pending = '';
        } else {
          pending = lines.shift() ?? '';
        }
        for (let index = lines.length - 1; index >= 0 && entries.length < maxEntries; index -= 1) {
          const line = lines[index].trim();
          if (!line) continue;
          try {
            const parsed = JSON.parse(line) as Partial<ChunkIndexEntry>;
            if (
              (parsed.stream !== 'stdout' && parsed.stream !== 'stderr') ||
              typeof parsed.sequence !== 'number' ||
              !Number.isSafeInteger(parsed.sequence) ||
              parsed.sequence < 1 ||
              typeof parsed.byte_offset !== 'number' ||
              !Number.isSafeInteger(parsed.byte_offset) ||
              parsed.byte_offset < 0 ||
              typeof parsed.byte_length !== 'number' ||
              !Number.isSafeInteger(parsed.byte_length) ||
              parsed.byte_length < 0 ||
              parsed.byte_offset > Number.MAX_SAFE_INTEGER - parsed.byte_length ||
              parsed.byte_offset + parsed.byte_length > streamSizes[parsed.stream]
            ) {
              continue;
            }
            entries.push(parsed as ChunkIndexEntry);
          } catch {
            // Ignore malformed or crash-truncated records in the suffix.
          }
        }
        position = start;
      }
      return entries.reverse();
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
}

async function readIndexedBytes(path: string, entry: ChunkIndexEntry): Promise<Buffer | undefined> {
  if (entry.byte_length === 0) return Buffer.alloc(0);
  try {
    const size = (await stat(path)).size;
    const end = entry.byte_offset + entry.byte_length;
    if (end > size) return undefined;
    const handle = await open(path, 'r');
    try {
      const result = Buffer.allocUnsafe(entry.byte_length);
      let total = 0;
      while (total < result.length) {
        const read = await handle.read(
          result,
          total,
          result.length - total,
          entry.byte_offset + total,
        );
        if (read.bytesRead === 0) return undefined;
        total += read.bytesRead;
      }
      return result;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/** Replay ordered stdout/stderr chunks after `afterSequence` (inclusive exclusive). */
export async function* iterIndexedChunksAfter(
  logs: AttemptLogPaths,
  afterSequence: number,
): AsyncIterable<{ sequence: number; stream: 'stdout' | 'stderr'; text: string }> {
  for await (const chunk of iterIndexedChunkBytesAfter(logs, afterSequence)) {
    yield { sequence: chunk.sequence, stream: chunk.stream, text: chunk.bytes.toString('utf8') };
  }
}

export async function* iterIndexedChunkBytesAfter(
  logs: AttemptLogPaths,
  afterSequence: number,
): AsyncIterable<{ sequence: number; stream: 'stdout' | 'stderr'; bytes: Buffer }> {
  for await (const entry of iterChunkIndexEntriesAfter(logs, afterSequence)) {
    const path = entry.stream === 'stdout' ? logs.stdoutPath : logs.stderrPath;
    const slice = await readIndexedBytes(path, entry);
    if (slice) yield { sequence: entry.sequence, stream: entry.stream, bytes: slice };
  }
}

export async function appendEvent(logs: AttemptLogPaths, event: JobEvent): Promise<void> {
  await appendFile(logs.eventsPath, `${JSON.stringify(event)}\n`);
}

export async function nextEventSequence(logs: AttemptLogPaths): Promise<number> {
  const { events } = await readEventsFromCursor(logs, 0, Number.MAX_SAFE_INTEGER);
  let maxSeq = 0;
  for (const event of events) {
    if (event.sequence > maxSeq) {
      maxSeq = event.sequence;
    }
  }
  return maxSeq + 1;
}

export async function readLogTail(
  path: string,
  maxLines: number,
): Promise<{ lines: string[]; bytes: number }> {
  if (maxLines <= 0) {
    return { lines: [], bytes: 0 };
  }
  const content = await readFile(path, 'utf8');
  const lines = content.length > 0 ? content.split(/\r?\n/).filter((line) => line.length > 0) : [];
  const tail = lines.slice(-maxLines);
  return { lines: tail, bytes: Buffer.byteLength(content, 'utf8') };
}

export async function readLogsFromCursor(
  paths: AttemptLogPaths,
  cursor: number,
  maxBytes: number,
  streams: Array<'stdout' | 'stderr'>,
): Promise<{ data: string; nextCursor: number }> {
  const chunks: string[] = [];
  let offset = 0;
  let consumed = 0;

  for (const stream of streams) {
    const path = stream === 'stdout' ? paths.stdoutPath : paths.stderrPath;
    const content = await readFile(path, 'utf8');
    const streamBytes = Buffer.byteLength(content, 'utf8');
    if (offset + streamBytes <= cursor) {
      offset += streamBytes;
      continue;
    }
    const start = Math.max(0, cursor - offset);
    const slice = content.slice(start);
    const sliceBytes = Buffer.byteLength(slice, 'utf8');
    if (consumed + sliceBytes > maxBytes) {
      const allowed = slice.slice(0, maxBytes - consumed);
      chunks.push(allowed);
      consumed = maxBytes;
      break;
    }
    chunks.push(slice);
    consumed += sliceBytes;
    offset += streamBytes;
  }

  return { data: chunks.join(''), nextCursor: cursor + consumed };
}

export async function readEventsFromCursor(
  paths: AttemptLogPaths,
  cursor: number,
  maxEvents: number,
): Promise<{ events: JobEvent[]; nextCursor: number }> {
  const content = await readFile(paths.eventsPath, 'utf8');
  const lines = content.length > 0 ? content.split(/\r?\n/).filter((line) => line.length > 0) : [];
  const events: JobEvent[] = [];
  let index = cursor;

  while (index < lines.length && events.length < maxEvents) {
    const event = parseJobEventLine(lines[index] ?? '');
    if (event) {
      events.push(event);
    }
    index += 1;
  }

  return { events, nextCursor: index };
}
