### Task 4: Lease-expiry self-termination, artifact upload resume, disk-pressure admission

**Files:**
- Modify: `apps/agent/src/executor/index.ts` â€” local lease deadline timer; destructive/hardware kill at expiry even if disconnected
- Modify: artifact upload path on Agent + Controller grant retry â€” resume upload of declared hash-verified files only
- Create: `apps/agent/src/recovery/disk-pressure.ts`
- Modify: heartbeat/capabilities to publish disk/capacity fields (extend existing capabilities JSON; keep backward-compatible additive fields)
- Modify: `apps/agent/src/config.ts` â€” `RBO_DISK_MIN_FREE_BYTES`, reuse repo-cache retention knobs
- Create: `apps/controller/test/disk-pressure.test.ts` (and/or agent unit tests)
- Extend: `apps/controller/test/remote-execution.test.ts` / artifact tests for resume

**Behavior:**

1. Agent tracks `lease_deadline` from offer/renewals; on expiry for destructive/hardware â†’ kill process tree, write terminal metadata, do not wait for Controller.
2. Artifact resume: if `completed_awaiting_upload`, on adopt re-send `artifact_manifest` / continue PUT only for missing objects; never re-glob workspace.
3. Disk pressure when free disk < threshold OR spool pressure:
   - stop accepting new leases (`lease_reject` / capability `accepting_jobs: false`)
   - delete expired artifacts â†’ old terminal workspaces â†’ old terminal spools â†’ inactive repo caches (order fixed)
   - never touch active attempt spool/workspace/mirror

- [ ] **Step 1: Failing tests** for lease self-term (can fake clock / short TTL), artifact resume, disk-pressure order (temp dirs with markers).

- [ ] **Step 2: Implement** minimal code for each.

- [ ] **Step 3: GREEN + report** â†’ `.superpowers/sdd/task-4-report.md`

---
