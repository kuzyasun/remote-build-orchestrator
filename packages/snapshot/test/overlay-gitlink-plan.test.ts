import { describe, expect, it } from 'vitest';
import { parsePorcelainV2 } from '../src/git-status.js';
import { computeOverlayPlan } from '../src/overlay.js';

describe('overlay gitlink plan classification', () => {
  it('parses submodule column in porcelain v2 output', () => {
    const raw = '1 .M S.M. 100644 100644 100644 abc def vendor/lib\0';
    const entries = parsePorcelainV2(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.submodule).toBe('S.M.');
    expect(entries[0]?.path).toBe('vendor/lib');
  });

  it('routes gitlink paths to gitlinks, not files', () => {
    const status = {
      head: '1'.repeat(40),
      branch: 'main',
      entries: [
        {
          path: 'vendor/lib',
          xy: ' M',
          kind: 'tracked' as const,
          submodule: 'S.M.',
        },
        {
          path: 'src/main.ts',
          xy: ' M',
          kind: 'tracked' as const,
        },
      ],
    };

    const plan = computeOverlayPlan(
      status,
      { include_untracked: true, include_ignored: [] },
      {
        stageModes: new Map([['vendor/lib', '160000']]),
        gitlinkCommits: new Map([['vendor/lib', 'a'.repeat(40)]]),
      },
    );

    expect(plan.files).toEqual(['src/main.ts']);
    expect(plan.files).not.toContain('vendor/lib');
    expect(plan.gitlinks).toEqual([{ path: 'vendor/lib', commit: 'a'.repeat(40) }]);
  });

  it('routes submodule deletion to deletions and removes gitlink pin', () => {
    const status = {
      head: '1'.repeat(40),
      branch: 'main',
      entries: [
        {
          path: 'vendor/lib',
          xy: 'D ',
          kind: 'tracked' as const,
          submodule: 'S...',
        },
      ],
    };

    const plan = computeOverlayPlan(
      status,
      { include_untracked: true, include_ignored: [] },
      {
        stageModes: new Map([['vendor/lib', '160000']]),
        gitlinkCommits: new Map([['vendor/lib', 'a'.repeat(40)]]),
      },
    );

    expect(plan.files).toEqual([]);
    expect(plan.deletions).toEqual(['vendor/lib']);
    expect(plan.gitlinks).toEqual([]);
  });

  it('sorts gitlink pins parent-before-child depth first', () => {
    const status = {
      head: '1'.repeat(40),
      branch: 'main',
      entries: [],
    };

    const plan = computeOverlayPlan(
      status,
      { include_untracked: true, include_ignored: [] },
      {
        gitlinkCommits: new Map([
          ['a/b/c', '3'.repeat(40)],
          ['a', '1'.repeat(40)],
          ['a/b', '2'.repeat(40)],
        ]),
      },
    );

    expect(plan.gitlinks).toEqual([
      { path: 'a', commit: '1'.repeat(40) },
      { path: 'a/b', commit: '2'.repeat(40) },
      { path: 'a/b/c', commit: '3'.repeat(40) },
    ]);
  });
});
