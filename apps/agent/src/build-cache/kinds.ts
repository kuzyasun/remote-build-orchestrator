import type { BuildCacheKind } from '@rbo/protocol';
import { BuildCacheKindSchema } from '@rbo/protocol';

export interface BuildCacheKindDefinition {
  kind: BuildCacheKind;
  /** Primary cache directory environment variable. */
  cacheDirEnv: string;
  /** Additional fixed env vars for this kind (never from JobRequest). */
  extraEnv: Record<string, string>;
  /** Relative subdirectory under `{stateDir}/build-caches/<cacheKey>/`. */
  relativeDir: string;
  /**
   * When true, injection requires a selected toolchain profile.
   * Package managers (npm/pnpm/pip) may use profile `"none"` + fingerprint `"none"`.
   */
  requiresToolchain: boolean;
}

/**
 * Fixed named-cache definitions — never derived from JobRequest host paths.
 *
 * npm/pnpm/pip: may key with toolchainProfileId `"none"` and fingerprint `"none"`
 * when no toolchain is selected. ccache/sccache: skip injection without a profile.
 */
export const BUILD_CACHE_KINDS: readonly BuildCacheKindDefinition[] = [
  {
    kind: 'ccache',
    cacheDirEnv: 'CCACHE_DIR',
    extraEnv: { CCACHE_NOHASHDIR: '1' },
    relativeDir: 'ccache',
    requiresToolchain: true,
  },
  {
    kind: 'sccache',
    cacheDirEnv: 'SCCACHE_DIR',
    extraEnv: {},
    relativeDir: 'sccache',
    requiresToolchain: true,
  },
  {
    kind: 'npm',
    cacheDirEnv: 'npm_config_cache',
    extraEnv: {},
    relativeDir: 'npm',
    requiresToolchain: false,
  },
  {
    kind: 'pnpm',
    cacheDirEnv: 'PNPM_STORE_PATH',
    extraEnv: {},
    relativeDir: 'pnpm',
    requiresToolchain: false,
  },
  {
    kind: 'pip',
    cacheDirEnv: 'PIP_CACHE_DIR',
    extraEnv: {},
    relativeDir: 'pip',
    requiresToolchain: false,
  },
] as const;

const KIND_BY_NAME = new Map(BUILD_CACHE_KINDS.map((d) => [d.kind, d]));

/** All env names owned by named caches (dir + extras) — strip from user env. */
export const ALL_CACHE_DIR_ENV_NAMES: readonly string[] = [
  ...new Set(BUILD_CACHE_KINDS.flatMap((d) => [d.cacheDirEnv, ...Object.keys(d.extraEnv)])),
];

/** Map job requirement tool names → fixed cache kinds. */
const TOOL_NAME_TO_KIND: Record<string, BuildCacheKind> = {
  ccache: 'ccache',
  sccache: 'sccache',
  npm: 'npm',
  pnpm: 'pnpm',
  pip: 'pip',
};

export function getBuildCacheKindDefinition(
  kind: BuildCacheKind,
): BuildCacheKindDefinition | undefined {
  return KIND_BY_NAME.get(kind);
}

/** Env for one kind pointing at an absolute cache directory path. */
export function buildCacheEnvForKind(
  kind: BuildCacheKind,
  absoluteCacheDir: string,
): Record<string, string> {
  const def = KIND_BY_NAME.get(kind);
  if (!def) {
    return {};
  }
  return {
    [def.cacheDirEnv]: absoluteCacheDir,
    ...def.extraEnv,
  };
}

/**
 * enabledKinds ∩ tools relevant to the job.
 * When no tools are declared, all enabled kinds are candidates.
 */
export function resolveRelevantBuildCacheKinds(input: {
  enabledKinds: readonly BuildCacheKind[];
  requiredTools?: Record<string, string>;
}): BuildCacheKind[] {
  const enabled = new Set(input.enabledKinds);
  const tools = input.requiredTools;
  if (!tools || Object.keys(tools).length === 0) {
    return BUILD_CACHE_KINDS.map((d) => d.kind).filter((k) => enabled.has(k));
  }
  const fromTools = new Set<BuildCacheKind>();
  for (const toolName of Object.keys(tools)) {
    const kind = TOOL_NAME_TO_KIND[toolName.toLowerCase()];
    if (kind && enabled.has(kind)) {
      fromTools.add(kind);
    }
  }
  return BUILD_CACHE_KINDS.map((d) => d.kind).filter((k) => fromTools.has(k));
}

/** Remove known cache env names so JobRequest cannot smuggle host paths. */
export function stripUserBuildCacheEnv(
  env: Record<string, string> | undefined,
): Record<string, string> {
  if (!env) {
    return {};
  }
  const out: Record<string, string> = { ...env };
  for (const name of ALL_CACHE_DIR_ENV_NAMES) {
    delete out[name];
  }
  return out;
}

export function isBuildCacheKind(value: string): value is BuildCacheKind {
  return BuildCacheKindSchema.safeParse(value).success;
}
