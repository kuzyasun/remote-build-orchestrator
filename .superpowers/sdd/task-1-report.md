# Task 1 Report — Typed schemas, error category, Controller migration

**Status:** DONE  
**Date:** 2026-07-21  
**Commits:** none (per instructions)

## Summary

Implemented Phase 6 wire contracts (`log_ack`, `recovery_report`, `reconcile_decision`), `log_spool_limit` error category, migration v3 columns on `job_attempts`, and lifecycle helpers. No spool/sender/reconnect behavior (Tasks 2–5).

## TDD Evidence

### RED (Step 2)

Command:
```bash
pnpm exec vitest run packages/protocol/test/protocol-phase6.test.ts apps/controller/test/migration-v3.test.ts
```

Result: **8 failed | 1 passed** (exit code 1)

- Protocol: missing `log_spool_limit`, message types, payload schemas (7 failures); envelope test passed only because `log_ack` was not yet job-scoped.
- Migration: `getSchemaVersion` was 2, expected 3.

### GREEN (Step 5)

Same command after implementation: **9 passed** (exit code 0)

Final gate:
```bash
pnpm format && pnpm verify
```
Exit code 0 (all lint, build, tests, rust:verify passed on second run after updating `protocol.test.ts` message-type counts).

## Files Changed

| File | Change |
|------|--------|
| `packages/shared/src/errors.ts` | Added `log_spool_limit` before `internal` |
| `packages/protocol/src/messages.ts` | New message types, job-scoped set entries, payload schemas + types |
| `packages/protocol/test/protocol-phase6.test.ts` | **Created** — Phase 6 protocol tests |
| `packages/protocol/test/protocol.test.ts` | Updated §20.3/§20.4 type lists and counts (15 each) |
| `apps/controller/src/storage/migrations.ts` | Appended migration v3 `phase6-attempt-recovery` |
| `apps/controller/src/jobs/lifecycle.ts` | Extended `AttemptRow`, `updateAttempt()`, `ATTEMPT_STATE_ORPHANED` / `ATTEMPT_OUTCOME_LOST` |
| `apps/controller/test/migration-v3.test.ts` | **Created** — PRAGMA column assertions for v3 |

## Deliverables Checklist

- [x] `log_spool_limit` in `ErrorCategorySchema`
- [x] `LogAckPayloadSchema`, `RecoveryReportPayloadSchema`, `ReconcileDecisionPayloadSchema` + inferred types
- [x] Agent `recovery_report`; Controller `log_ack`, `reconcile_decision`
- [x] All three marked job-scoped in `JOB_SCOPED_MESSAGE_TYPES`
- [x] Migration v3: `log_acked_sequence`, `orphaned_at`, `process_identity`, `last_reconcile_at`
- [x] `updateAttempt()` for new columns; `orphaned` / `lost` documented via constants
- [x] No Task 2+ behavior

## Self-Review

1. **Wire contract** — Schemas match the plan exactly; envelope `superRefine` enforces lease fields for new job-scoped types.
2. **Migration** — Append-only v3; `down` is no-op (SQLite column drop limitation), consistent with brief. Existing `storage.test.ts` downgrade/re-upgrade still passes.
3. **Lifecycle** — `AttemptRow` and SELECT queries include new columns with default `0` for `log_acked_sequence` on insert. `updateAttempt` is generic partial-update helper for Phase 6+ callers.
4. **Scope** — No spool, WS handlers, or recovery coordinator code added.
5. **Collateral** — `protocol.test.ts` counts updated to avoid regressions in full suite.

## Concerns

None blocking. First `pnpm verify` run hit flaky `job-execution.test.ts` timeouts in parallel worktree copies; second run passed cleanly.

## Test Commands

```bash
pnpm exec vitest run packages/protocol/test/protocol-phase6.test.ts apps/controller/test/migration-v3.test.ts
pnpm verify
```
