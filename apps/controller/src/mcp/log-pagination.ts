import { type FileHandle, open, stat } from 'node:fs/promises';
import { iterChunkIndexEntriesAfter, presentLogChunks } from '@rbo/executor';
import type { AttemptLogPaths, ChunkIndexEntry, LogPresentationState } from '@rbo/executor';
import type { ControllerIdentity } from '@rbo/shared';
import { signEdDsaJwt, verifyEdDsaJwt } from '@rbo/shared';

export type LogCursor = {
  v: 1;
  job: string;
  attempt: string;
  mode: 'logs' | 'events';
  seq: number;
  off: number;
  profile: 'ansi-v1';
  /** Parser carry is scoped to each durable stream; stdout controls must not affect stderr. */
  states?: Partial<Record<'stdout' | 'stderr', LogPresentationState>>;
};

const PRESENTATION_MODES: readonly LogPresentationState['mode'][] = [
  'ground',
  'escape',
  'csi',
  'osc',
  'oscEscape',
  'discard',
];
type CompactPresentationState = [number, number, number, number];

function compactCursor(cursor: LogCursor): Omit<LogCursor, 'states'> & { states?: unknown } {
  const states = cursor.states;
  if (!states || (!states.stdout && !states.stderr)) return cursor;
  const encodeState = (state: LogPresentationState | undefined): CompactPresentationState | null =>
    state
      ? [
          PRESENTATION_MODES.indexOf(state.mode),
          state.csiLength,
          state.oscLength,
          state.controlLength,
        ]
      : null;
  return {
    ...cursor,
    states: [encodeState(states.stdout), encodeState(states.stderr)],
  };
}

export function encodeCursor(identity: ControllerIdentity, cursor: LogCursor): string | null {
  const token = signEdDsaJwt(identity.signingPrivateKeyPem, {
    sub: 'job_logs_cursor',
    aud: 'rbo-controller',
    exp: 4102444800,
    cursor: compactCursor(cursor),
  });
  return token.length <= 512 ? token : null;
}

export function decodeCursor(identity: ControllerIdentity, value: string): LogCursor | null {
  if (value.length > 512) return null;
  const claims = verifyEdDsaJwt(identity.signingPublicKeyPem, value);
  const candidate = claims?.cursor;
  if (!claims || !candidate || typeof candidate !== 'object') return null;
  const c = candidate as Partial<LogCursor> & { states?: unknown };
  const statesValue = c.states;
  const states: LogCursor['states'] = Array.isArray(statesValue)
    ? {
        ...(statesValue[0]
          ? {
              stdout: {
                mode: PRESENTATION_MODES[statesValue[0][0] as number],
                csiLength: statesValue[0][1] as number,
                oscLength: statesValue[0][2] as number,
                controlLength: statesValue[0][3] as number,
              },
            }
          : {}),
        ...(statesValue[1]
          ? {
              stderr: {
                mode: PRESENTATION_MODES[statesValue[1][0] as number],
                csiLength: statesValue[1][1] as number,
                oscLength: statesValue[1][2] as number,
                controlLength: statesValue[1][3] as number,
              },
            }
          : {}),
      }
    : undefined;
  const allowedModes = new Set(PRESENTATION_MODES);
  const stateValid =
    statesValue === undefined ||
    (typeof states === 'object' &&
      states !== null &&
      Object.keys(states).every((stream) => {
        if (stream !== 'stdout' && stream !== 'stderr') return false;
        const state = states[stream as 'stdout' | 'stderr'];
        return (
          typeof state === 'object' &&
          state !== null &&
          allowedModes.has(state.mode) &&
          Number.isSafeInteger(state.csiLength) &&
          Number.isSafeInteger(state.oscLength) &&
          Number.isSafeInteger(state.controlLength) &&
          state.csiLength >= 0 &&
          state.csiLength <= 4096 &&
          state.oscLength >= 0 &&
          state.oscLength <= 4096 &&
          state.controlLength >= 0 &&
          state.controlLength <= 4096
        );
      }));
  if (
    c.v !== 1 ||
    typeof c.job !== 'string' ||
    typeof c.attempt !== 'string' ||
    (c.mode !== 'logs' && c.mode !== 'events') ||
    !Number.isSafeInteger(c.seq) ||
    (c.seq ?? -1) < 0 ||
    !Number.isSafeInteger(c.off) ||
    (c.off ?? -1) < 0 ||
    c.profile !== 'ansi-v1' ||
    !stateValid ||
    claims.sub !== 'job_logs_cursor' ||
    claims.aud !== 'rbo-controller'
  ) {
    return null;
  }
  return { ...c, states } as LogCursor;
}

export async function readIndexedRange(
  logs: AttemptLogPaths,
  entry: ChunkIndexEntry,
  offset: number,
): Promise<Buffer | undefined> {
  const path = entry.stream === 'stdout' ? logs.stdoutPath : logs.stderrPath;
  if (offset >= entry.byte_length) return Buffer.alloc(0);
  let handle: FileHandle;
  try {
    handle = await open(path, 'r');
  } catch {
    return undefined;
  }
  try {
    const result = Buffer.alloc(Math.min(entry.byte_length - offset, 1024 * 1024));
    let total = 0;
    while (total < result.length) {
      const read = await handle.read(
        result,
        total,
        result.length - total,
        entry.byte_offset + offset + total,
      );
      if (read.bytesRead === 0) return undefined;
      total += read.bytesRead;
    }
    return result;
  } finally {
    await handle.close();
  }
}

function utf8ContinuationBytesNeeded(bytes: Buffer): number {
  let index = bytes.length - 1;
  let continuation = 0;
  while (index >= 0 && bytes[index] >= 0x80 && bytes[index] <= 0xbf) {
    continuation += 1;
    index -= 1;
  }
  if (index < 0) return 0;
  const lead = bytes[index];
  const width = lead < 0x80 ? 1 : lead <= 0xdf ? 2 : lead <= 0xef ? 3 : lead <= 0xf4 ? 4 : 1;
  const available = bytes.length - index;
  return width > 1 && available < width ? width - available : 0;
}

export async function readJobLogsPage(logs: AttemptLogPaths, cursor: LogCursor, maxBytes: number) {
  try {
    if ((await stat(logs.chunksPath)).size > 0) {
      await stat(logs.stdoutPath);
      await stat(logs.stderrPath);
    }
  } catch {
    throw new Error('indexed log source is unavailable');
  }
  const entries: ChunkIndexEntry[] = [];
  for await (const entry of iterChunkIndexEntriesAfter(logs, cursor.seq > 0 ? cursor.seq - 1 : 0)) {
    entries.push(entry);
    if (entries.length >= 129) break;
  }
  const output: Array<{ sequence: number; stream: string; text: string; complete: boolean }> = [];
  const states: Partial<Record<'stdout' | 'stderr', LogPresentationState>> = {
    ...(cursor.states ?? {}),
  };
  let returned = 0;
  let nextSeq = cursor.seq;
  let nextOff = cursor.off;
  let truncated = false;
  for (let index = 0; index < Math.min(128, entries.length); index += 1) {
    if (maxBytes - returned < 4) {
      truncated = true;
      break;
    }
    const entry = entries[index];
    const startOffset = entry.sequence === cursor.seq ? cursor.off : 0;
    const bytes = await readIndexedRange(logs, entry, startOffset);
    if (!bytes) throw new Error('indexed log source is unavailable');
    if (!bytes.length) continue;
    const stream = entry.stream;
    let page = presentLogChunks([bytes], states[stream], {
      maxBytes: maxBytes - returned,
      stripAnsi: true,
    });
    let consumedFromNext = 0;
    if (
      !page.data.length &&
      !page.truncated &&
      page.consumedRawBytes < bytes.length &&
      index + 1 < entries.length
    ) {
      const needed = utf8ContinuationBytesNeeded(bytes);
      const look =
        needed > 0 && entries[index + 1].stream === stream
          ? await readIndexedRange(logs, entries[index + 1], 0)
          : undefined;
      const lookahead = look?.subarray(0, needed);
      if (lookahead?.length) {
        page = presentLogChunks([bytes, lookahead], states[stream], {
          maxBytes: maxBytes - returned,
          stripAnsi: true,
        });
        consumedFromNext = Math.max(0, page.consumedRawBytes - bytes.length);
      }
    }
    states[stream] = page.state;
    if (page.data.length) {
      output.push({
        sequence: entry.sequence,
        stream: entry.stream,
        text: page.data.toString('utf8'),
        complete:
          page.consumedRawBytes >= bytes.length && bytes.length === entry.byte_length - startOffset,
      });
      returned += page.data.length;
    }
    if (page.consumedRawBytes < bytes.length || page.truncated) {
      nextSeq = entry.sequence;
      nextOff = startOffset + page.consumedRawBytes;
      truncated = true;
      break;
    }
    if (consumedFromNext > 0) {
      nextSeq = entries[index + 1].sequence;
      nextOff = consumedFromNext;
      truncated = consumedFromNext < entries[index + 1].byte_length;
      if (truncated) break;
      index += 1;
      nextSeq = entries[index].sequence + 1;
      nextOff = 0;
    } else {
      nextSeq = entry.sequence + 1;
      nextOff = 0;
    }
  }
  const compactStates: Partial<Record<'stdout' | 'stderr', LogPresentationState>> = {};
  for (const stream of ['stdout', 'stderr'] as const) {
    const state = states[stream];
    if (state && state.mode !== 'ground') {
      compactStates[stream] = state;
    }
  }
  return {
    chunks: output,
    next: {
      ...cursor,
      seq: nextSeq,
      off: nextOff,
      states: Object.keys(compactStates).length > 0 ? compactStates : undefined,
    },
    returned,
    hasMore: truncated || entries.length > 128,
    truncated,
  };
}
