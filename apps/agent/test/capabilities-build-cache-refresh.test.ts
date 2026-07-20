import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyRefreshedBuildCacheAds,
  refreshBuildCacheCapabilityAds,
} from '../src/capabilities/probe.js';

describe('refreshBuildCacheCapabilityAds', () => {
  it('returns undefined when no published keys match enabled kinds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rbo-bc-refresh-'));
    const result = await refreshBuildCacheCapabilityAds({
      stateDir: root,
      enabledKinds: ['npm'],
    });
    expect(result).toBeUndefined();
  });

  it('picks up newly published keys for enabled kinds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rbo-bc-refresh-'));
    const npmKey = 'npm_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    await mkdir(join(root, 'build-caches', npmKey, 'npm'), { recursive: true });
    await writeFile(join(root, 'build-caches', npmKey, '.published'), '1\n');

    const result = await refreshBuildCacheCapabilityAds({
      stateDir: root,
      enabledKinds: ['npm'],
    });
    expect(result).toEqual([{ kind: 'npm', keys: [npmKey] }]);
  });
});

describe('applyRefreshedBuildCacheAds', () => {
  it('updates build_caches when refresh finds new keys', () => {
    const npmKey = 'npm_ffffffffffffffffffffffffffffffff';
    const next = applyRefreshedBuildCacheAds({ build_caches: undefined }, [
      { kind: 'npm', keys: [npmKey] },
    ]);
    expect(next.changed).toBe(true);
    expect(next.build_caches).toEqual([{ kind: 'npm', keys: [npmKey] }]);
  });

  it('clears build_caches when refresh finds none', () => {
    const next = applyRefreshedBuildCacheAds(
      { build_caches: [{ kind: 'npm', keys: ['npm_old'] }] },
      undefined,
    );
    expect(next.changed).toBe(true);
    expect(next.build_caches).toBeUndefined();
  });

  it('reports unchanged when ads are identical', () => {
    const ads = [{ kind: 'npm' as const, keys: ['npm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'] }];
    const next = applyRefreshedBuildCacheAds({ build_caches: ads }, ads);
    expect(next.changed).toBe(false);
    expect(next.build_caches).toEqual(ads);
  });
});
