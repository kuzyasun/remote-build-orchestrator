import { describe, expect, it } from 'vitest';
import {
  compressTarZstd,
  createTarArchive,
  createZstdTarArchive,
  decompressTarZstd,
  parseTarArchive,
} from '../src/archive.js';

describe('archive (tar+zstd §12.1)', () => {
  it('round-trips file entries through tar parse', () => {
    const tar = createTarArchive([
      { path: 'src/main.ts', mode: 0o644, type: 'file', content: Buffer.from('hello') },
      { path: 'bin/run.sh', mode: 0o755, type: 'file', content: Buffer.from('#!/bin/sh\n') },
    ]);
    const parsed = parseTarArchive(tar);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.path).toBe('bin/run.sh');
    expect(parsed[0]?.content.toString()).toBe('#!/bin/sh\n');
    expect(parsed[1]?.path).toBe('src/main.ts');
    expect(parsed[1]?.content.toString()).toBe('hello');
  });

  it('includes directory and symlink markers', () => {
    const tar = createTarArchive([
      { path: 'empty-dir', mode: 0o755, type: 'directory' },
      { path: 'link', mode: 0o120000, type: 'symlink', target: '../shared' },
    ]);
    const parsed = parseTarArchive(tar);
    expect(parsed).toEqual([
      expect.objectContaining({ path: 'empty-dir', type: 'directory' }),
      expect.objectContaining({ path: 'link', type: 'symlink', target: '../shared' }),
    ]);
  });

  it('compresses and decompresses with zstd', () => {
    const tar = createTarArchive([
      { path: 'a.txt', mode: 0o644, type: 'file', content: Buffer.from('payload') },
    ]);
    const compressed = compressTarZstd(tar);
    const restored = decompressTarZstd(compressed);
    expect(parseTarArchive(restored)[0]?.content.toString()).toBe('payload');
  });

  it('createZstdTarArchive returns sha256 and size metadata', () => {
    const archive = createZstdTarArchive([
      { path: 'README.md', mode: 0o644, type: 'file', content: Buffer.from('# test') },
    ]);
    expect(archive.format).toBe('tar');
    expect(archive.compression).toBe('zstd');
    expect(archive.size).toBe(archive.data.length);
    expect(archive.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces a deterministic payload hash for identical entries (§11.16)', () => {
    const entries = [
      { path: 'a.txt', mode: 0o644, type: 'file' as const, content: Buffer.from('same') },
    ];
    const first = createZstdTarArchive(entries);
    const second = createZstdTarArchive(entries);
    expect(first.sha256).toBe(second.sha256);
    expect(first.data.equals(second.data)).toBe(true);
  });

  it('round-trips ustar paths that require prefix/name split (>100 bytes)', () => {
    const dir = Array.from({ length: 12 }, (_, i) => `d${String(i).padStart(8, '0')}`).join('/');
    const path = `${dir}/file.txt`;
    expect(Buffer.byteLength(path, 'utf8')).toBeGreaterThan(100);
    expect(Buffer.byteLength(path, 'utf8')).toBeLessThanOrEqual(255);
    const tar = createTarArchive([
      { path, mode: 0o644, type: 'file', content: Buffer.from('nested') },
    ]);
    const parsed = parseTarArchive(tar);
    expect(parsed[0]?.path).toBe(path);
    expect(parsed[0]?.content.toString()).toBe('nested');
  });

  it('rejects paths longer than the 255-byte ustar limit instead of truncating', () => {
    const segment = 'a'.repeat(40);
    const path = Array.from({ length: 8 }, () => segment).join('/');
    expect(Buffer.byteLength(path, 'utf8')).toBeGreaterThan(255);
    expect(() =>
      createTarArchive([{ path, mode: 0o644, type: 'file', content: Buffer.from('x') }]),
    ).toThrow(/255-byte ustar limit/);
  });
});
