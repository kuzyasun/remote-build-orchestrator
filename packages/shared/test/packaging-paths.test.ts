import { describe, expect, it } from 'vitest';
import {
  buildBaseManifest,
  isForbiddenPackagingPath,
  verifyArchiveManifest,
} from '../src/packaging.js';
import { containsWindowsReservedName, isSafeRelativePath } from '../src/paths.js';

describe('Windows reserved names (§34.5)', () => {
  it('detects CON/NUL/COM1 segments', () => {
    expect(containsWindowsReservedName('NUL')).toBe(true);
    expect(containsWindowsReservedName('foo/CON.txt')).toBe(true);
    expect(containsWindowsReservedName('com1')).toBe(true);
    expect(containsWindowsReservedName('src/main.ts')).toBe(false);
  });

  it('rejects reserved names via isSafeRelativePath', () => {
    expect(isSafeRelativePath('NUL')).toBe(false);
    expect(isSafeRelativePath('out/CON')).toBe(false);
    expect(isSafeRelativePath('out/ok.txt')).toBe(true);
  });
});

describe('Packaging forbidden paths', () => {
  it('flags identity/credentials/caches/logs', () => {
    expect(isForbiddenPackagingPath('identity/signing_private.pem')).toBe(true);
    expect(isForbiddenPackagingPath('logs/stdout.log')).toBe(true);
    expect(isForbiddenPackagingPath('apps/controller/dist/main.js')).toBe(false);
  });

  it('verifyArchiveManifest rejects forbidden files', () => {
    const manifest = buildBaseManifest('windows');
    manifest.files = [
      {
        path: 'identity/device_private.pem',
        sha256: 'a'.repeat(64),
        size_bytes: 1,
      },
    ];
    const result = verifyArchiveManifest(manifest);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('forbidden'))).toBe(true);
  });

  it('accepts a clean windows manifest', () => {
    const manifest = buildBaseManifest('windows');
    manifest.files = [
      {
        path: 'bin/rbo-controller.js',
        sha256: 'b'.repeat(64),
        size_bytes: 10,
      },
      {
        path: 'bin/rbo-windows-executor.exe',
        sha256: 'c'.repeat(64),
        size_bytes: 20,
      },
    ];
    expect(verifyArchiveManifest(manifest).ok).toBe(true);
  });
});
