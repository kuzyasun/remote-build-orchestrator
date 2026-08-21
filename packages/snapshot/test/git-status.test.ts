import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitStatusPorcelainV2, parsePorcelainV2 } from '../src/git-status.js';

describe('git-status porcelain v2 parser', () => {
  it('parses tracked modified entry (v2 line 1)', () => {
    const output =
      '1 AM N... 000000 100644 100644 0000000000000000000000000000000000000000 c2d46024e14dbd9078bb0aafcf920bb8e7216455 test.txt\0';
    const entries = parsePorcelainV2(output);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      path: 'test.txt',
      xy: 'AM',
      kind: 'tracked',
    });
  });

  it('parses rename entry (v2 line 2)', () => {
    // Real git emits path and origPath as consecutive NUL-terminated fields.
    const output = '2 AM N... 100644 100644 100644 e69de29 e69de29 R100 new.txt\0old.txt\0';
    const entries = parsePorcelainV2(output);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      path: 'new.txt',
      origPath: 'old.txt',
      xy: 'AM',
      kind: 'tracked',
    });
  });

  it('parses untracked entry', () => {
    const output = '? untracked/file with spaces.txt\0';
    const entries = parsePorcelainV2(output);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      path: 'untracked/file with spaces.txt',
      xy: '??',
      kind: 'untracked',
    });
  });

  it('parses ignored entry', () => {
    const output = '! ignored.tmp\0';
    const entries = parsePorcelainV2(output);
    expect(entries[0]).toMatchObject({
      path: 'ignored.tmp',
      kind: 'ignored',
    });
  });

  it('handles NUL-separated Unicode filenames', () => {
    const output = '? файл_тест.txt\0? dir/with\nnewline\0';
    const entries = parsePorcelainV2(output);
    expect(entries.map((e) => e.path)).toEqual(['файл_тест.txt', 'dir/with\nnewline']);
  });

  it('reports a git failure when binary status output has buffered stderr', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rbo-git-status-non-repo-'));
    try {
      await expect(gitStatusPorcelainV2(dir)).rejects.toThrow(/not a git repository/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
