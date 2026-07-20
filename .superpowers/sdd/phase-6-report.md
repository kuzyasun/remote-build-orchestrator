# Phase 6 Completion Report — Long-running reliability & attempt reconciliation

**Status:** COMPLETE  
**Date:** 2026-07-21  
**Branch:** feat/initial-version  
**Commits:** none (Tasks 1–5 uncommitted per SDD instructions)  
**Plan:** `docs/superpowers/plans/2026-07-21-phase6-reliability.md`

## Exit criteria

- Long-running safe jobs survive temporary disconnect with ordered, non-duplicated durable logs (`job_logs` / cursor).
- Stale attempts cannot publish logs/artifacts after fence advance (`terminate_stale`).
- Destructive/hardware jobs self-terminate at local lease expiry without Controller contact.
- Spool pressure is bounded; spool-cap breach fails with explicit `log_spool_limit` (not silent discard).
- `pnpm verify` → **exit 0**.

## Files changed (Phase 6 aggregate)

### Protocol / shared
- `packages/protocol/src/messages.ts`, `schemas.ts` — `log_ack`, `recovery_report`, `reconcile_decision`
- `packages/protocol/test/protocol-phase6.test.ts`, `protocol.test.ts`
- `packages/shared/src/errors.ts` — `log_spool_limit`

### Executor spool
- `packages/executor/src/spool.ts` (**created**), `index.ts`
- `packages/executor/test/spool.test.ts` (**created**)

### Controller
- `apps/controller/src/storage/migrations.ts` — migration v3 recovery columns
- `apps/controller/src/jobs/lifecycle.ts` — attempt recovery fields
- `apps/controller/src/recovery/coordinator.ts` (**created**) — grace / orphan / adopt / lost / startup
- `apps/controller/src/execution/remote-execution.ts` — idempotent `log_chunk` + `log_ack`; fence all frames
- `apps/controller/src/websocket/server.ts`, `http/data-plane.ts`, `config.ts`, `main.ts`
- Tests: `migration-v3`, `log-spool`, `reconnect-reconcile`, `disk-pressure`, **`phase6-reliability`**

### Agent
- `apps/agent/src/logs/spool-sender.ts` (**created**)
- `apps/agent/src/recovery/attempt-metadata.ts`, `coordinator.ts`, `disk-pressure.ts` (**created**)
- `apps/agent/src/executor/index.ts` — disk-first spool, lease self-term, artifact resume, spool limit
- `apps/agent/src/connection/client.ts`, `capabilities/probe.ts`, `config.ts`, `main.ts`
- Tests: `lease-self-term`, `artifact-resume`, cancel-signal updates

### Docs / SDD
- `docs/superpowers/plans/2026-07-21-phase6-reliability.md`
- `.superpowers/sdd/task-{1..5}-brief.md`, `task-{1..5}-report.md`, review diffs, `progress.md`

## Tests added / extended

| Suite | Role |
|-------|------|
| `packages/protocol/test/protocol-phase6.test.ts` | Wire schemas |
| `packages/executor/test/spool.test.ts` | AttemptSpool sequences / ack / replay |
| `apps/controller/test/migration-v3.test.ts` | DB columns |
| `apps/controller/test/log-spool.test.ts` | Idempotent append + ack |
| `apps/controller/test/reconnect-reconcile.test.ts` | Grace / orphan / adopt / lost |
| `apps/controller/test/disk-pressure.test.ts` | Cleanup order + admission |
| `apps/agent/test/lease-self-term.test.ts` | Hardware self-term |
| `apps/agent/test/artifact-resume.test.ts` | Staging resume, no re-collect |
| `apps/controller/test/phase6-reliability.test.ts` | Fault-injection + memory bound |

Final Vitest (verify): **50 files, 290 passed | 3 skipped**.

## Final gate

```bash
pnpm format   # exit 0
pnpm verify   # exit 0
```

## PLATFORM-GAP grep list

| Location | Tag / note |
|----------|------------|
| `packages/snapshot/test/capture-scenarios.test.ts:246` | OS denied symlink creation — verify on Unix/macOS |
| `packages/snapshot/test/capture-scenarios.test.ts:489` | Case-only filename collision needs case-sensitive FS |
| `packages/executor/test/process-cancel.test.ts:22` | Unix process-group kill / POSIX setsid — verify on Unix/macOS |
| `PHASE_HANDOFFS.md` | Documents above + Phase 3 shell-scope notes |

No new `PLATFORM-GAP` tags were introduced in Phase 6.

## Known limitations / borderline decisions

1. **No auto-retry** on pre-start disconnect or `lost` — Phase 3 policy retained; Controller fails the attempt and does not spawn a replacement.
2. **Agent process restart** relies on disk `metadata.json` + spool; live process reattach is best-effort (in-process reconnect reuses `AgentConnection`).
3. **1 GiB log test** gated by `RBO_LARGE_LOG_TEST`; CI default uses 8 MiB streaming heap assertion.
4. **Disk-pressure cleanup** runs from heartbeat when free disk or spool pressure is detected; not a background GC daemon.
5. **`handleAgentDisconnect` shim** remains a no-op — production path is `RecoveryCoordinator` only.

## Residual risks

- Full multi-process Controller↔Agent disconnect under real TLS/WS load is covered by unit/integration fakes more than a long soak; consider a soak job before production use.
- Heap-bound assertion can flake under heavy parallel Vitest memory pressure (mitigated by 32 MiB ceiling vs 8 MiB payload).
- Orphan timeout / grace defaults (env-configurable) may need tuning per fleet latency.

## Phase 7

**Not started** (per brief).
