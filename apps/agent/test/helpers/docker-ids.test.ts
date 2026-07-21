import { describe, expect, it } from 'vitest';
import { dockerIdListContains, dockerIdsEqual, dockerListOutputContains } from './docker-ids.js';

describe('dockerIdsEqual', () => {
  it('matches identical IDs', () => {
    expect(dockerIdsEqual('abc123', 'abc123')).toBe(true);
  });

  it('matches short ID as prefix of full ID (either order)', () => {
    const full = 'a1b2c3d4e5f6789012345678abcdef0123456789abcdef0123456789abcdef01';
    const short = full.slice(0, 12);
    expect(dockerIdsEqual(full, short)).toBe(true);
    expect(dockerIdsEqual(short, full)).toBe(true);
  });

  it('rejects unrelated IDs', () => {
    expect(dockerIdsEqual('aaaaaaaaaaaa', 'bbbbbbbbbbbb')).toBe(false);
  });

  it('rejects empty strings', () => {
    expect(dockerIdsEqual('', 'abc')).toBe(false);
    expect(dockerIdsEqual('abc', '')).toBe(false);
  });
});

describe('dockerIdListContains / dockerListOutputContains', () => {
  const full = 'deadbeefcafebabe0123456789abcdef0123456789abcdef0123456789abcdef';
  const short = full.slice(0, 12);

  it('finds full ID in a list of short IDs', () => {
    expect(dockerIdListContains([short, 'other'], full)).toBe(true);
  });

  it('finds full ID in newline-separated list output', () => {
    expect(dockerListOutputContains(`${short}\nother\n`, full)).toBe(true);
  });

  it('returns false when absent', () => {
    expect(dockerListOutputContains('aaaaaaaaaaaa\n', full)).toBe(false);
  });
});
