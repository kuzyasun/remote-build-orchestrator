import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type BuildCacheConfig, DEFAULT_BUILD_CACHE_CONFIG } from '../src/build-cache/index.js';
import type { BuildCacheMetricsEvent } from '../src/build-cache/metrics.js';
import { BuildCacheStore, LOCK_STALE_MAX_AGE_MS } from '../src/build-cache/store.js';

const baseConfig = (): BuildCacheConfig => ({
  ...DEFAULT_BUILD_CACHE_CONFIG,
  maxSizeGb: 1,
  minFreeDiskGb: 0,
});

describe('BuildCacheStore', () => {
  let root: string;
  const events: BuildCacheMetricsEvent[] = [];

  afterEach(async () => {
    events.length = 0;
    if (root) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeStore(config: BuildCacheConfig = baseConfig()): Promise<BuildCacheStore> {
    root = await mkdtemp(join(tmpdir(), 'rbo-build-cache-store-'));
    return new BuildCacheStore(root, config, {
      onMetrics: (e) => events.push(e),
    });
  }

  it('miss acquire points at temp dir (not .tmp name leaked into published path) and publish promotes atomically', async () => {
    const store = await makeStore();
    const cacheKey = 'npm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const acquired = await store.acquireForJob({
      cacheKey,
      kind: 'npm',
      attemptId: 'att_1',
      riskLevel: 'normal',
    });
    expect(acquired.mode).toBe('miss');
    expect(acquired.path.includes('.tmp-')).toBe(true);
    expect(acquired.path.includes(cacheKey)).toBe(true);

    await writeFile(join(acquired.path, 'sentinel'), 'warm');

    await store.publishIfAllowed({
      cacheKey,
      kind: 'npm',
      attemptId: 'att_1',
      riskLevel: 'normal',
      outcome: 'succeeded',
      tempPath: acquired.path,
    });
    await acquired.release();

    const hit = await store.acquireForJob({
      cacheKey,
      kind: 'npm',
      attemptId: 'att_2',
      riskLevel: 'normal',
    });
    expect(hit.mode).toBe('hit');
    expect(hit.path.includes('.tmp-')).toBe(false);
    expect(await readFile(join(hit.path, 'sentinel'), 'utf8')).toBe('warm');
    await hit.release();

    expect(events.some((e) => e.event === 'build_cache_miss' && e.cache_key === cacheKey)).toBe(
      true,
    );
    expect(events.some((e) => e.event === 'build_cache_publish' && e.cache_key === cacheKey)).toBe(
      true,
    );
    expect(events.some((e) => e.event === 'build_cache_hit' && e.cache_key === cacheKey)).toBe(
      true,
    );
  });

  it('failed outcome discards temp and leaves previous published entry intact', async () => {
    const store = await makeStore();
    const cacheKey = 'npm_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    const first = await store.acquireForJob({
      cacheKey,
      kind: 'npm',
      attemptId: 'att_a',
      riskLevel: 'normal',
    });
    await writeFile(join(first.path, 'sentinel'), 'v1');
    await store.publishIfAllowed({
      cacheKey,
      kind: 'npm',
      attemptId: 'att_a',
      riskLevel: 'normal',
      outcome: 'succeeded',
      tempPath: first.path,
    });
    await first.release();

    const second = await store.acquireForJob({
      cacheKey,
      kind: 'npm',
      attemptId: 'att_b',
      riskLevel: 'normal',
    });
    // Hit path is published; to simulate a concurrent miss writer we'd need no publish.
    // Populate a second key miss that fails:
    await second.release();

    const missKey = 'npm_cccccccccccccccccccccccccccccccc';
    const writer = await store.acquireForJob({
      cacheKey: missKey,
      kind: 'npm',
      attemptId: 'att_fail',
      riskLevel: 'normal',
    });
    expect(writer.mode).toBe('miss');
    await writeFile(join(writer.path, 'sentinel'), 'should-discard');
    await store.publishIfAllowed({
      cacheKey: missKey,
      kind: 'npm',
      attemptId: 'att_fail',
      riskLevel: 'normal',
      outcome: 'failed',
      tempPath: writer.path,
    });
    await writer.release();

    const afterFail = await store.acquireForJob({
      cacheKey: missKey,
      kind: 'npm',
      attemptId: 'att_c',
      riskLevel: 'normal',
    });
    expect(afterFail.mode).toBe('miss');
    await afterFail.release();

    const stillWarm = await store.acquireForJob({
      cacheKey,
      kind: 'npm',
      attemptId: 'att_d',
      riskLevel: 'normal',
    });
    expect(stillWarm.mode).toBe('hit');
    expect(await readFile(join(stillWarm.path, 'sentinel'), 'utf8')).toBe('v1');
    await stillWarm.release();
  });

  it('refuses publish when risk is not in allowWriteRiskLevels', async () => {
    const store = await makeStore({
      ...baseConfig(),
      allowWriteRiskLevels: ['safe', 'normal'],
    });
    const cacheKey = 'npm_dddddddddddddddddddddddddddddddd';
    const acquired = await store.acquireForJob({
      cacheKey,
      kind: 'npm',
      attemptId: 'att_risk',
      riskLevel: 'normal',
    });
    expect(acquired.mode).toBe('miss');
    await writeFile(join(acquired.path, 'x'), 'nope');
    await store.publishIfAllowed({
      cacheKey,
      kind: 'npm',
      attemptId: 'att_risk',
      riskLevel: 'destructive',
      outcome: 'succeeded',
      tempPath: acquired.path,
    });
    await acquired.release();

    expect(
      events.some(
        (e) =>
          e.event === 'build_cache_refuse' && e.cache_key === cacheKey && e.reason === 'risk_level',
      ),
    ).toBe(true);

    const again = await store.acquireForJob({
      cacheKey,
      kind: 'npm',
      attemptId: 'att_risk2',
      riskLevel: 'normal',
    });
    expect(again.mode).toBe('miss');
    await again.release();
  });

  it('read_disabled when risk not in allowReadRiskLevels', async () => {
    const store = await makeStore();
    const acquired = await store.acquireForJob({
      cacheKey: 'npm_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      kind: 'npm',
      attemptId: 'att_ro',
      riskLevel: 'hardware',
    });
    expect(acquired.mode).toBe('read_disabled');
    await acquired.release();
    expect(events.some((e) => e.event === 'build_cache_refuse' && e.reason === 'risk_level')).toBe(
      true,
    );
  });

  it('concurrent acquires: one miss publisher; second waits or hits after publish', async () => {
    const store = await makeStore();
    const cacheKey = 'npm_ffffffffffffffffffffffffffffffff';

    const first = await store.acquireForJob({
      cacheKey,
      kind: 'npm',
      attemptId: 'att_w1',
      riskLevel: 'normal',
    });
    expect(first.mode).toBe('miss');

    const secondPromise = store.acquireForJob({
      cacheKey,
      kind: 'npm',
      attemptId: 'att_w2',
      riskLevel: 'normal',
    });

    // While first holds exclusive miss lock, second should not observe a partial published path.
    await writeFile(join(first.path, 'partial'), 'x');
    await store.publishIfAllowed({
      cacheKey,
      kind: 'npm',
      attemptId: 'att_w1',
      riskLevel: 'normal',
      outcome: 'succeeded',
      tempPath: first.path,
    });
    await first.release();

    const second = await secondPromise;
    expect(second.mode).toBe('hit');
    expect(second.path.includes('.tmp-')).toBe(false);
    await access(join(second.path, 'partial'));
    await second.release();
  });

  it('evictInactive skips keys with active users / lock and removes LRU inactive', async () => {
    const store = await makeStore({
      ...baseConfig(),
      maxSizeGb: 0.000001, // tiny quota → force eviction
      minFreeDiskGb: 0,
      retentionDays: 0,
    });

    const oldKey = 'npm_11111111111111111111111111111111';
    const newKey = 'npm_22222222222222222222222222222222';
    const activeKey = 'npm_33333333333333333333333333333333';

    for (const [key, attemptId, body] of [
      [oldKey, 'att_old', 'old'],
      [newKey, 'att_new', 'new'],
    ] as const) {
      const a = await store.acquireForJob({
        cacheKey: key,
        kind: 'npm',
        attemptId,
        riskLevel: 'normal',
      });
      await writeFile(join(a.path, 'sentinel'), body);
      await store.publishIfAllowed({
        cacheKey: key,
        kind: 'npm',
        attemptId,
        riskLevel: 'normal',
        outcome: 'succeeded',
        tempPath: a.path,
      });
      await a.release();
    }

    // Touch newKey as more recently used
    const touch = await store.acquireForJob({
      cacheKey: newKey,
      kind: 'npm',
      attemptId: 'att_touch',
      riskLevel: 'normal',
    });
    await touch.release();

    const held = await store.acquireForJob({
      cacheKey: activeKey,
      kind: 'npm',
      attemptId: 'att_hold',
      riskLevel: 'normal',
    });
    expect(held.mode).toBe('miss');
    await writeFile(join(held.path, 'sentinel'), 'held');
    await store.publishIfAllowed({
      cacheKey: activeKey,
      kind: 'npm',
      attemptId: 'att_hold',
      riskLevel: 'normal',
      outcome: 'succeeded',
      tempPath: held.path,
    });
    // keep held without release → active_users > 0

    const result = await store.evictInactive({
      maxSizeBytes: 1,
      minFreeBytes: 0,
      now: new Date(),
    });

    expect(result.evictedKeys).toContain(oldKey);
    expect(result.evictedKeys).not.toContain(activeKey);

    await expect(access(join(root, oldKey))).rejects.toThrow();
    await access(join(root, activeKey));
    await held.release();

    expect(events.some((e) => e.event === 'build_cache_evict' && e.cache_key === oldKey)).toBe(
      true,
    );
  });

  it('metrics never include secret material — only opaque cache_key', async () => {
    const store = await makeStore();
    const cacheKey = 'npm_99999999999999999999999999999999';
    const a = await store.acquireForJob({
      cacheKey,
      kind: 'npm',
      attemptId: 'att_sec',
      riskLevel: 'normal',
    });
    await a.release();
    for (const e of events) {
      expect(JSON.stringify(e)).not.toMatch(/secret|password|token/i);
      expect(e.cache_key).toBe(cacheKey);
    }
  });

  it('reclaims crash-stale .lock with dead PID so acquire succeeds', async () => {
    const store = await makeStore();
    const cacheKey = 'npm_deadpid000000000000000000000000';
    await mkdir(join(root, cacheKey), { recursive: true });
    // PID unlikely to exist on any host; kill(pid, 0) → ESRCH.
    await writeFile(join(root, `${cacheKey}.lock`), '2147483646\n', 'utf8');

    const acquired = await store.acquireForJob({
      cacheKey,
      kind: 'npm',
      attemptId: 'att_dead_lock',
      riskLevel: 'normal',
    });
    expect(acquired.mode).toBe('miss');
    await acquired.release();
  });

  it('reclaims over-age .lock so acquire succeeds', async () => {
    const store = await makeStore();
    const cacheKey = 'npm_oldlock0000000000000000000000000';
    await mkdir(join(root, cacheKey), { recursive: true });
    const lockPath = join(root, `${cacheKey}.lock`);
    // Live PID alone would block; aged mtime past LOCK_STALE_MAX_AGE_MS allows reclaim.
    await writeFile(lockPath, `${process.pid}\n`, 'utf8');
    const staleAt = new Date(Date.now() - LOCK_STALE_MAX_AGE_MS - 60_000);
    await utimes(lockPath, staleAt, staleAt);

    const acquired = await store.acquireForJob({
      cacheKey,
      kind: 'npm',
      attemptId: 'att_old_lock',
      riskLevel: 'normal',
    });
    expect(acquired.mode).toBe('miss');
    await acquired.release();
  });

  it('evictInactive reclaims stale locks and can evict those keys', async () => {
    const store = await makeStore({
      ...baseConfig(),
      maxSizeGb: 0.000001,
      minFreeDiskGb: 0,
      retentionDays: 0,
    });
    const cacheKey = 'npm_stalevict0000000000000000000000';
    const a = await store.acquireForJob({
      cacheKey,
      kind: 'npm',
      attemptId: 'att_sv',
      riskLevel: 'normal',
    });
    await writeFile(join(a.path, 'sentinel'), 'x');
    await store.publishIfAllowed({
      cacheKey,
      kind: 'npm',
      attemptId: 'att_sv',
      riskLevel: 'normal',
      outcome: 'succeeded',
      tempPath: a.path,
    });
    await a.release();

    const lockPath = join(root, `${cacheKey}.lock`);
    await writeFile(lockPath, '2147483646\n', 'utf8');

    const result = await store.evictInactive({
      maxSizeBytes: 1,
      minFreeBytes: 0,
      now: new Date(),
    });
    expect(result.evictedKeys).toContain(cacheKey);
  });

  it('evictInactive min-free path uses injected getFreeBytes', async () => {
    root = await mkdtemp(join(tmpdir(), 'rbo-build-cache-minfree-'));
    const probed: string[] = [];
    const store = new BuildCacheStore(
      root,
      {
        ...baseConfig(),
        maxSizeGb: 100, // large quota — eviction must come from min-free, not quota
        minFreeDiskGb: 1,
        retentionDays: 30,
      },
      {
        onMetrics: (e) => events.push(e),
        getFreeBytes: async (dir) => {
          probed.push(dir);
          return 100; // far below minFreeBytes
        },
      },
    );

    const cacheKey = 'npm_minfree000000000000000000000000';
    const a = await store.acquireForJob({
      cacheKey,
      kind: 'npm',
      attemptId: 'att_mf',
      riskLevel: 'normal',
    });
    await writeFile(join(a.path, 'blob'), 'y'.repeat(64));
    await store.publishIfAllowed({
      cacheKey,
      kind: 'npm',
      attemptId: 'att_mf',
      riskLevel: 'normal',
      outcome: 'succeeded',
      tempPath: a.path,
    });
    await a.release();

    const result = await store.evictInactive({
      maxSizeBytes: 100 * 1024 ** 3,
      minFreeBytes: 10_000,
      now: new Date(),
    });

    expect(probed.length).toBeGreaterThan(0);
    expect(probed[0]).toBe(root);
    expect(result.evictedKeys).toContain(cacheKey);
    expect(
      events.some(
        (e) =>
          e.event === 'build_cache_evict' && e.cache_key === cacheKey && e.reason === 'min_free',
      ),
    ).toBe(true);
  });
});

describe('BuildCacheStore write_disabled on miss when write risk denied', () => {
  let root: string;

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('returns write_disabled for miss when write risk denied but read allowed', async () => {
    root = await mkdtemp(join(tmpdir(), 'rbo-build-cache-wd-'));
    const store = new BuildCacheStore(root, {
      ...DEFAULT_BUILD_CACHE_CONFIG,
      allowReadRiskLevels: ['safe', 'normal', 'destructive'],
      allowWriteRiskLevels: ['safe', 'normal'],
    });
    const acquired = await store.acquireForJob({
      cacheKey: 'npm_44444444444444444444444444444444',
      kind: 'npm',
      attemptId: 'att_wd',
      riskLevel: 'destructive',
    });
    expect(acquired.mode).toBe('write_disabled');
    await acquired.release();
  });
});
