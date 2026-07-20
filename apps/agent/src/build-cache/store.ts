import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { BuildCacheKind, RiskLevel } from '@rbo/protocol';
import type { BuildCacheConfig } from './config.js';
import { getBuildCacheKindDefinition } from './kinds.js';
import {
  type BuildCacheMetricsEvent,
  type BuildCacheMetricsSink,
  emitBuildCacheMetrics,
} from './metrics.js';

const PUBLISHED_MARKER = '.published';
const LOCK_NAME = '.lock';
const META_NAME = 'meta.json';
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 30_000;
/**
 * Max age for reclaiming crash-orphaned `.lock` files (PID dead or holder stopped refreshing).
 * Live holders refresh mtime periodically so long miss publishes stay protected.
 */
export const LOCK_STALE_MAX_AGE_MS = 10 * 60 * 1000;
/** How often a held lock refreshes mtime (must be well below LOCK_STALE_MAX_AGE_MS). */
const LOCK_TOUCH_INTERVAL_MS = Math.floor(LOCK_STALE_MAX_AGE_MS / 3);

export interface BuildCacheMeta {
  kind: BuildCacheKind;
  cache_key: string;
  last_used_at: string;
  active_users: number;
  bytes?: number;
}

export interface AcquireInput {
  cacheKey: string;
  kind: BuildCacheKind;
  attemptId: string;
  riskLevel: RiskLevel;
}

export type AcquireMode = 'hit' | 'miss' | 'read_disabled' | 'write_disabled';

export interface AcquireResult {
  mode: AcquireMode;
  /** Absolute path to the kind cache directory (or empty when disabled). */
  path: string;
  release(): Promise<void>;
}

export interface PublishInput {
  cacheKey: string;
  kind: BuildCacheKind;
  attemptId: string;
  riskLevel: RiskLevel;
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | string;
  /** Temp kind-dir path returned from a miss acquire. */
  tempPath: string;
}

export interface EvictResult {
  evictedKeys: string[];
  freedBytes: number;
}

export interface BuildCacheStoreOptions {
  onMetrics?: BuildCacheMetricsSink;
  /** Injectable free-disk probe for eviction. */
  getFreeBytes?: (dir: string) => Promise<number>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** True when the OS reports the PID as an existing process (including EPERM). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    // Process exists but we lack permission to signal it.
    return err.code === 'EPERM';
  }
}

/**
 * Remove a `.lock` when its owner PID is gone or the file is older than
 * {@link LOCK_STALE_MAX_AGE_MS} (crash / abandoned holder). Returns true if removed.
 */
export async function reclaimStaleLockIfNeeded(
  lockFile: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  try {
    const st = await stat(lockFile);
    const ageMs = nowMs - st.mtimeMs;
    let pidAlive = false;
    try {
      const raw = await readFile(lockFile, 'utf8');
      const pid = Number.parseInt(raw.trim(), 10);
      pidAlive = Number.isFinite(pid) && isPidAlive(pid);
    } catch {
      pidAlive = false;
    }
    if (pidAlive && ageMs < LOCK_STALE_MAX_AGE_MS) {
      return false;
    }
    // Dead/unreadable PID → reclaim immediately; aged lock → reclaim even if PID reused.
    if (!pidAlive || ageMs >= LOCK_STALE_MAX_AGE_MS) {
      await rm(lockFile, { force: true });
      return true;
    }
  } catch {
    // Missing lock or race — treat as not reclaimed.
  }
  return false;
}

async function directorySizeBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const full = join(dir, name);
    try {
      const st = await stat(full);
      if (st.isDirectory()) {
        total += await directorySizeBytes(full);
      } else {
        total += st.size;
      }
    } catch {
      // skip
    }
  }
  return total;
}

/**
 * Per-key locked named build-cache store.
 *
 * Layout:
 * - `{root}/{cacheKey}/` — published entry (`.published`, `meta.json`, kind subdir, `.lock`)
 * - `{root}/{cacheKey}.tmp-{attemptId}/` — exclusive miss population dir
 *
 * Eviction order note (disk-pressure): build-cache eviction runs **after** inactive
 * repo-cache eviction. Never removes a key with a live (non-stale) `.lock` or
 * `active_users > 0`. Stale locks (dead PID / age ≥ {@link LOCK_STALE_MAX_AGE_MS})
 * are reclaimed so disk-pressure eviction is not blocked forever.
 */
export class BuildCacheStore {
  private readonly rootDir: string;
  private readonly config: BuildCacheConfig;
  private readonly onMetrics?: BuildCacheMetricsSink;
  private readonly getFreeBytes?: (dir: string) => Promise<number>;

  constructor(rootDir: string, config: BuildCacheConfig, options: BuildCacheStoreOptions = {}) {
    this.rootDir = rootDir;
    this.config = config;
    this.onMetrics = options.onMetrics;
    this.getFreeBytes = options.getFreeBytes;
  }

  private emit(event: BuildCacheMetricsEvent): void {
    emitBuildCacheMetrics(event, this.onMetrics);
  }

  private keyDir(cacheKey: string): string {
    return join(this.rootDir, cacheKey);
  }

  private tempRoot(cacheKey: string, attemptId: string): string {
    return join(this.rootDir, `${cacheKey}.tmp-${attemptId}`);
  }

  private kindRelative(kind: BuildCacheKind): string {
    return getBuildCacheKindDefinition(kind)?.relativeDir ?? kind;
  }

  private metaPath(keyDir: string): string {
    return join(keyDir, META_NAME);
  }

  private publishedPath(keyDir: string): string {
    return join(keyDir, PUBLISHED_MARKER);
  }

  private lockPath(keyDir: string): string {
    return join(keyDir, LOCK_NAME);
  }

  private async readMeta(keyDir: string): Promise<BuildCacheMeta | null> {
    try {
      const raw = await readFile(this.metaPath(keyDir), 'utf8');
      return JSON.parse(raw) as BuildCacheMeta;
    } catch {
      return null;
    }
  }

  private async writeMeta(keyDir: string, meta: BuildCacheMeta): Promise<void> {
    await writeFile(this.metaPath(keyDir), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  }

  private async isPublished(keyDir: string): Promise<boolean> {
    return pathExists(this.publishedPath(keyDir));
  }

  private async acquireExclusiveLock(keyDir: string): Promise<() => Promise<void>> {
    await mkdir(keyDir, { recursive: true });
    const lockFile = this.lockPath(keyDir);
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const handle = await open(lockFile, 'wx');
        await handle.writeFile(`${process.pid}\n`, 'utf8');
        await handle.close();
        // Refresh mtime while held so long miss publishes are not age-reclaimed.
        const touchTimer = setInterval(() => {
          const now = new Date();
          void utimes(lockFile, now, now).catch(() => undefined);
        }, LOCK_TOUCH_INTERVAL_MS);
        touchTimer.unref?.();
        return async () => {
          clearInterval(touchTimer);
          await rm(lockFile, { force: true });
        };
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== 'EEXIST') {
          throw error;
        }
        const reclaimed = await reclaimStaleLockIfNeeded(lockFile);
        if (!reclaimed) {
          await sleep(LOCK_RETRY_MS);
        }
      }
    }
    throw new Error('build_cache_lock_timeout');
  }

  private noopRelease = async (): Promise<void> => undefined;

  async acquireForJob(input: AcquireInput): Promise<AcquireResult> {
    const { cacheKey, kind, attemptId, riskLevel } = input;

    if (!this.config.allowReadRiskLevels.includes(riskLevel)) {
      this.emit({
        event: 'build_cache_refuse',
        kind,
        cache_key: cacheKey,
        reason: 'risk_level',
      });
      return { mode: 'read_disabled', path: '', release: this.noopRelease };
    }

    const keyDir = this.keyDir(cacheKey);
    let releaseLock: (() => Promise<void>) | null = null;

    try {
      releaseLock = await this.acquireExclusiveLock(keyDir);
    } catch {
      this.emit({
        event: 'build_cache_refuse',
        kind,
        cache_key: cacheKey,
        reason: 'lock_timeout',
      });
      return { mode: 'read_disabled', path: '', release: this.noopRelease };
    }

    try {
      if (await this.isPublished(keyDir)) {
        const now = new Date().toISOString();
        const existing = (await this.readMeta(keyDir)) ?? {
          kind,
          cache_key: cacheKey,
          last_used_at: now,
          active_users: 0,
        };
        const meta: BuildCacheMeta = {
          ...existing,
          kind,
          cache_key: cacheKey,
          last_used_at: now,
          active_users: (existing.active_users ?? 0) + 1,
        };
        await this.writeMeta(keyDir, meta);
        await releaseLock();
        releaseLock = null;

        const path = join(keyDir, this.kindRelative(kind));
        await mkdir(path, { recursive: true });
        this.emit({ event: 'build_cache_hit', kind, cache_key: cacheKey });

        let released = false;
        return {
          mode: 'hit',
          path,
          release: async () => {
            if (released) {
              return;
            }
            released = true;
            const unlock = await this.acquireExclusiveLock(keyDir);
            try {
              const current = await this.readMeta(keyDir);
              if (current) {
                await this.writeMeta(keyDir, {
                  ...current,
                  active_users: Math.max(0, (current.active_users ?? 1) - 1),
                  last_used_at: new Date().toISOString(),
                });
              }
            } finally {
              await unlock();
            }
          },
        };
      }

      if (!this.config.allowWriteRiskLevels.includes(riskLevel)) {
        await releaseLock();
        releaseLock = null;
        this.emit({
          event: 'build_cache_refuse',
          kind,
          cache_key: cacheKey,
          reason: 'risk_level',
        });
        return { mode: 'write_disabled', path: '', release: this.noopRelease };
      }

      const tempRoot = this.tempRoot(cacheKey, attemptId);
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
      const path = join(tempRoot, this.kindRelative(kind));
      await mkdir(path, { recursive: true });
      this.emit({ event: 'build_cache_miss', kind, cache_key: cacheKey });

      // Hold exclusive lock for the miss writer until release (after publish or discard).
      const heldUnlock = releaseLock;
      releaseLock = null;
      let released = false;
      return {
        mode: 'miss',
        path,
        release: async () => {
          if (released) {
            return;
          }
          released = true;
          try {
            // Discard temp if still present (publish moves/removes it).
            await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
            if (await this.isPublished(keyDir)) {
              const current = await this.readMeta(keyDir);
              if (current) {
                await this.writeMeta(keyDir, {
                  ...current,
                  active_users: Math.max(0, (current.active_users ?? 1) - 1),
                  last_used_at: new Date().toISOString(),
                });
              }
            }
          } finally {
            await heldUnlock();
          }
        },
      };
    } catch (error) {
      if (releaseLock) {
        await releaseLock().catch(() => undefined);
      }
      throw error;
    }
  }

  async publishIfAllowed(input: PublishInput): Promise<void> {
    const { cacheKey, kind, attemptId, riskLevel, outcome, tempPath } = input;
    const tempRoot = this.tempRoot(cacheKey, attemptId);
    const keyDir = this.keyDir(cacheKey);

    const discardTemp = async (): Promise<void> => {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    };

    if (outcome !== 'succeeded') {
      await discardTemp();
      return;
    }

    if (!this.config.allowWriteRiskLevels.includes(riskLevel)) {
      this.emit({
        event: 'build_cache_refuse',
        kind,
        cache_key: cacheKey,
        reason: 'risk_level',
      });
      await discardTemp();
      return;
    }

    // Ensure temp root exists (tempPath is the kind subdir under temp root).
    if (!(await pathExists(tempRoot)) && !(await pathExists(tempPath))) {
      this.emit({
        event: 'build_cache_refuse',
        kind,
        cache_key: cacheKey,
        reason: 'missing_temp',
      });
      return;
    }

    // Promote: write meta + marker into temp root, then replace published key dir.
    // Lock is held by the miss acquire; we still write under keyDir carefully.
    const now = new Date().toISOString();
    const bytes = await directorySizeBytes(tempRoot);
    const meta: BuildCacheMeta = {
      kind,
      cache_key: cacheKey,
      last_used_at: now,
      active_users: 1, // publisher still holds acquire until release
      bytes,
    };

    // Stage meta + published marker inside temp root (not visible as published key yet).
    await writeFile(join(tempRoot, META_NAME), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
    await writeFile(join(tempRoot, PUBLISHED_MARKER), `${now}\n`, 'utf8');

    // Swap: move current keyDir aside (keeps .lock alive via reopen after),
    // rename temp → keyDir, then restore lock file for the held acquire.
    const backup = join(this.rootDir, `${cacheKey}.bak-${attemptId}`);
    await rm(backup, { recursive: true, force: true }).catch(() => undefined);

    const lockHeld = await pathExists(this.lockPath(keyDir));
    if (await pathExists(keyDir)) {
      await rename(keyDir, backup);
    }
    try {
      await rename(tempRoot, keyDir);
    } catch (error) {
      // Roll back if possible
      if (await pathExists(backup)) {
        await rename(backup, keyDir).catch(() => undefined);
      }
      throw error;
    }

    // Restore exclusive lock marker so release() can still unlock.
    if (lockHeld) {
      try {
        const handle = await open(this.lockPath(keyDir), 'wx');
        await handle.writeFile(`${process.pid}\n`, 'utf8');
        await handle.close();
      } catch {
        // If lock already present (unlikely), leave as-is.
      }
    }

    await rm(backup, { recursive: true, force: true }).catch(() => undefined);

    this.emit({
      event: 'build_cache_publish',
      kind,
      cache_key: cacheKey,
      bytes,
    });
  }

  async evictInactive(options: {
    maxSizeBytes: number;
    minFreeBytes: number;
    now?: Date;
  }): Promise<EvictResult> {
    const nowMs = (options.now ?? new Date()).getTime();
    const retentionMs = this.config.retentionDays * 24 * 60 * 60 * 1000;
    let entries: string[];
    try {
      entries = await readdir(this.rootDir);
    } catch {
      return { evictedKeys: [], freedBytes: 0 };
    }

    type Candidate = { cacheKey: string; lastUsed: number; bytes: number };
    const candidates: Candidate[] = [];
    let totalBytes = 0;

    for (const name of entries) {
      if (name.includes('.tmp-') || name.includes('.bak-')) {
        // Orphan temps older than retention: remove opportunistically
        const full = join(this.rootDir, name);
        try {
          const st = await stat(full);
          if (nowMs - st.mtimeMs >= retentionMs) {
            await rm(full, { recursive: true, force: true });
          }
        } catch {
          // skip
        }
        continue;
      }

      const keyDir = join(this.rootDir, name);
      if (!(await this.isPublished(keyDir))) {
        continue;
      }
      const lockFile = this.lockPath(keyDir);
      if (await pathExists(lockFile)) {
        const reclaimed = await reclaimStaleLockIfNeeded(lockFile, nowMs);
        if (!reclaimed) {
          continue;
        }
      }
      const meta = await this.readMeta(keyDir);
      if (!meta || (meta.active_users ?? 0) > 0) {
        continue;
      }
      const bytes = meta.bytes ?? (await directorySizeBytes(keyDir));
      totalBytes += bytes;
      const lastUsed = meta.last_used_at ? Date.parse(meta.last_used_at) : 0;
      candidates.push({ cacheKey: name, lastUsed, bytes });
    }

    candidates.sort((a, b) => a.lastUsed - b.lastUsed);

    const freeBytes =
      (await this.getFreeBytes?.(this.rootDir)) ??
      Math.max(0, options.maxSizeBytes > 0 ? options.maxSizeBytes - totalBytes : 0);

    const needQuota = totalBytes > options.maxSizeBytes;
    const needFree = freeBytes < options.minFreeBytes;
    if (!needQuota && !needFree && retentionMs > 0) {
      // Still allow retention-based eviction of old inactive keys
    }

    const evictedKeys: string[] = [];
    let freedBytes = 0;

    for (const candidate of candidates) {
      const overQuota = totalBytes - freedBytes > options.maxSizeBytes;
      const underFree = freeBytes + freedBytes < options.minFreeBytes;
      const expired = retentionMs === 0 || nowMs - candidate.lastUsed >= retentionMs;
      if (!overQuota && !underFree && !expired) {
        continue;
      }

      // Re-check lock / active_users immediately before delete
      const keyDir = this.keyDir(candidate.cacheKey);
      const lockFile = this.lockPath(keyDir);
      if (await pathExists(lockFile)) {
        const reclaimed = await reclaimStaleLockIfNeeded(lockFile, nowMs);
        if (!reclaimed) {
          continue;
        }
      }
      const meta = await this.readMeta(keyDir);
      if (meta && (meta.active_users ?? 0) > 0) {
        continue;
      }

      const kind = meta?.kind ?? 'npm';
      await rm(keyDir, { recursive: true, force: true });
      evictedKeys.push(candidate.cacheKey);
      freedBytes += candidate.bytes;
      this.emit({
        event: 'build_cache_evict',
        kind,
        cache_key: candidate.cacheKey,
        bytes: candidate.bytes,
        reason: overQuota ? 'quota' : underFree ? 'min_free' : 'retention',
      });
    }

    return { evictedKeys, freedBytes };
  }

  /** List published opaque keys for capability advertisement. */
  async listPublishedKeys(): Promise<Array<{ kind: BuildCacheKind; keys: string[] }>> {
    let entries: string[];
    try {
      entries = await readdir(this.rootDir);
    } catch {
      return [];
    }
    const byKind = new Map<BuildCacheKind, string[]>();
    for (const name of entries) {
      if (name.includes('.tmp-') || name.includes('.bak-')) {
        continue;
      }
      const keyDir = join(this.rootDir, name);
      if (!(await this.isPublished(keyDir))) {
        continue;
      }
      const meta = await this.readMeta(keyDir);
      const underscore = name.indexOf('_');
      const prefix = underscore > 0 ? name.slice(0, underscore) : '';
      const kind = (meta?.kind ?? prefix) as BuildCacheKind;
      if (!kind) {
        continue;
      }
      const list = byKind.get(kind) ?? [];
      list.push(name);
      byKind.set(kind, list);
    }
    return [...byKind.entries()]
      .filter(([, keys]) => keys.length > 0)
      .map(([kind, keys]) => ({ kind, keys: keys.sort() }));
  }
}
