import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { JobEvent } from '@rbo/protocol';
import { parseJobEventLine } from '@rbo/protocol';

export interface AttemptLogPaths {
  logDir: string;
  stdoutPath: string;
  stderrPath: string;
  eventsPath: string;
}

export async function ensureAttemptLogs(logDir: string): Promise<AttemptLogPaths> {
  await mkdir(logDir, { recursive: true });
  const stdoutPath = join(logDir, 'stdout.log');
  const stderrPath = join(logDir, 'stderr.log');
  const eventsPath = join(logDir, 'events.jsonl');
  for (const path of [stdoutPath, stderrPath, eventsPath]) {
    try {
      await readFile(path);
    } catch {
      await writeFile(path, '');
    }
  }
  return { logDir, stdoutPath, stderrPath, eventsPath };
}

export async function appendStdout(logs: AttemptLogPaths, chunk: string | Buffer): Promise<void> {
  await appendFile(logs.stdoutPath, chunk);
}

export async function appendStderr(logs: AttemptLogPaths, chunk: string | Buffer): Promise<void> {
  await appendFile(logs.stderrPath, chunk);
}

export async function appendEvent(logs: AttemptLogPaths, event: JobEvent): Promise<void> {
  await appendFile(logs.eventsPath, `${JSON.stringify(event)}\n`);
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
