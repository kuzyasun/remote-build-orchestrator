# Product readiness checklist

Use this checklist to review product behavior before a release. The command sequence for building
and publishing lives in [Release and publish](release-builds.md).

Statuses:

- `pass` — covered by an automated test;
- `environment_gated` — requires external software, hardware, or elevation;
- `not_verified` — requires a real client smoke test that has not been recorded for this release.

| # | Criterion | Status | Evidence or gate |
| --- | --- | --- | --- |
| 1 | Real AI client configuration and MCP workflow | not_verified | `docs/archive/reports/matrix.json`; protocol harness: `apps/controller/test/mcp-smoke-workflow.test.ts` |
| 2 | stdio and Streamable HTTP expose the same behavior | pass | `apps/controller/test/transports.test.ts` |
| 3 | submitted edits are isolated in an immutable snapshot | pass | `apps/controller/test/job-execution.test.ts` |
| 4 | concurrent edits fail capture instead of producing a mixed snapshot | pass | `packages/snapshot/test/capture-scenarios.test.ts` |
| 5 | scheduler filters by OS, tools, and capacity | pass | `apps/controller/test/scheduler*.test.ts` |
| 6 | tool-specific requirements reach only capable Agents | pass | `apps/controller/test/scheduler-git-tools.test.ts` |
| 7 | Agent repository cache and Git overlay reproduce dirty source | pass | `packages/snapshot/test/overlay.test.ts` |
| 8 | submodules and Git LFS follow the source policy | pass | `packages/snapshot/test/submodule-lfs.test.ts` |
| 9 | a locally available base commit can be transferred safely | pass | `apps/controller/test/source-need.test.ts` |
| 10 | additional roots materialize only at declared mounts | pass | `packages/snapshot/test/materialize.test.ts` |
| 11 | QEMU-style workloads produce logs and completion results | environment_gated | `apps/agent/test/qemu-docker-workloads.test.ts`; real QEMU requires its toolchain |
| 12 | Docker resources are cleaned without a global prune | environment_gated | `apps/agent/test/docker-cleanup.test.ts`; real run requires Docker |
| 13 | cancellation terminates the process tree where supported | environment_gated | `packages/executor/test/process-cancel.test.ts`; Unix lacks equivalent containment |
| 14 | reconnect and restart do not duplicate attempts or acknowledged logs | pass | `apps/controller/test/reliability-reconciliation.test.ts` |
| 15 | destructive and hardware jobs require confirmation and self-terminate | pass | `apps/agent/test/lease-self-term.test.ts`, `apps/controller/test/job-confirm-negatives.test.ts` |
| 16 | artifacts stay attempt-scoped and materialize only to allowed paths | pass | `packages/executor/test/artifacts.test.ts` |
| 17 | local fallback follows policy and host-load limits | pass | `apps/controller/test/allow-local-fallback.test.ts`, `apps/controller/test/local-fallback-host-load.test.ts` |
| 18 | secret, token, and path attacks are covered | pass | `docs/archive/reports/threat-coverage.json` |
| 19 | repeated builds transfer an overlay instead of the full repository | pass | `packages/snapshot/test/overlay.test.ts` |
| 20 | build caches do not cross incompatible fingerprints | pass | `apps/agent/test/build-cache-warm.test.ts` |
| 21 | Agent service install, reboot, and revocation work on target OS | environment_gated | `apps/cli/test/service.test.ts`; elevated end-to-end smoke required |
| 22 | job metadata and wire incompatibility remain diagnostic | pass | `apps/controller/test/wire-upgrade-downgrade.test.ts` |
| 23 | cold/warm cache benchmark metrics are produced | pass | `apps/agent/test/build-cache-benchmark.test.ts` |

## Sign-off

Before publishing, record:

- release version and commit;
- `pnpm format`, `pnpm verify`, build, and package verification results;
- environment-gated checks actually run;
- real AI clients and versions actually tested;
- known gaps carried into the release notes.
