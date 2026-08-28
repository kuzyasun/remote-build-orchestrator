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
const INDEX_READ_CAP = 1024 * 1024;
const PAGE_RAW_SCAN_CAP = 1024 * 1024;
type CompactPresentationState = [number, number, number, number];
type CompactStreamPosition = [number, number];
type PackedStreamPair<T> = 0 | [T | null, T | null];
type PackedCursor = [
  1,
  string,
  string,
  0 | 1,
  number,
  number,
  PackedStreamPair<CompactPresentationState>,
  PackedStreamPair<CompactStreamPosition>,
];

function encodeState(state: LogPresentationState | undefined): CompactPresentationState | null {
  return state
    ? [
        PRESENTATION_MODES.indexOf(state.mode),
        state.csiLength,
        state.oscLength,
        state.controlLength,
      ]
    : null;
}

function packCursor(cursor: LogCursor): PackedCursor {
  const states = cursor.states;
  const positions = cursor.positions;
  const packedStates: PackedStreamPair<CompactPresentationState> =
    states?.stdout || states?.stderr
      ? [encodeState(states?.stdout), encodeState(states?.stderr)]
      : 0;
  const packedPositions: PackedStreamPair<CompactStreamPosition> =
    positions?.stdout || positions?.stderr
      ? [
          positions.stdout ? [positions.stdout.seq, positions.stdout.off] : null,
          positions.stderr ? [positions.stderr.seq, positions.stderr.off] : null,
        ]
      : 0;
  return [
    1,
    cursor.job,
    cursor.attempt,
    cursor.mode === 'events' ? 1 : 0,
    cursor.seq,
    cursor.off,
    packedStates,
    packedPositions,
  ];
}

export function logCursorAdvanced(from: LogCursor, to: LogCursor): boolean {
  return (
    to.seq !== from.seq ||
    to.off !== from.off ||
    JSON.stringify(to.states) !== JSON.stringify(from.states) ||
    JSON.stringify(to.positions) !== JSON.stringify(from.positions)
  );
}

export function encodeCursor(identity: ControllerIdentity, cursor: LogCursor): string | null {
  const token = signEdDsaJwt(
    identity.signingPrivateKeyPem,
    {
      sub: 'c',
      aud: 'r',
      exp: 4102444800,
      c: packCursor(cursor),
    },
    { includeIat: false, header: { alg: 'EdDSA' } },
  );
  return token.length <= 512 ? token : null;
}

function decodePackedState(value: unknown): LogPresentationState | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  const mode = PRESENTATION_MODES[value[0] as number];
  const csiLength = value[1];
  const oscLength = value[2];
  const controlLength = value[3];
  if (
    !mode ||
    !Number.isSafeInteger(csiLength) ||
    !Number.isSafeInteger(oscLength) ||
    !Number.isSafeInteger(controlLength) ||
    csiLength < 0 ||
    csiLength > 4096 ||
    oscLength < 0 ||
    oscLength > 4096 ||
    controlLength < 0 ||
    controlLength > 4096
  ) {
    return undefined;
  }
  return { mode, csiLength, oscLength, controlLength };
}

function decodePackedPosition(value: unknown): { seq: number; off: number } | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const seq = value[0];
  const off = value[1];
  if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(off) || seq < 0 || off < 0) {
    return undefined;
  }
  return { seq, off };
}

function unpackStreamPair<T>(
  value: unknown,
  decode: (item: unknown) => T | undefined,
): { stdout?: T; stderr?: T } | undefined | false {
  if (value === 0 || value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 2) return false;
  const stdout = value[0] === null ? undefined : decode(value[0]);
  const stderr = value[1] === null ? undefined : decode(value[1]);
  if (value[0] !== null && stdout === undefined) return false;
  if (value[1] !== null && stderr === undefined) return false;
  return { ...(stdout ? { stdout } : {}), ...(stderr ? { stderr } : {}) };
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
  if (!claims || claims.sub !== 'c' || claims.aud !== 'r' || !Array.isArray(claims.c)) return null;
  const packed = claims.c as unknown[];
  if (
    packed.length !== 8 ||
    packed[0] !== 1 ||
    typeof packed[1] !== 'string' ||
    typeof packed[2] !== 'string' ||
    (packed[3] !== 0 && packed[3] !== 1) ||
    !Number.isSafeInteger(packed[4]) ||
    (packed[4] as number) < 0 ||
    !Number.isSafeInteger(packed[5]) ||
    (packed[5] as number) < 0
  ) {
    return null;
  }
  const states = unpackStreamPair(packed[6], decodePackedState);
  const positions = unpackStreamPair(packed[7], decodePackedPosition);
  if (states === false || positions === false) return null;
  return {
    v: 1,
    job: packed[1],
    attempt: packed[2],
    mode: packed[3] === 1 ? 'events' : 'logs',
    seq: packed[4] as number,
    off: packed[5] as number,
    profile: 'ansi-v1',
    ...(states && Object.keys(states).length > 0 ? { states } : {}),
    ...(positions && Object.keys(positions).length > 0 ? { positions } : {}),
  };
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
    const result = Buffer.alloc(Math.min(entry.byte_length - offset, INDEX_READ_CAP));
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
  const exhaustedLookaheadStreams = new Set<'stdout' | 'stderr'>();
  let hasPendingIntervening = false;
  let remainingScan = PAGE_RAW_SCAN_CAP;
  for (let index = 0; index < Math.min(128, entries.length); index += 1) {
    if (maxBytes - returned < 4 || remainingScan < 1) {
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
    const remainingBytes = entry.byte_length - startOffset;
    const bytes = await readIndexedRange(logs, entry, startOffset);
    if (!bytes) throw new Error('indexed log source is unavailable');
    if (!bytes.length) continue;
    const rangeCapped = bytes.length < remainingBytes;
    const stream = entry.stream;
    const scanBudget = remainingScan;
    let page = presentLogChunks([bytes], states[stream], {
      maxBytes: maxBytes - returned,
      stripAnsi: true,
      rawScanCap: scanBudget,
    });
    let consumedFromNext = 0;
    let consumedNextEntry: ChunkIndexEntry | undefined;
    const needed = !page.truncated ? utf8ContinuationBytesNeeded(bytes) : 0;
    if (needed > 0 && !page.data.length && page.consumedRawBytes < bytes.length && !rangeCapped) {
      const lookaheadParts: Buffer[] = [];
      const lookaheadEntries: ChunkIndexEntry[] = [];
      let collected = 0;
      let scannedToEnd = true;
      for (
        let lookIndex = index + 1;
        lookIndex < entries.length && collected < needed;
        lookIndex += 1
      ) {
        const lookEntry = entries[lookIndex];
        if (lookEntry.stream !== stream) {
          hasPendingIntervening = true;
          nextSeq =
            nextSeq === cursor.seq ? lookEntry.sequence : Math.min(nextSeq, lookEntry.sequence);
          continue;
        }
        const look = await readIndexedRange(logs, lookEntry, 0);
        if (!look?.length) {
          scannedToEnd = false;
          break;
        }
        const take = look.subarray(0, needed - collected);
        lookaheadParts.push(take);
        lookaheadEntries.push(lookEntry);
        collected += take.length;
      }
      if (collected >= needed) {
        page = presentLogChunks([bytes, ...lookaheadParts], states[stream], {
          maxBytes: maxBytes - returned,
          stripAnsi: true,
          rawScanCap: scanBudget,
        });
        let remain = Math.max(0, page.consumedRawBytes - bytes.length);
        for (let lookPart = 0; lookPart < lookaheadEntries.length; lookPart += 1) {
          const used = Math.min(remain, lookaheadParts[lookPart].length);
          remain -= used;
          consumedNextEntry = lookaheadEntries[lookPart];
          consumedFromNext = used;
          if (remain === 0) break;
        }
      } else if (scannedToEnd) {
        exhaustedLookaheadStreams.add(stream);
      }
    }
    remainingScan = Math.max(0, remainingScan - page.scannedRawBytes);
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
    } else if (rangeCapped) {
      position.seq = entry.sequence;
      position.off = startOffset + bytes.length;
      nextSeq = position.seq;
      nextOff = position.off;
      truncated = true;
      break;
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
    hasMore:
      truncated ||
      entries.length > 128 ||
      [...blockedStreams].some((blocked) => !exhaustedLookaheadStreams.has(blocked)),
    truncated,
  };
}
