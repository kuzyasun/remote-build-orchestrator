# Observability report (Phase 8 / §32)

Structured metrics for release hardening. Correlation may include job/attempt/agent IDs.
**Never** publish secret values, tokens, raw credentials, or unredacted logs.

| Metric | Description | Example source |
|---|---|---|
| queue_wait_ms | Time from queued → leased/started | Controller job events |
| snapshot_capture_ms | Cooperative capture duration | snapshot capture |
| transfer_ms | Snapshot/artifact transfer | data plane |
| execution_ms | Process run duration | attempt timing |
| cold_build_ms | Cold cache build | Phase 7 benchmark |
| warm_build_ms | Warm cache build | Phase 7 benchmark |
| cache_hit_rate | Named build-cache hits | Agent build-cache metrics |
| local_fallback_rate | Jobs that used local_fallback | scheduler decisions |
| agent_selection | Selected agent_id + score inputs | scheduler audit |
| lease_id / lease_epoch | Fencing correlation | attempt row |
| toolchain_fingerprint | Selected profile fingerprint | lease/run payload |
| terminal_outcome | succeeded/failed/timed_out/cancelled/lost | job outcome |

Generator helpers: `apps/controller/src/ops/observability.ts` (`redactObservabilityObject`,
`buildObservabilityReportSkeleton`). Cold/warm/cache fields may be filled from
`build-cache-benchmark` test output when that suite is run.
