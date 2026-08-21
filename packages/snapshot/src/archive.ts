import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { sha256 } from '@rbo/shared';

export interface TarEntryInput {
  path: string;
  mode: number;
  type: 'file' | 'directory' | 'symlink';
  content?: Buffer;
  /** When set, file bytes are read from disk during archive write (avoids retaining Buffers). */
  contentPath?: string;
  target?: string;
}

export interface ArchiveResult {
  format: 'tar';
  compression: 'zstd';
  data: Buffer;
  sha256: string;
  size: number;
}

function padOctal(value: number, length: number): string {
  const str = value.toString(8);
  if (str.length >= length) {
    return str.slice(0, length);
  }
  return `${str.padStart(length - 1, '0')}\0`;
}

function computeTarChecksum(header: Buffer): void {
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) {
    sum += byte;
  }
  const checksum = padOctal(sum, 8);
  header.write(checksum, 148, 8, 'ascii');
}

function splitUstarPath(pathStr: string): { name: string; prefix: string } {
  const normalized = pathStr.replace(/\\/g, '/');
  const byteLength = Buffer.byteLength(normalized, 'utf8');
  if (byteLength > 255) {
    throw new Error(`Tar path exceeds 255-byte ustar limit (${byteLength} bytes): ${normalized}`);
  }
  if (Buffer.byteLength(normalized, 'utf8') <= 100) {
    return { name: normalized, prefix: '' };
  }
  // Prefer a slash split so name ≤ 100 and prefix ≤ 155 (POSIX ustar).
  for (let i = normalized.length - 1; i >= 0; i -= 1) {
    if (normalized[i] !== '/') {
      continue;
    }
    const prefix = normalized.slice(0, i);
    const name = normalized.slice(i + 1);
    if (
      name.length > 0 &&
      Buffer.byteLength(name, 'utf8') <= 100 &&
      Buffer.byteLength(prefix, 'utf8') <= 155
    ) {
      return { name, prefix };
    }
  }
  throw new Error(`Tar path cannot be encoded in ustar name/prefix fields: ${normalized}`);
}

function writeTarHeader(entry: TarEntryInput, fileSize = 0): Buffer {
  const header = Buffer.alloc(512, 0);
  const { name, prefix } = splitUstarPath(entry.path);

  header.write(name, 0, 100, 'utf8');
  header.write(padOctal(entry.mode, 8), 100, 8, 'ascii');
  header.write(padOctal(0, 8), 108, 8, 'ascii');
  header.write(padOctal(0, 8), 116, 8, 'ascii');
  const size = entry.type === 'file' ? fileSize : 0;
  header.write(padOctal(size, 12), 124, 12, 'ascii');
  // Fixed mtime so payload hash (and therefore content_id) is deterministic (§11.16).
  header.write(padOctal(0, 12), 136, 12, 'ascii');
  header.write('        ', 148, 8, 'ascii');
  const typeflag = entry.type === 'directory' ? '5' : entry.type === 'symlink' ? '2' : '0';
  header.write(typeflag, 156, 1, 'ascii');
  if (entry.type === 'symlink' && entry.target) {
    if (Buffer.byteLength(entry.target, 'utf8') > 100) {
      throw new Error(`Symlink target exceeds 100-byte ustar limit: ${entry.target}`);
    }
    header.write(entry.target, 157, 100, 'utf8');
  }
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  if (prefix) {
    header.write(prefix, 345, 155, 'utf8');
  }
  computeTarChecksum(header);
  return header;
}

/** Build an uncompressed POSIX ustar archive from captured entries. */
export function createTarArchive(entries: TarEntryInput[]): Buffer {
  const chunks: Buffer[] = [];
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));

  for (const entry of sorted) {
    if (entry.type === 'file' && entry.contentPath && !entry.content) {
      throw new Error(
        `createTarArchive requires in-memory content for '${entry.path}' (use writeZstdTarArchiveCandidate for contentPath)`,
      );
    }
    const fileSize = entry.type === 'file' && entry.content ? entry.content.length : 0;
    chunks.push(writeTarHeader(entry, fileSize));
    if (entry.type === 'file' && entry.content) {
      chunks.push(entry.content);
      const remainder = entry.content.length % 512;
      if (remainder !== 0) {
        chunks.push(Buffer.alloc(512 - remainder));
      }
    }
  }

  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

/** Compress a tar archive with zstd (§12.1). */
export function compressTarZstd(tarData: Buffer): Buffer {
  return zstdCompressSync(tarData);
}

export function decompressTarZstd(data: Buffer): Buffer {
  return zstdDecompressSync(data);
}

export function createZstdTarArchive(entries: TarEntryInput[]): ArchiveResult {
  const tarData = createTarArchive(entries);
  const data = compressTarZstd(tarData);
  return {
    format: 'tar',
    compression: 'zstd',
    data,
    sha256: sha256(data),
    size: data.length,
  };
}

export interface WrittenArchiveResult {
  format: 'tar';
  compression: 'zstd';
  sha256: string;
  size: number;
}

export interface WrittenArchiveEntryResult {
  path: string;
  size: number;
  sha256: string;
}

export interface WrittenArchiveCandidateResult extends WrittenArchiveResult {
  candidatePath: string;
  entries: WrittenArchiveEntryResult[];
}

/**
 * Write a compressed archive to a unique private candidate.
 * Publication/rename of the candidate is deliberately owned by the caller.
 */
export async function writeZstdTarArchiveCandidate(
  archivePath: string,
  entries: TarEntryInput[],
): Promise<WrittenArchiveCandidateResult> {
  const { createReadStream, createWriteStream } = await import('node:fs');
  const { open, rm } = await import('node:fs/promises');
  const { pipeline } = await import('node:stream/promises');
  const { Transform, Readable } = await import('node:stream');
  const { createZstdCompress } = await import('node:zlib');
  const { createHash, randomUUID } = await import('node:crypto');

  // Keep the candidate beside the requested path so the final rename is atomic.
  // The requested path is never opened until the complete compressed stream succeeds.
  const candidatePath = `${archivePath}.candidate-${randomUUID()}`;
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  const entryResults: WrittenArchiveEntryResult[] = [];
  async function* tarChunks(): AsyncGenerator<Buffer> {
    for (const entry of sorted) {
      let fileSize = 0;
      const fileHash = createHash('sha256');
      if (entry.type === 'file') {
        if (entry.content) {
          fileSize = entry.content.length;
        } else if (entry.contentPath) {
          const handle = await open(entry.contentPath, 'r');
          try {
            const before = await handle.stat({ bigint: true });
            if (!before.isFile()) {
              throw new Error(`Source path is not a regular file: '${entry.path}'`);
            }
            if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
              throw new Error(`Source file is too large to archive safely: '${entry.path}'`);
            }
            fileSize = Number(before.size);
            yield writeTarHeader(entry, fileSize);
            let streamed = 0;
            if (fileSize > 0) {
              for await (const chunk of createReadStream(entry.contentPath, {
                fd: handle.fd,
                autoClose: false,
                start: 0,
                end: fileSize - 1,
              })) {
                const bytes = chunk as Buffer;
                streamed += bytes.length;
                fileHash.update(bytes);
                yield bytes;
              }
            }
            const after = await handle.stat({ bigint: true });
            if (
              streamed !== fileSize ||
              after.size !== before.size ||
              after.mtimeNs !== before.mtimeNs ||
              after.ctimeNs !== before.ctimeNs ||
              after.dev !== before.dev ||
              after.ino !== before.ino
            ) {
              throw new Error(`Source file changed while archiving '${entry.path}'`);
            }
          } finally {
            await handle.close();
          }
          const remainder = fileSize % 512;
          if (remainder !== 0) {
            yield Buffer.alloc(512 - remainder);
          }
          entryResults.push({ path: entry.path, size: fileSize, sha256: fileHash.digest('hex') });
          continue;
        }
      }
      yield writeTarHeader(entry, fileSize);

      if (entry.type !== 'file') {
        continue;
      }
      if (fileSize === 0) {
        entryResults.push({ path: entry.path, size: 0, sha256: fileHash.digest('hex') });
        continue;
      }
      if (entry.content) {
        fileHash.update(entry.content);
        yield entry.content;
      }
      const remainder = fileSize % 512;
      if (remainder !== 0) {
        yield Buffer.alloc(512 - remainder);
      }
      if (entry.type === 'file') {
        entryResults.push({ path: entry.path, size: fileSize, sha256: fileHash.digest('hex') });
      }
    }
    yield Buffer.alloc(1024);
  }

  const hash = createHash('sha256');
  let size = 0;
  const digest = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      size += chunk.length;
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.from(tarChunks()),
      createZstdCompress(),
      digest,
      createWriteStream(candidatePath, { flags: 'wx' }),
    );
  } catch (error) {
    await rm(candidatePath, { force: true }).catch(() => undefined);
    throw error;
  }

  return {
    format: 'tar',
    compression: 'zstd',
    candidatePath,
    entries: entryResults,
    sha256: hash.digest('hex'),
    size,
  };
}

export interface ParsedTarEntry {
  path: string;
  type: 'file' | 'directory' | 'symlink';
  mode: number;
  content: Buffer;
  target?: string;
}

/** Parse an uncompressed POSIX ustar archive (for tests and materialization). */
export function parseTarArchive(tarData: Buffer): ParsedTarEntry[] {
  const entries: ParsedTarEntry[] = [];
  let offset = 0;

  while (offset + 512 <= tarData.length) {
    const header = tarData.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      break;
    }

    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    // POSIX ustar: when prefix is set, full path is prefix + '/' + name.
    const path = prefix ? `${prefix}/${rawName}` : rawName;
    const mode = Number.parseInt(header.subarray(100, 108).toString('utf8').trim(), 8) || 0o644;
    const size = Number.parseInt(header.subarray(124, 136).toString('utf8').trim(), 8) || 0;
    const typeflag = String.fromCharCode(header[156] ?? 0x30);

    if (typeflag === '5') {
      entries.push({ path, type: 'directory', mode, content: Buffer.alloc(0) });
      continue;
    }

    if (typeflag === '2') {
      const target = header.subarray(157, 257).toString('utf8').replace(/\0.*$/, '');
      entries.push({ path, type: 'symlink', mode, content: Buffer.alloc(0), target });
      continue;
    }

    const content = tarData.subarray(offset, offset + size);
    offset += size;
    const remainder = size % 512;
    if (remainder !== 0) {
      offset += 512 - remainder;
    }
    entries.push({ path, type: 'file', mode, content });
  }

  return entries;
}
