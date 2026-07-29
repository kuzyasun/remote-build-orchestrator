import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JobEvent } from '@rbo/protocol';
import { parseJobEventLine } from '@rbo/protocol';

export interface AttemptLogPaths {
  logDir: string;
  stdoutPath: string;
  stderrPath: string;
  eventsPath: string;
  chunksPath: string;
}

/** Ordered stdout/stderr chunk index beside durable log files (Controller + Agent spool). */
export interface ChunkIndexEntry {
  sequence: number;
  stream: 'stdout' | 'stderr';
  byte_offset: number;
  byte_length: number;
}

export async function ensureAttemptLogs(logDir: string): Promise<AttemptLogPaths> {
  await mkdir(logDir, { recursive: true });
  const stdoutPath = join(logDir, 'stdout.log');
  const stderrPath = join(logDir, 'stderr.log');
  const eventsPath = join(logDir, 'events.jsonl');
  const chunksPath = join(logDir, 'chunks.jsonl');
  for (const path of [stdoutPath, stderrPath, eventsPath, chunksPath]) {
    try {
      await readFile(path);
    } catch {
      await writeFile(path, '');
    }
  }
  return { logDir, stdoutPath, stderrPath, eventsPath, chunksPath };
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
): Promise<{ entry: ChunkIndexEntry; text: string }> {
  const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
  const byte_offset = await streamByteOffset(logs, stream);
  const byte_length = buf.byteLength;
  await appendLogChunk(logs, stream, buf);
  const entry: ChunkIndexEntry = { sequence, stream, byte_offset, byte_length };
  await appendFile(logs.chunksPath, `${JSON.stringify(entry)}\n`);
  return { entry, text: buf.toString('utf8') };
}

export async function readChunkIndexEntries(logs: AttemptLogPaths): Promise<ChunkIndexEntry[]> {
  try {
    const content = await readFile(logs.chunksPath, 'utf8');
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

/** Replay ordered stdout/stderr chunks after `afterSequence` (inclusive exclusive). */
export async function* iterIndexedChunksAfter(
  logs: AttemptLogPaths,
  afterSequence: number,
): AsyncIterable<{ sequence: number; stream: 'stdout' | 'stderr'; text: string }> {
  const entries = await readChunkIndexEntries(logs);
  const stdoutContent = await readFile(logs.stdoutPath);
  const stderrContent = await readFile(logs.stderrPath);
  for (const entry of entries) {
    if (entry.sequence <= afterSequence) {
      continue;
    }
    const file = entry.stream === 'stdout' ? stdoutContent : stderrContent;
    const slice = file.subarray(entry.byte_offset, entry.byte_offset + entry.byte_length);
    yield {
      sequence: entry.sequence,
      stream: entry.stream,
      text: slice.toString('utf8'),
    };
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
