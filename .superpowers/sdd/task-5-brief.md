### Task 5: Fault-injection integration suite + large-output / memory bound + final verify

**Files:**
- Create: `apps/controller/test/phase6-reliability.test.ts` (integration; pattern from `remote-execution.test.ts` / Phase 4 harness)
- Optionally gate 1 GiB test: `it.skipIf(!process.env.RBO_LARGE_LOG_TEST)` with smaller default streaming test asserting RSS / heap delta bound

**Required scenarios (all must exist):**

1. Disconnect before script start
2. Disconnect during safe job + reconnect replay; stdout/stderr/events ordered, no duplicates through `job_logs`
3. Replacement attempt rejects every stale frame and artifact
4. Real lease expiry â†’ hardware/destructive job terminates without Controller
5. Controller restart mid-execution â†’ cursors restored â†’ adopt or `lost`
6. Agent restart â†’ stale workspaces â†’ idempotent cleanup after grace
7. Two attempts of one job never mix workspace/logs/acks/artifacts/cleanup (extend `packages/testing` harness if helpful â€” same file as Â§0 git fixtures policy)
8. Full spool + slow Controller + repeated reconnects â†’ bounded memory + explicit `log_spool_limit` (not silent loss)
9. Large synthetic output: gated 1 GiB **or** streaming test with explicit byte/memory assertion

- [ ] **Step 1: Write failing integration tests** (scaffold harness, assert behaviors)

- [ ] **Step 2: Fix gaps revealed by integration (only Phase 6 scope)**

- [ ] **Step 3: Final gate**

```bash
pnpm format
pnpm verify
```

Expected: exit code 0.

- [ ] **Step 4: Phase completion report**

Write `.superpowers/sdd/progress.md` Phase 6 section + `.superpowers/sdd/phase-6-report.md` including:
- files changed
- tests added
- `pnpm verify` exit code
- PLATFORM-GAP grep list
- known limitations / borderline decisions
- residual risks

Do **not** start Phase 7.

---
