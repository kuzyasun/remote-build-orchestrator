import { describe, expect, it } from 'vitest';
import { SnapshotFileEntrySchema } from '../src/index.js';

describe('gitlink schema entry type', () => {
  it('accepts gitlink overlay entries', () => {
    const entry = SnapshotFileEntrySchema.parse({
      path: 'vendor/lib',
      type: 'gitlink',
      mode: '160000',
      commit: 'a'.repeat(40),
    });
    expect(entry.type).toBe('gitlink');
    if (entry.type === 'gitlink') {
      expect(entry.mode).toBe('160000');
      expect(entry.commit).toBe('a'.repeat(40));
    }
  });

  it('rejects gitlink without 40-hex commit', () => {
    expect(() =>
      SnapshotFileEntrySchema.parse({
        path: 'vendor/lib',
        type: 'gitlink',
        mode: '160000',
        commit: 'abc',
      }),
    ).toThrow();
  });

  it('rejects gitlink with file sha256 field', () => {
    expect(() =>
      SnapshotFileEntrySchema.parse({
        path: 'vendor/lib',
        type: 'gitlink',
        mode: '160000',
        commit: 'a'.repeat(40),
        sha256: 'b'.repeat(64),
      }),
    ).toThrow();
  });
});
