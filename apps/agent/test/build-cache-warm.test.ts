import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type BuildCacheConfig,
  BuildCacheStore,
  DEFAULT_BUILD_CACHE_CONFIG,
  computeBuildCacheKey,
} from '../src/build-cache/index.js';
import type { BuildCacheMetricsEvent } from '../src/build-cache/metrics.js';

/**
 * Synthetic compile/install workload:
 * - If `$CCACHE_DIR/sentinel` is missing → sleep ~1s, write marker, exit 0 (cold).
 * - If present → exit 0 immediately (warm).
 */
const SYNTHETIC_WORKLOAD = `
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.CCACHE_DIR;
if (!dir) { console.error('CCACHE_DIR missing'); process.exit(2); }
const sentinel = path.join(dir, 'sentinel');
if (fs.existsSync(sentinel)) {
  console.log('warm');
  process.exit(0);
}
const start = Date.now();
while (Date.now() - start < 1000) { /* cold populate */ }
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(sentinel, 'populated');
console.log('cold');
process.exit(0);
`;

function runSynthetic(
  ccacheDir: string,
): Promise<{ durationMs: number; code: number | null; mode: string }> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let stdout = '';
    const child = spawn(process.execPath, ['-e', SYNTHETIC_WORKLOAD], {
      env: { ...process.env, CCACHE_DIR: ccacheDir },
      windowsHide: true,
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ durationMs: Date.now() - started, code, mode: stdout.trim() });
    });
  });
}

const baseConfig = (): BuildCacheConfig => ({
  ...DEFAULT_BUILD_CACHE_CONFIG,
  maxSizeGb: 1,
  minFreeDiskGb: 0,
  allowReadRiskLevels: ['safe', 'normal'],
  allowWriteRiskLevels: ['safe', 'normal'],
});

describe('build-cache warm vs cold (synthetic)', () => {
  let root: string;
  const events: BuildCacheMetricsEvent[] = [];

  afterEach(async () => {
    events.length = 0;
    if (root) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function makeStore(config: BuildCacheConfig = baseConfig()): Promise<BuildCacheStore> {
    root = await mkdtemp(join(tmpdir(), 'rbo-build-cache-warm-'));
    return new BuildCacheStore(root, config, {
      onMetrics: (e) => events.push(e),
    });
  }

  it('cold populates sentinel; warm reuses same key and skips sleep', async () => {
    const store = await makeStore();
    const cacheKey = computeBuildCacheKey({
      kind: 'ccache',
      toolchainProfileId: 'gcc-arm',
      toolchainFingerprint: 'fp-v1',
      osFamily: 'linux',
      arch: 'x64',
      projectIdentity: 'local:warm-bench',
    });

    const coldAcquire = await store.acquireForJob({
      cacheKey,
      kind: 'ccache',
      attemptId: 'att_cold',
      riskLevel: 'normal',
    });
    expect(coldAcquire.mode).toBe('miss');

    const cold = await runSynthetic(coldAcquire.path);
    expect(cold.code).toBe(0);
    expect(cold.mode).toBe('cold');
    expect(cold.durationMs).toBeGreaterThanOrEqual(900);
    await access(join(coldAcquire.path, 'sentinel'));

    await store.publishIfAllowed({
      cacheKey,
      kind: 'ccache',
      attemptId: 'att_cold',
      riskLevel: 'normal',
      outcome: 'succeeded',
      tempPath: coldAcquire.path,
    });
    await coldAcquire.release();

    const warmAcquire = await store.acquireForJob({
      cacheKey,
      kind: 'ccache',
      attemptId: 'att_warm',
      riskLevel: 'normal',
    });
    expect(warmAcquire.mode).toBe('hit');
    expect(await readFile(join(warmAcquire.path, 'sentinel'), 'utf8')).toBe('populated');

    const warm = await runSynthetic(warmAcquire.path);
    expect(warm.code).toBe(0);
    expect(warm.mode).toBe('warm');

    await warmAcquire.release();

    expect(events.some((e) => e.event === 'build_cache_miss' && e.cache_key === cacheKey)).toBe(
      true,
    );
    expect(events.some((e) => e.event === 'build_cache_hit' && e.cache_key === cacheKey)).toBe(
      true,
    );
  });

  it('changed toolchain fingerprint → different key → miss (no reuse)', async () => {
    const store = await makeStore();
    const keyV1 = computeBuildCacheKey({
      kind: 'ccache',
      toolchainProfileId: 'gcc-arm',
      toolchainFingerprint: 'fp-v1',
      osFamily: 'linux',
      arch: 'x64',
      projectIdentity: 'local:fp-change',
    });
    const keyV2 = computeBuildCacheKey({
      kind: 'ccache',
      toolchainProfileId: 'gcc-arm',
      toolchainFingerprint: 'fp-v2',
      osFamily: 'linux',
      arch: 'x64',
      projectIdentity: 'local:fp-change',
    });
    expect(keyV1).not.toBe(keyV2);

    const first = await store.acquireForJob({
      cacheKey: keyV1,
      kind: 'ccache',
      attemptId: 'att_fp1',
      riskLevel: 'normal',
    });
    await writeFile(join(first.path, 'sentinel'), 'v1-only');
    await store.publishIfAllowed({
      cacheKey: keyV1,
      kind: 'ccache',
      attemptId: 'att_fp1',
      riskLevel: 'normal',
      outcome: 'succeeded',
      tempPath: first.path,
    });
    await first.release();

    const second = await store.acquireForJob({
      cacheKey: keyV2,
      kind: 'ccache',
      attemptId: 'att_fp2',
      riskLevel: 'normal',
    });
    expect(second.mode).toBe('miss');
    expect(second.path.includes('.tmp-')).toBe(true);
    await expect(access(join(second.path, 'sentinel'))).rejects.toThrow();
    await second.release();
  });

  it('destructive risk refuses publish / leaves no published write', async () => {
    const store = await makeStore();
    const cacheKey = computeBuildCacheKey({
      kind: 'ccache',
      toolchainProfileId: 'gcc-arm',
      toolchainFingerprint: 'fp-destructive',
      osFamily: 'linux',
      arch: 'x64',
      projectIdentity: 'local:destructive',
    });

    // Acquire under normal so we get a miss temp, then publish as destructive.
    const acquired = await store.acquireForJob({
      cacheKey,
      kind: 'ccache',
      attemptId: 'att_dest',
      riskLevel: 'normal',
    });
    expect(acquired.mode).toBe('miss');
    await writeFile(join(acquired.path, 'sentinel'), 'should-not-publish');
    await store.publishIfAllowed({
      cacheKey,
      kind: 'ccache',
      attemptId: 'att_dest',
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
      kind: 'ccache',
      attemptId: 'att_dest2',
      riskLevel: 'normal',
    });
    expect(again.mode).toBe('miss');
    await again.release();
  });

  it('concurrent population: one publisher; readers never see partial', async () => {
    const store = await makeStore();
    const cacheKey = computeBuildCacheKey({
      kind: 'ccache',
      toolchainProfileId: 'gcc-arm',
      toolchainFingerprint: 'fp-concurrent',
      osFamily: 'linux',
      arch: 'x64',
      projectIdentity: 'local:concurrent',
    });

    const first = await store.acquireForJob({
      cacheKey,
      kind: 'ccache',
      attemptId: 'att_pub',
      riskLevel: 'normal',
    });
    expect(first.mode).toBe('miss');

    const secondPromise = store.acquireForJob({
      cacheKey,
      kind: 'ccache',
      attemptId: 'att_reader',
      riskLevel: 'normal',
    });

    await writeFile(join(first.path, 'partial'), 'incomplete');
    // Published path must not exist yet for readers.
    await expect(access(join(root, cacheKey, '.published'))).rejects.toThrow();

    await store.publishIfAllowed({
      cacheKey,
      kind: 'ccache',
      attemptId: 'att_pub',
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
});
