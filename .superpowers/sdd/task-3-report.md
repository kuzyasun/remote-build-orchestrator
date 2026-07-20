# Task 3 Report — Recovery coordinators (disconnect grace, orphan, adopt)

**Status:** DONE  
**Date:** 2026-07-21  
**Commits:** none (per instructions)

## Summary

Controller and Agent `RecoveryCoordinator`s own disconnect grace → orphan → adopt / `terminate_stale` / `lost`. Immediate fail-all on WS close is removed. Agent parks safe/normal (and destructive until lease expiry) through grace, persists `metadata.json`, emits `recovery_report`, and starts spool replay only after `reconcile_decision.action=adopt`.

## Design choices

| Topic | Choice |
|-------|--------|
| Pre-`job_started` disconnect | `outcome=failed`, `failure_category=agent_disconnected`; **no** new attempt / requeue (Phase 3 no auto-retry) |
| Process identity | Canonical `pid:<n>` set on Agent spawn + Controller `job_started` |
| Orphan vs lease sweep | `expireStaleLeases` skips `orphaned`; disconnect extends `lease_deadline` across grace+orphan |
| Destructive/hardware | Parked on disconnect; lease-expiry self-term deferred to Task 4 |

## TDD

### RED
`pnpm exec vitest run apps/controller/test/reconnect-reconcile.test.ts` — fail: missing `RecoveryCoordinator`.

### GREEN
Same file: **5 passed**. Full gate: `pnpm format` + `pnpm verify` → **exit 0**.

## Files

| File | Change |
|------|--------|
| `apps/controller/src/recovery/coordinator.ts` | **Created** — grace/orphan/adopt/lost/startup |
| `apps/agent/src/recovery/coordinator.ts` | **Created** — report, adopt→`startReplay`, terminate_stale |
| `apps/agent/src/recovery/attempt-metadata.ts` | **Created** — atomic `metadata.json` |
| `apps/controller/test/reconnect-reconcile.test.ts` | **Created** — 5 reconcile scenarios |
| `apps/controller/src/websocket/server.ts` | Coordinator on close; `recovery_report` |
| `apps/controller/src/execution/remote-execution.ts` | No immediate disconnect fail; `process_identity` on `job_started`; skip orphaned lease expiry |
| `apps/agent/src/connection/client.ts` | Park on disconnect; `reconcile_decision`; reuse executor |
| `apps/agent/src/executor/index.ts` | Metadata; park vs `forceAbandon`; register sender |
| `apps/agent/src/main.ts` | Reuse connection; kill only on stop |
| `apps/*/src/config.ts` | `RBO_DISCONNECT_GRACE_SECONDS` (60), `RBO_ORPHAN_TIMEOUT_SECONDS` (300), `RBO_RECONCILE_DEADLINE_SECONDS` (120) |

Skipped (Task 4): disk-pressure admission, artifact upload resume, lease-expiry self-termination.

## Concerns

- In-process reconnect reuses one `AgentConnection`; Agent **process** restart relies on disk metadata (OS reattach of kill handle is best-effort).
- `handleAgentDisconnect(db, agentId)` is a no-op shim — production path is `RecoveryCoordinator` only.
- Destructive/hardware still parks until Task 4 lease timer.

## Test commands

```bash
pnpm exec vitest run apps/controller/test/reconnect-reconcile.test.ts
pnpm format
pnpm verify
```

## Fix pass (review Critical/Important)

**Date:** 2026-07-21  
**Status:** DONE

### Fixes

| Finding | Fix |
|---------|-----|
| Critical 1 — `terminate_stale` stuck orphaned | On fence-mismatch `terminate_stale`, mark attempt+job `completed`/`failed` with `agent_lost` (or `lease_expired` for `newer_epoch`); clear `orphaned_at`. `agent_mismatch` re-arms orphan/grace watchdog instead of failing the owning attempt. |
| Critical 2 — completion during disconnect | Agent persists `completed_awaiting_upload` + `last_exit` before `job_exit`; adopt re-sends `job_exit`. Controller accepts `job_exit` in `orphaned` and `collecting_artifacts`; clears `orphaned_at`. |
| Important 3 — `process_identity` race | Pre-start fail requires pre-start states **and** missing identity; `running`/`collecting_artifacts`/`orphaned` enter grace even if identity is null. Adopt fills identity when Controller had null. |

### Commands + results

```bash
pnpm exec vitest run apps/controller/test/reconnect-reconcile.test.ts
# → 10 passed

pnpm exec vitest run apps/controller/test/remote-cancel-reject.test.ts \
  apps/controller/test/log-spool.test.ts \
  apps/agent/test/cancel-signal.test.ts \
  packages/protocol/test/protocol-phase6.test.ts
# → 16 passed (4 files)
```

### Files touched

| File | Change |
|------|--------|
| `apps/controller/src/recovery/coordinator.ts` | Terminalize on terminate_stale; pre-start state gate; adopt with null identity |
| `apps/controller/src/execution/remote-execution.ts` | `job_exit` allowed in orphaned/collecting_artifacts; clear orphaned_at |
| `apps/agent/src/recovery/attempt-metadata.ts` | `last_exit` on metadata |
| `apps/agent/src/recovery/coordinator.ts` | Preserve completed_awaiting_upload; re-send job_exit on adopt |
| `apps/agent/src/executor/index.ts` | Persist completed_awaiting_upload; `resendJobExitIfCompleted` |
| `apps/agent/src/connection/client.ts` | Wire `resendJobExit` hook |
| `apps/controller/test/reconnect-reconcile.test.ts` | +5 scenarios (grace adopt, terminate terminal, completion-during-disconnect, process_identity race) |

### Remaining concerns

- Full artifact resume after `completed_awaiting_upload` still Task 4 (only `job_exit` re-send here).
- `terminate_stale` on `newer_epoch` fails the Controller attempt row (matches no auto-retry); a true replacement attempt would need a new row.
