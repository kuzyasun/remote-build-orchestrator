import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { BuildCacheKind } from '@rbo/protocol';
import type { BuildCacheConfig, BuildCacheRiskLevel } from './config.js';
import { computeBuildCacheKey } from './key.js';
import {
  BUILD_CACHE_KINDS,
  buildCacheEnvForKind,
  getBuildCacheKindDefinition,
  isBuildCacheKind,
  resolveRelevantBuildCacheKinds,
} from './kinds.js';

export type { BuildCacheConfig, BuildCacheRiskLevel } from './config.js';
export { DEFAULT_BUILD_CACHE_CONFIG } from './config.js';
export type { ComputeBuildCacheKeyInput } from './key.js';
export { computeBuildCacheKey } from './key.js';
export type { BuildCacheKindDefinition } from './kinds.js';
export {
  ALL_CACHE_DIR_ENV_NAMES,
  BUILD_CACHE_KINDS,
  buildCacheEnvForKind,
  getBuildCacheKindDefinition,
  isBuildCacheKind,
  resolveRelevantBuildCacheKinds,
  stripUserBuildCacheEnv,
} from './kinds.js';
export type { BuildCacheMetricsEvent, BuildCacheMetricsSink } from './metrics.js';
export { emitBuildCacheMetrics } from './metrics.js';
export type {
  AcquireInput,
  AcquireMode,
  AcquireResult,
  EvictResult,
  PublishInput,
} from './store.js';
export {
  BuildCacheStore,
  LOCK_STALE_MAX_AGE_MS,
  isPidAlive,
  reclaimStaleLockIfNeeded,
} from './store.js';

export interface SelectedToolchainRef {
  id: string;
  environment_fingerprint: string;
}

export interface ResolveBuildCacheInjectionInput {
  stateDir: string;
  config: BuildCacheConfig;
  preferBuildCache: boolean;
  riskLevel: BuildCacheRiskLevel;
  osFamily: string;
  arch: string;
  projectIdentity: string;
  selectedToolchain: SelectedToolchainRef | null | undefined;
  requiredTools?: Record<string, string>;
}

export interface ResolvedBuildCacheTarget {
  kind: BuildCacheKind;
  cacheKey: string;
  /** Published kind dir path (not used for miss population — store returns temp). */
  publishedKindDir: string;
}

export interface ResolveBuildCacheInjectionResult {
  env: Record<string, string>;
  injectedKinds: BuildCacheKind[];
  /** Absolute dirs that should exist before spawn (legacy; prefer store acquire). */
  cacheDirs: string[];
  /** Per-kind opaque keys for BuildCacheStore.acquireForJob / scheduler ads. */
  targets: ResolvedBuildCacheTarget[];
}

/**
 * Resolve safe cache env injection for a job.
 * Only sets documented kind env vars under `{stateDir}/build-caches/<key>/<subdir>`.
 * Never accepts host paths from JobRequest.
 *
 * Prefer `BuildCacheStore.acquireForJob` for actual dir preparation (Task 4);
 * this helper still computes keys + published paths for capability / scheduler use.
 */
export function resolveBuildCacheInjection(
  input: ResolveBuildCacheInjectionInput,
): ResolveBuildCacheInjectionResult {
  if (!input.preferBuildCache) {
    return { env: {}, injectedKinds: [], cacheDirs: [], targets: [] };
  }
  if (!input.config.allowReadRiskLevels.includes(input.riskLevel)) {
    return { env: {}, injectedKinds: [], cacheDirs: [], targets: [] };
  }

  const candidates = resolveRelevantBuildCacheKinds({
    enabledKinds: input.config.enabledKinds,
    requiredTools: input.requiredTools,
  });

  const toolchain = input.selectedToolchain;
  const env: Record<string, string> = {};
  const injectedKinds: BuildCacheKind[] = [];
  const cacheDirs: string[] = [];
  const targets: ResolvedBuildCacheTarget[] = [];

  for (const kind of candidates) {
    const def = getBuildCacheKindDefinition(kind);
    if (!def) {
      continue;
    }
    if (def.requiresToolchain && !toolchain) {
      // miss — ccache/sccache need a selected profile
      continue;
    }
    const toolchainProfileId = toolchain?.id ?? 'none';
    const toolchainFingerprint = toolchain?.environment_fingerprint ?? 'none';
    const cacheKey = computeBuildCacheKey({
      kind,
      toolchainProfileId,
      toolchainFingerprint,
      osFamily: input.osFamily,
      arch: input.arch,
      projectIdentity: input.projectIdentity,
    });
    const absoluteDir = join(input.stateDir, 'build-caches', cacheKey, def.relativeDir);
    Object.assign(env, buildCacheEnvForKind(kind, absoluteDir));
    injectedKinds.push(kind);
    cacheDirs.push(absoluteDir);
    targets.push({ kind, cacheKey, publishedKindDir: absoluteDir });
  }

  return { env, injectedKinds, cacheDirs, targets };
}

export type PresentBuildCacheAdvertisement = {
  kind: BuildCacheKind;
  keys: string[];
};

/** Best-effort scan of published `{stateDir}/build-caches/<cacheKey>/` for capability ads. */
export async function listPresentBuildCacheKeys(
  stateDir: string,
  enabledKinds: readonly BuildCacheKind[] = BUILD_CACHE_KINDS.map((d) => d.kind),
): Promise<PresentBuildCacheAdvertisement[]> {
  const enabled = new Set(enabledKinds);
  const root = join(stateDir, 'build-caches');
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }

  const byKind = new Map<BuildCacheKind, string[]>();
  for (const kind of BUILD_CACHE_KINDS.map((d) => d.kind)) {
    byKind.set(kind, []);
  }

  for (const name of entries) {
    if (name.includes('.tmp-') || name.includes('.bak-')) {
      continue;
    }
    const underscore = name.indexOf('_');
    if (underscore <= 0) {
      continue;
    }
    const prefix = name.slice(0, underscore);
    if (!isBuildCacheKind(prefix) || !enabled.has(prefix)) {
      continue;
    }
    // Opaque keys only: kind_ + 32 hex chars
    const suffix = name.slice(underscore + 1);
    if (!/^[0-9a-f]{32}$/i.test(suffix)) {
      continue;
    }
    try {
      await access(join(root, name, '.published'));
    } catch {
      continue;
    }
    byKind.get(prefix)?.push(name);
  }

  const out: PresentBuildCacheAdvertisement[] = [];
  for (const kind of enabledKinds) {
    const keys = byKind.get(kind) ?? [];
    if (keys.length > 0) {
      out.push({ kind, keys: keys.sort() });
    }
  }
  return out;
}

export function resolveBuildCachesDir(stateDir: string): string {
  return join(stateDir, 'build-caches');
}
