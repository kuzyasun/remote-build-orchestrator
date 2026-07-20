### Task 3: Recovery coordinators â€” disconnect grace, orphan, adopt, Controller/Agent restart

**Files:**
- Create: `apps/controller/src/recovery/coordinator.ts`
- Create: `apps/agent/src/recovery/coordinator.ts`
- Create: `apps/agent/src/recovery/attempt-metadata.ts` â€” persist `{attempt_id,job_id,lease_id,lease_epoch,process_identity,status,workspace_path,spool_dir,...}` atomically under `{stateDir}/attempts/<attempt-id>/metadata.json`
- Modify: `apps/controller/src/websocket/server.ts` â€” on close call coordinator (not immediate fail-all); handle `recovery_report`
- Modify: `apps/controller/src/execution/remote-execution.ts` â€” remove/replace immediate `handleAgentDisconnect` terminal failure; add adopt/terminate_stale
- Modify: `apps/agent/src/connection/client.ts` â€” stop `abandonOnDisconnect` kill-for-all; keep process for safe/normal through grace; still persist spool
- Modify: `apps/agent/src/config.ts` / `apps/controller/src/config.ts`:
  - `RBO_DISCONNECT_GRACE_SECONDS` (default `60`)
  - `RBO_ORPHAN_TIMEOUT_SECONDS` (default `300`)
  - `RBO_RECONCILE_DEADLINE_SECONDS` (default `120`) â€” Controller restart wait
- Modify: destructive/hardware detection from job request risk class (existing schema field â€” use it)
- Create: `apps/controller/test/reconnect-reconcile.test.ts`

**Rules (exact):**

1. Controller restart: load non-terminal attempts; keep lease tuples + `log_acked_sequence`; wait for authenticated Agent `recovery_report`; if none by deadline â†’ `outcome=lost`, `state=completed`.
2. Agent restart: scan `{stateDir}/attempts/*/metadata.json` + live processes; emit `recovery_report` per attempt (`running` | `completed_awaiting_upload` | `orphaned`); replay unacked logs only after `reconcile_decision.action=adopt`.
3. Adopt only when Agent id, attempt id, lease_id, lease_epoch, and `process_identity` all match Controller record. Else `terminate_stale` â€” Agent kills process, cleans, rejects further frames.
4. Disconnect: safe/normal continue through grace; after grace â†’ Controller `state=orphaned` (`orphaned_at=now`). Destructive/hardware: self-terminate at lease expiry without needing Controller (Task 4 also covers lease timer).
5. Fence every frame including replay.

- [ ] **Step 1: Failing reconcile tests** covering:
  - disconnect during safe job â†’ grace â†’ reconnect same tuple â†’ adopt â†’ ordered non-duplicated logs via `job_logs`
  - replacement attempt / newer epoch â†’ `terminate_stale`; stale `log_chunk` / artifact rejected
  - disconnect before script start â†’ no duplicate side effects; attempt lost or requeued per design (pre-`job_started`: prefer fail/lost without rerun in Phase 6 â€” document choice matching Â§18.2 "queued" only if scheduler retry exists; Phase 3 forbade auto-retry â†’ mark `lost` or `failed`/`agent_lost`, do **not** spawn new attempt automatically)

- [ ] **Step 2: Implement Controller `RecoveryCoordinator`**
  - `onAgentDisconnect(agentId)`
  - `onGraceElapsed(attemptId)`
  - `onOrphanTimeout(attemptId)` â†’ `lost`
  - `onRecoveryReport(agentId, payload)` â†’ adopt or terminate_stale
  - `onControllerStartup()` â†’ arm reconcile deadlines

- [ ] **Step 3: Implement Agent `RecoveryCoordinator` + metadata persistence**
  - Write metadata on lease accept / job_started (include pid-based `process_identity`)
  - On startup scan + report
  - Handle `reconcile_decision`

- [ ] **Step 4: Wire WS + change disconnect behavior**

- [ ] **Step 5: GREEN tests + report** â†’ `.superpowers/sdd/task-3-report.md`

---
