/**
 * Observability field redaction for Phase 8 reports (§32).
 * IDs may appear as correlation fields; secrets/tokens/credentials/raw logs must not.
 */

const SENSITIVE_KEY =
  /(secret|token|password|authorization|credential|private[_-]?key|api[_-]?key)/i;

export const OBSERVABILITY_REQUIRED_FIELDS = [
  'queue_wait_ms',
  'snapshot_capture_ms',
  'transfer_ms',
  'execution_ms',
  'cold_build_ms',
  'warm_build_ms',
  'cache_hit_rate',
  'local_fallback_rate',
  'agent_selection',
  'lease_id',
  'lease_epoch',
  'toolchain_fingerprint',
  'terminal_outcome',
] as const;

export type ObservabilityReport = Record<string, unknown> & {
  schema_version: 1;
};

export function redactObservabilityValue(key: string, value: unknown): unknown {
  if (SENSITIVE_KEY.test(key)) {
    return '[REDACTED]';
  }
  if (typeof value === 'string' && /Bearer\s+\S+/i.test(value)) {
    return value.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return redactObservabilityObject(value as Record<string, unknown>);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => redactObservabilityValue(String(index), item));
  }
  return value;
}

export function redactObservabilityObject(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = redactObservabilityValue(key, value);
  }
  return out;
}

export function buildObservabilityReportSkeleton(
  overrides?: Partial<ObservabilityReport>,
): ObservabilityReport {
  return {
    schema_version: 1,
    queue_wait_ms: null,
    snapshot_capture_ms: null,
    transfer_ms: null,
    execution_ms: null,
    cold_build_ms: null,
    warm_build_ms: null,
    cache_hit_rate: null,
    local_fallback_rate: null,
    agent_selection: null,
    lease_id: null,
    lease_epoch: null,
    toolchain_fingerprint: null,
    terminal_outcome: null,
    ...overrides,
  };
}
