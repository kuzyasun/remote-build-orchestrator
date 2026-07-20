import { describe, expect, it } from 'vitest';
import {
  assertGitStateUnchanged,
  captureGitState,
  createGitFixtureRepo,
} from '../src/git-fixtures.js';

describe('git fixture harness (§0.2)', () => {
  it('creates repos with committed, staged, and untracked files', async () => {
    const repo = await createGitFixtureRepo({
      committed: [{ path: 'base.txt', content: 'base' }],
      staged: [{ path: 'staged.txt', content: 'staged' }],
      untracked: [{ path: 'new.txt', content: 'new' }],
    });
    try {
      const state = await captureGitState(repo.root);
      expect(state.head).toMatch(/^[0-9a-f]{40}$/);
      expect(state.indexTree).toMatch(/^[0-9a-f]{40}$/);
      expect(state.statusPorcelain).toContain('staged.txt');
      expect(state.statusPorcelain).toContain('new.txt');
    } finally {
      await repo.cleanup();
    }
  });

  it('assertGitStateUnchanged throws with a diff when state changes', async () => {
    const repo = await createGitFixtureRepo({
      committed: [{ path: 'a.txt', content: 'a' }],
    });
    try {
      const before = await captureGitState(repo.root);
      const after = { ...before, head: `${before.head.slice(0, -1)}0` };
      expect(() => assertGitStateUnchanged(before, after)).toThrow(/HEAD:/);
    } finally {
      await repo.cleanup();
    }
  });

  it('sets executable bit via git index metadata', async () => {
    const repo = await createGitFixtureRepo({
      committed: [{ path: 'run.sh', content: '#!/bin/sh\necho hi', mode: '100755' }],
    });
    try {
      const state = await captureGitState(repo.root);
      expect(state.statusPorcelain).not.toContain('run.sh');
    } finally {
      await repo.cleanup();
    }
  });
});
