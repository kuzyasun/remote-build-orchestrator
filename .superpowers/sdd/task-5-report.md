# Task 5 Report — Fault-injection suite + large-output bound + final verify

**Status:** DONE  
**Date:** 2026-07-21  
**Commits:** none (per instructions)

## Summary

Added `apps/controller/test/phase6-reliability.test.ts` covering all nine Phase 6 required fault-injection scenarios (new coverage for cursor restore, stale artifacts, two-attempt ack isolation, spool pressure / `log_spool_limit`, and bounded streaming). Ran `pnpm format` then `pnpm verify` → **exit 0**. Did not start Phase 7.

## Scenario map

| # | Scenario | Where proven |
|---|----------|--------------|
| 1 | Disconnect before script start | `phase6-reliability` + `reconnect-reconcile.test.ts` |
| 2 | Disconnect during safe + reconnect replay, ordered/no dupes | `phase6-reliability` + `reconnect-reconcile` + `log-spool.test.ts` |
| 3 | Replacement rejects stale frames **and** artifacts | `phase6-reliability` (artifacts gap filled); logs also in `reconnect-reconcile` |
| 4 | Real lease expiry → hardware/destructive self-term | `apps/agent/test/lease-self-term.test.ts` (+ hardware grace smoke in `phase6-reliability`) |
| 5 | Controller restart → cursors restored → adopt or `lost` | `phase6-reliability` 5a/5b (+ lost path in `reconnect-reconcile`) |
| 6 | Agent restart → stale workspaces → idempotent cleanup | `phase6-reliability` (+ order details in `disk-pressure.test.ts`) |
| 7 | Two attempts never mix workspace/logs/acks/artifacts | `phase6-reliability` (+ Phase 3 dirs in `job-execution.test.ts`) |
| 8 | Full spool + slow Controller + reconnect → bounded mem + `log_spool_limit` | `phase6-reliability` |
| 9 | Large synthetic output | `phase6-reliability` 9a (8 MiB heap bound); 9b `it.skipIf(!RBO_LARGE_LOG_TEST)` 1 GiB |

## Deliverables

| Item | Location |
|------|----------|
| Fault-injection suite | `apps/controller/test/phase6-reliability.test.ts` |
| Task report | `.superpowers/sdd/task-5-report.md` |
| Phase report | `.superpowers/sdd/phase-6-report.md` |

## Final gate

```bash
pnpm format   # exit 0 (Biome fixed import/format drift)
pnpm verify   # exit 0
```

Vitest (from verify): **50 files, 290 passed | 3 skipped**.  
Rust: `pnpm rust:verify` ok.

## Concerns / limitations

- Scenario 4 full process kill remains in `lease-self-term` (mocked spawn); integration suite asserts Controller does not force-cancel hardware on disconnect.
- Scenario 8 asserts SpoolSender queue bound + disk spool-cap contract string; does not drive full `AgentJobExecutor` spawn for `log_spool_limit` exit (executor wiring already in Task 2).
- 1 GiB test skipped unless `RBO_LARGE_LOG_TEST` is set; default 8 MiB streaming asserts `heapDelta < TARGET_BYTES` and `< 32 MiB`.
- Heap assertion is best-effort without `--expose-gc`; still fails if the spool buffers the full stream in RAM.
