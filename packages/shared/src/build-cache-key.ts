import { sha256 } from './hashing.js';

export interface ComputeBuildCacheKeyInput {
  /** Fixed named-cache kind (ccache/sccache/npm/pnpm/pip). */
  kind: string;
  toolchainProfileId: string;
  toolchainFingerprint: string;
  osFamily: string;
  arch: string;
  /** repo_key or `"local:"` + content_id / project root hash — never secrets. */
  projectIdentity: string;
}

/** Canonical JSON with sorted keys — material must contain no secrets. */
function canonicalJson(material: Record<string, string>): string {
  const ordered: Record<string, string> = {};
  for (const key of Object.keys(material).sort()) {
    ordered[key] = material[key] as string;
  }
  return JSON.stringify(ordered);
}

/**
 * Opaque cache identity: `${kind}_${sha256(canonicalJson).slice(0, 32)}`.
 *
 * For npm/pnpm/pip without a selected toolchain, callers pass
 * `toolchainProfileId: "none"` and `toolchainFingerprint: "none"`.
 * ccache/sccache must not be keyed without a real profile (skip injection instead).
 */
export function computeBuildCacheKey(input: ComputeBuildCacheKeyInput): string {
  const material = {
    arch: input.arch,
    kind: input.kind,
    osFamily: input.osFamily,
    projectIdentity: input.projectIdentity,
    toolchainFingerprint: input.toolchainFingerprint,
    toolchainProfileId: input.toolchainProfileId,
  };
  const digest = sha256(canonicalJson(material));
  return `${input.kind}_${digest.slice(0, 32)}`;
}
