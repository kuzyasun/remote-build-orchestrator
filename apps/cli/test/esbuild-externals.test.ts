import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXTERNALS } from '../esbuild-externals.mjs';

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const rboBundle = join(cliRoot, 'dist', 'rbo.js');

describe('esbuild bundle externals', () => {
  it('keeps better-sqlite3 external in the allowlist', () => {
    expect(EXTERNALS).toContain('better-sqlite3');
  });

  it('built dist/rbo.js keeps better-sqlite3 as an external import', () => {
    expect(existsSync(rboBundle)).toBe(true);
    const source = readFileSync(rboBundle, 'utf8');
    expect(source).toMatch(/from\s+["']better-sqlite3["']/);
    // Must not inline the native module body.
    expect(source).not.toMatch(/node-gyp-build/);
  });
});
