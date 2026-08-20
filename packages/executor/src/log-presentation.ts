/** Streaming, presentation-only cleanup for AI-facing log pages. */

export type PresentationParserMode = 'ground' | 'escape' | 'csi' | 'osc' | 'oscEscape' | 'discard';

export interface LogPresentationState {
  mode: PresentationParserMode;
  csiLength: number;
  oscLength: number;
  /** Bytes scanned while in a control sequence; bounded, and never source text. */
  controlLength: number;
}

export interface PresentLogOptions {
  maxBytes: number;
  stripAnsi?: boolean;
  collapseDuplicates?: boolean;
  rawScanCap?: number;
}

export interface PresentLogResult {
  data: Buffer;
  state: LogPresentationState;
  consumedRawBytes: number;
  scannedRawBytes: number;
  truncated: boolean;
}

const MIN_BUDGET = 4;
const DEFAULT_RAW_SCAN_CAP = 1024 * 1024;
const MAX_CONTROL_BYTES = 4096;
const MAX_DEDUP_LINE_BYTES = 64 * 1024;

const initialState = (): LogPresentationState => ({
  mode: 'ground',
  csiLength: 0,
  oscLength: 0,
  controlLength: 0,
});

function copyState(state?: LogPresentationState): LogPresentationState {
  const source = state ?? initialState();
  return {
    mode: source.mode,
    csiLength: Math.min(Math.max(0, source.csiLength | 0), MAX_CONTROL_BYTES),
    oscLength: Math.min(Math.max(0, source.oscLength | 0), MAX_CONTROL_BYTES),
    controlLength: Math.min(Math.max(0, source.controlLength | 0), MAX_CONTROL_BYTES),
  };
}

function utf8Width(byte: number): number {
  if (byte < 0x80) return 1;
  if (byte >= 0xc2 && byte <= 0xdf) return 2;
  if (byte >= 0xe0 && byte <= 0xef) return 3;
  if (byte >= 0xf0 && byte <= 0xf4) return 4;
  return 1;
}

/**
 * Transform ordered raw chunks without touching durable logs. `consumedRawBytes`
 * permits callers to resume at an exact raw byte when a UTF-8 budget is reached.
 */
export function presentLogChunks(
  chunks: readonly Buffer[],
  state: LogPresentationState | undefined,
  options: PresentLogOptions,
): PresentLogResult {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < MIN_BUDGET) {
    throw new RangeError(`maxBytes must be at least ${MIN_BUDGET}`);
  }
  const stripAnsi = options.stripAnsi !== false;
  const collapse = options.collapseDuplicates === true;
  const scanCap = options.rawScanCap ?? DEFAULT_RAW_SCAN_CAP;
  if (!Number.isSafeInteger(scanCap) || scanCap < 1)
    throw new RangeError('rawScanCap must be positive');
  const parser = copyState(state);
  const output: Buffer[] = [];
  let outputBytes = 0;
  let consumed = 0;
  let scanned = 0;
  let truncated = false;
  let line = Buffer.alloc(0);
  let lineStartConsumed = 0;
  let lineStartScanned = 0;
  let lineStartState = copyState(parser);
  let previousLine: Buffer | undefined;
  let dedupLine = true;

  const append = (bytes: Buffer): boolean => {
    if (bytes.length === 0) return true;
    if (outputBytes + bytes.length > options.maxBytes) return false;
    output.push(bytes);
    outputBytes += bytes.length;
    return true;
  };
  const emitLine = (bytes: Buffer): boolean => {
    if (collapse && dedupLine && previousLine && previousLine.equals(bytes)) return true;
    if (!append(bytes)) return false;
    if (collapse && dedupLine) previousLine = Buffer.from(bytes);
    return true;
  };
  const emitText = (bytes: Buffer): boolean => {
    if (!collapse || !dedupLine) return append(bytes);
    if (line.length === 0) {
      lineStartConsumed = consumed;
      lineStartScanned = scanned;
      lineStartState = copyState(parser);
    }
    const next = Buffer.concat([line, bytes]);
    const newline = next.indexOf(0x0a);
    if (newline < 0) {
      if (next.length > MAX_DEDUP_LINE_BYTES) {
        dedupLine = false;
        line = Buffer.alloc(0);
        return append(next);
      }
      line = next;
      return true;
    }
    const complete = next.subarray(0, newline + 1);
    const rest = next.subarray(newline + 1);
    if (!emitLine(complete)) return false;
    line = Buffer.alloc(0);
    if (rest.length > 0) return emitText(rest);
    return true;
  };

  const controlByte = (byte: number): void => {
    parser.controlLength = Math.min(MAX_CONTROL_BYTES, parser.controlLength + 1);
    if (parser.controlLength >= MAX_CONTROL_BYTES) parser.mode = 'discard';
    if (parser.mode === 'csi') parser.csiLength = Math.min(MAX_CONTROL_BYTES, parser.csiLength + 1);
    if (parser.mode === 'osc' || parser.mode === 'oscEscape') {
      parser.oscLength = Math.min(MAX_CONTROL_BYTES, parser.oscLength + 1);
    }
    // Keep the argument observable to make accidental regex-only rewrites less likely.
    void byte;
  };

  const rollbackLine = (): void => {
    if (!collapse || !dedupLine || line.length === 0) return;
    consumed = lineStartConsumed;
    scanned = lineStartScanned;
    Object.assign(parser, lineStartState);
    line = Buffer.alloc(0);
  };

  let chunkIndex = 0;
  let offset = 0;
  for (;;) {
    if (chunkIndex >= chunks.length) break;
    const chunk = chunks[chunkIndex];
    if (offset >= chunk.length) {
      chunkIndex += 1;
      offset = 0;
      continue;
    }
    if (scanned >= scanCap) {
      rollbackLine();
      truncated = true;
      break;
    }
    const byte = chunk[offset];
    scanned += 1;

    if (!stripAnsi || parser.mode === 'ground') {
      if (stripAnsi && byte === 0x1b) {
        parser.mode = 'escape';
        parser.controlLength = 1;
        offset += 1;
        consumed += 1;
        continue;
      }
      const width = utf8Width(byte);
      if (width > 1) {
        const candidate = Buffer.allocUnsafe(width);
        let available = 0;
        for (
          let look = chunkIndex, lookOffset = offset;
          look < chunks.length && available < width;
          look += 1
        ) {
          const source = chunks[look];
          const start = look === chunkIndex ? lookOffset : 0;
          const count = Math.min(width - available, source.length - start);
          if (count > 0) {
            source.copy(candidate, available, start, start + count);
            available += count;
          }
        }
        if (available < width) {
          // Leave a split code point for the caller's raw cursor; never emit invalid UTF-8.
          scanned -= 1;
          break;
        }
        if (scanned + width - 1 > scanCap) {
          // A scalar is atomic for the raw-scan budget: leave its lead byte
          // unconsumed so the caller can resume at an exact boundary.
          scanned -= 1;
          rollbackLine();
          truncated = true;
          break;
        }
        if (candidate.toString('utf8').includes('\ufffd')) {
          if (!emitText(chunk.subarray(offset, offset + 1))) {
            truncated = true;
            break;
          }
          offset += 1;
          consumed += 1;
          continue;
        }
        if (!emitText(candidate)) {
          rollbackLine();
          truncated = true;
          break;
        }
        let remaining = width;
        scanned += width - 1;
        while (remaining > 0) {
          const availableInChunk = chunk.length - offset;
          const step = Math.min(remaining, availableInChunk);
          offset += step;
          consumed += step;
          remaining -= step;
          if (offset === chunk.length && remaining > 0) {
            chunkIndex += 1;
            offset = 0;
            if (chunkIndex >= chunks.length) break;
          }
        }
        continue;
      }
      if (!emitText(chunk.subarray(offset, offset + 1))) {
        rollbackLine();
        truncated = true;
        break;
      }
      offset += 1;
      consumed += 1;
      continue;
    }

    // Escape parser intentionally retains only bounded counters, never control payload.
    if (parser.mode === 'escape') {
      controlByte(byte);
      offset += 1;
      consumed += 1;
      if (byte === 0x5b) {
        parser.mode = 'csi';
        parser.csiLength = 0;
        continue;
      }
      if (byte === 0x5d) {
        parser.mode = 'osc';
        parser.oscLength = 0;
        continue;
      }
      // Unknown ESC: discard ESC and re-process its byte as ordinary text.
      parser.mode = 'ground';
      parser.controlLength = 0;
      offset -= 1;
      consumed -= 1;
      continue;
    }
    if (parser.mode === 'csi') {
      controlByte(byte);
      offset += 1;
      consumed += 1;
      if (byte >= 0x40 && byte <= 0x7e) {
        parser.mode = 'ground';
        parser.controlLength = 0;
      }
      continue;
    }
    if (parser.mode === 'osc' || parser.mode === 'oscEscape') {
      controlByte(byte);
      offset += 1;
      consumed += 1;
      if (parser.mode === 'oscEscape') {
        parser.mode = byte === 0x5c ? 'ground' : 'osc';
        if (parser.mode === 'ground') parser.controlLength = 0;
      } else if (byte === 0x07) {
        parser.mode = 'ground';
        parser.controlLength = 0;
      } else if (byte === 0x1b) {
        parser.mode = 'oscEscape';
      }
    } else {
      controlByte(byte);
      offset += 1;
      consumed += 1;
      if (byte === 0x07 || byte === 0x5c) {
        parser.mode = 'ground';
        parser.controlLength = 0;
      }
    }
  }
  // Page-local deduplication: a line crossing a page boundary is emitted normally.
  if (collapse && line.length > 0 && !truncated) {
    if (!append(line)) {
      rollbackLine();
      truncated = true;
    }
  }
  return {
    data: Buffer.concat(output),
    state: parser,
    consumedRawBytes: consumed,
    scannedRawBytes: scanned,
    truncated,
  };
}
