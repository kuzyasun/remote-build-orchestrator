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

async function resolveFileContent(entry: TarEntryInput): Promise<Buffer> {
  if (entry.content) {
    return entry.content;
  }
  if (entry.contentPath) {
    const { readFile } = await import('node:fs/promises');
    return readFile(entry.contentPath);
  }
  return Buffer.alloc(0);
}

/** Build an uncompressed POSIX ustar archive from captured entries. */
export function createTarArchive(entries: TarEntryInput[]): Buffer {
  const chunks: Buffer[] = [];
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));

  for (const entry of sorted) {
    if (entry.type === 'file' && entry.contentPath && !entry.content) {
      throw new Error(
        `createTarArchive requires in-memory content for '${entry.path}' (use writeZstdTarArchiveFile for contentPath)`,
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

/**
 * Write a zstd tar archive directly to disk.
 * Reads at most one file payload at a time when entries use `contentPath`, streams zstd
 * compression, and does not retain the compressed payload Buffer on the result.
 */
export async function writeZstdTarArchiveFile(
  archivePath: string,
  entries: TarEntryInput[],
): Promise<WrittenArchiveResult> {
  const { createReadStream, createWriteStream } = await import('node:fs');
  const { mkdtemp, open, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { pipeline } = await import('node:stream/promises');
  const { createZstdCompress } = await import('node:zlib');
  const { createHash } = await import('node:crypto');

  const tmpDir = await mkdtemp(join(tmpdir(), 'rbo-tar-'));
  const tarPath = join(tmpDir, 'payload.tar');
  const handle = await open(tarPath, 'w');
  try {
    const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
    for (const entry of sorted) {
      if (entry.type === 'file') {
        const content = await resolveFileContent(entry);
        await handle.write(writeTarHeader(entry, content.length));
        if (content.length > 0) {
          await handle.write(content);
        }
        const remainder = content.length % 512;
        if (remainder !== 0) {
          await handle.write(Buffer.alloc(512 - remainder));
        }
      } else {
        await handle.write(writeTarHeader(entry, 0));
      }
    }
    await handle.write(Buffer.alloc(1024));
  } finally {
    await handle.close();
  }

  const hash = createHash('sha256');
  let size = 0;
  const compress = createZstdCompress();
  compress.on('data', (chunk: Buffer) => {
    hash.update(chunk);
    size += chunk.length;
  });
  await pipeline(createReadStream(tarPath), compress, createWriteStream(archivePath));
  await rm(tmpDir, { recursive: true, force: true });

  return {
    format: 'tar',
    compression: 'zstd',
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
