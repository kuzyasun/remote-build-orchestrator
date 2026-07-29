import type { BuildCacheKind } from '@rbo/protocol';
import { computeBuildCacheKey as computeShared } from '@rbo/shared';

export interface ComputeBuildCacheKeyInput {
  kind: BuildCacheKind;
  toolchainProfileId: string;
  toolchainFingerprint: string;
  osFamily: string;
  arch: string;
  /** repo_key or `"local:"` + content_id / project root hash — never secrets. */
  projectIdentity: string;
}

/**
 * Opaque cache identity: `${kind}_${sha256(canonicalJson).slice(0, 32)}`.
 *
 * For npm/pnpm/pip without a selected toolchain, callers pass
 * `toolchainProfileId: "none"` and `toolchainFingerprint: "none"`.
 * ccache/sccache must not be keyed without a real profile (skip injection instead).
 */
export function computeBuildCacheKey(input: ComputeBuildCacheKeyInput): string {
  return computeShared(input);
}
