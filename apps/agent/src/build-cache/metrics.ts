import type { BuildCacheKind } from '@rbo/protocol';
import { createLogger } from '@rbo/shared';

const logger = createLogger('agent.build-cache');

export interface BuildCacheMetricsEvent {
  event:
    | 'build_cache_hit'
    | 'build_cache_miss'
    | 'build_cache_publish'
    | 'build_cache_evict'
    | 'build_cache_refuse';
  kind: BuildCacheKind;
  /** Redacted: only the opaque cache key id, never secret values */
  cache_key: string;
  bytes?: number;
  reason?: string; // e.g. risk_level, quota, lock_timeout, fingerprint_mismatch
}

export type BuildCacheMetricsSink = (event: BuildCacheMetricsEvent) => void;

/** Emit structured logger events; secret values must never appear in fields. */
export function emitBuildCacheMetrics(
  event: BuildCacheMetricsEvent,
  sink?: BuildCacheMetricsSink,
): void {
  sink?.(event);
  logger.info(event.event, {
    event: event.event,
    kind: event.kind,
    cache_key: event.cache_key,
    ...(event.bytes !== undefined ? { bytes: event.bytes } : {}),
    ...(event.reason !== undefined ? { reason: event.reason } : {}),
  });
}
