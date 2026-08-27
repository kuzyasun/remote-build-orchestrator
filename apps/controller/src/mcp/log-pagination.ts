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
  positions?: Partial<Record<'stdout' | 'stderr', { seq: number; off: number }>>;
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
type CompactStreamPosition = [number, number];

function compactCursor(
  cursor: LogCursor,
): Omit<LogCursor, 'states' | 'positions'> & { states?: unknown; positions?: unknown } {
  const states = cursor.states;
  const positions = cursor.positions;
  if ((!states || (!states.stdout && !states.stderr)) && !positions) return cursor;
  const safeStates = states ?? {};
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
    states: [encodeState(safeStates.stdout), encodeState(safeStates.stderr)],
    ...(positions
      ? {
          positions: [
            positions.stdout ? [positions.stdout.seq, positions.stdout.off] : null,
            positions.stderr ? [positions.stderr.seq, positions.stderr.off] : null,
          ] as Array<CompactStreamPosition | null>,
        }
      : {}),
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
  const parts = value.split('.');
  if (
    parts.length !== 3 ||
    parts.some(
      (part) => part.length === 0 || Buffer.from(part, 'base64url').toString('base64url') !== part,
    )
  )
    return null;
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
  const positionsValue = (c as { positions?: unknown }).positions;
  const positions: LogCursor['positions'] = Array.isArray(positionsValue)
    ? {
        ...(positionsValue[0]
          ? { stdout: { seq: positionsValue[0][0], off: positionsValue[0][1] } }
          : {}),
        ...(positionsValue[1]
          ? { stderr: { seq: positionsValue[1][0], off: positionsValue[1][1] } }
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
  const positionsValid =
    positionsValue === undefined ||
    (Array.isArray(positionsValue) &&
      positionsValue.length === 2 &&
      positionsValue.every(
        (position: unknown) =>
          position === null ||
          (Array.isArray(position) &&
            position.length === 2 &&
            Number.isSafeInteger(position[0]) &&
            Number.isSafeInteger(position[1]) &&
            position[0] >= 0 &&
            position[1] >= 0),
      ));
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
    !positionsValid ||
    claims.sub !== 'job_logs_cursor' ||
    claims.aud !== 'rbo-controller'
  ) {
    return null;
  }
  return { ...c, states, positions } as LogCursor;
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
  const positions: Partial<Record<'stdout' | 'stderr', { seq: number; off: number }>> = {
    ...(cursor.positions ?? {}),
  };
  const knownPositions = Object.values(positions);
  const firstSequence =
    knownPositions.length > 0
      ? Math.min(cursor.seq, ...knownPositions.map((p) => p.seq))
      : cursor.seq;
  const alreadyConsumed = (entry: ChunkIndexEntry): boolean => {
    const position = positions[entry.stream];
    return Boolean(
      position &&
        (entry.sequence < position.seq ||
          (entry.sequence === position.seq && position.off >= entry.byte_length)),
    );
  };
  const entries: ChunkIndexEntry[] = [];
  for await (const entry of iterChunkIndexEntriesAfter(
    logs,
    firstSequence > 0 ? firstSequence - 1 : 0,
  )) {
    if (alreadyConsumed(entry)) continue;
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
  const blockedStreams = new Set<'stdout' | 'stderr'>();
  let hasPendingIntervening = false;
  for (let index = 0; index < Math.min(128, entries.length); index += 1) {
    if (maxBytes - returned < 4) {
      truncated = true;
      break;
    }
    const entry = entries[index];
    let position = positions[entry.stream];
    if (!position) {
      position = { seq: 0, off: 0 };
      positions[entry.stream] = position;
    }
    if (blockedStreams.has(entry.stream)) continue;
    if (
      entry.sequence < position.seq ||
      (entry.sequence === position.seq && position.off >= entry.byte_length)
    ) {
      continue;
    }
    const startOffset = entry.sequence === position.seq ? position.off : 0;
    const bytes = await readIndexedRange(logs, entry, startOffset);
    if (!bytes) throw new Error('indexed log source is unavailable');
    if (!bytes.length) continue;
    const stream = entry.stream;
    let page = presentLogChunks([bytes], states[stream], {
      maxBytes: maxBytes - returned,
      stripAnsi: true,
    });
    let consumedFromNext = 0;
    let consumedNextEntry: ChunkIndexEntry | undefined;
    const needed = !page.truncated ? utf8ContinuationBytesNeeded(bytes) : 0;
    if (needed > 0 && !page.data.length && page.consumedRawBytes < bytes.length) {
      for (let lookIndex = index + 1; lookIndex < entries.length; lookIndex += 1) {
        const lookEntry = entries[lookIndex];
        if (lookEntry.stream !== stream) {
          hasPendingIntervening = true;
          nextSeq =
            nextSeq === cursor.seq ? lookEntry.sequence : Math.min(nextSeq, lookEntry.sequence);
          continue;
        }
        const look = await readIndexedRange(logs, lookEntry, 0);
        const lookahead = look?.subarray(0, needed);
        if (lookahead?.length !== needed) break;
        page = presentLogChunks([bytes, lookahead], states[stream], {
          maxBytes: maxBytes - returned,
          stripAnsi: true,
        });
        consumedFromNext = Math.max(0, page.consumedRawBytes - bytes.length);
        consumedNextEntry = lookEntry;
        break;
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
    const incomplete = needed > 0 && page.consumedRawBytes < bytes.length && consumedFromNext === 0;
    if (
      (page.consumedRawBytes < bytes.length && consumedNextEntry === undefined) ||
      page.truncated
    ) {
      const consumed = page.consumedRawBytes;
      position.seq = entry.sequence;
      position.off = startOffset + consumed;
      nextSeq = position.seq;
      nextOff = position.off;
      if (!incomplete || page.truncated) {
        truncated = true;
        break;
      }
      blockedStreams.add(stream);
      continue;
    }
    if (consumedFromNext > 0) {
      const nextEntry = consumedNextEntry;
      if (!nextEntry) throw new Error('indexed log source is unavailable');
      position.seq = nextEntry.sequence;
      position.off = consumedFromNext;
      if (!hasPendingIntervening) {
        nextSeq = position.seq;
        nextOff = position.off;
      }
      truncated = consumedFromNext < nextEntry.byte_length;
      if (truncated) break;
    } else {
      position.seq = entry.sequence + 1;
      position.off = 0;
      nextSeq = position.seq;
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
  if (!hasPendingIntervening && nextSeq === cursor.seq) {
    const progressed = Object.values(positions)
      .map((position) => position?.seq ?? cursor.seq)
      .filter((seq) => seq >= cursor.seq);
    if (progressed.length > 0) nextSeq = Math.min(...progressed);
  }
  return {
    chunks: output,
    next: {
      ...cursor,
      seq: nextSeq,
      off: nextOff,
      states: Object.keys(compactStates).length > 0 ? compactStates : undefined,
      positions,
    },
    returned,
    hasMore: truncated || entries.length > 128,
    truncated,
  };
}
