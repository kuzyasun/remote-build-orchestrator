import type { BuildCacheKind, RiskLevel } from '@rbo/protocol';

export type BuildCacheRiskLevel = RiskLevel;

export interface BuildCacheConfig {
  enabledKinds: BuildCacheKind[];
  maxSizeGb: number;
  minFreeDiskGb: number;
  retentionDays: number;
  /** destructive/hardware: deny read+write unless overridden */
  allowReadRiskLevels: BuildCacheRiskLevel[];
  allowWriteRiskLevels: BuildCacheRiskLevel[];
}

export const DEFAULT_BUILD_CACHE_CONFIG: BuildCacheConfig = {
  enabledKinds: ['ccache', 'sccache', 'npm', 'pnpm', 'pip'],
  maxSizeGb: 20,
  minFreeDiskGb: 5,
  retentionDays: 14,
  allowReadRiskLevels: ['safe', 'normal'],
  allowWriteRiskLevels: ['safe', 'normal'],
};
