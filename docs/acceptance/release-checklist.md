# §37 Acceptance checklist (release readiness)

Each criterion links to a test, evidence artifact, or explicit environment gate.
Statuses: `pass` | `environment_gated` | `not_verified`.

| # | Criterion | Status | Link |
|---|---|---|---|
| 1 | AI clients verified config + MCP smoke matrix | not_verified | `docs/compatibility/matrix.json` (product clients); harness `pass` via `mcp-smoke-workflow.test.ts` |
| 2 | stdio & Streamable HTTP same schemas/results | pass | `apps/controller/test/transports.test.ts`, `mcp-smoke-workflow.test.ts` |
| 3 | job_submit after immutable snapshot; edits isolated | pass | `apps/controller/test/job-execution.test.ts` |
| 4 | workspace_changed on cooperative lock breach | pass | `packages/snapshot/test/capture-scenarios.test.ts` |
| 5 | Auto-select OS + toolchain profile | pass | `apps/controller/test/scheduler*.test.ts` |
| 6 | idf.py matches ESP-IDF profile | environment_gated | Requires ESP-IDF toolchain on host |
| 7 | Agent uses cached repository | pass | Phase 5 overlay/cache tests |
| 8 | Dirty tree materialize correctness | pass | `packages/snapshot/test/*`, overlay tests |
| 9 | Local unpushed HEAD | pass | Phase 5 bundle tests |
| 10 | Additional folder mounts | pass | capture/materialize additional_roots tests |
| 11 | QEMU script minutes + logs | environment_gated | `qemu-docker-workloads.test.ts` fake QEMU; real QEMU gated |
| 12 | Docker Compose cleanup | environment_gated | `docker-cleanup.test.ts` skipIf !docker |
| 13 | Cancel kills process tree | pass | Windows Job Object tests; Unix PLATFORM-GAP |
| 14 | Disconnect keeps logs; no duplicate attempt | pass | `reliability-reconciliation.test.ts` |
| 15 | Hardware/destructive self-stop + confirmation | pass | lease-self-term + job-confirm tests |
| 16 | Artifacts per-attempt; allowed materialize | pass | `job-execution.test.ts` |
| 17 | Local fallback only under explicit policy | pass | `allow-local-fallback.test.ts` |
| 18 | Secrets + path attacks blocked | pass | secret-policy + threat coverage |
| 19 | Rebuild does not transfer whole repo | pass | Phase 5 overlay byte-count tests |
| 20 | Warm cache not reused across fingerprint | pass | `build-cache-store.test.ts` |
| 21 | Agent OS service; reboot; revoke | environment_gated | service plans tested; elevated e2e PLATFORM-GAP |
| 22 | Job metadata fields | pass | job_get / attempt persistence tests |
| 23 | Benchmark report metrics | pass | `build-cache-benchmark.test.ts` + `docs/ops/observability-report.md` |

## Sign-off

This release treats product AI-client cells as `not_verified` until real client evidence exists (Option A).
Transport harness cells are verified.
