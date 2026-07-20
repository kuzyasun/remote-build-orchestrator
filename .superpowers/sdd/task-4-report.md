# Task 4 Report — Lease self-term, artifact resume, disk-pressure (Phase 6)

**Status:** DONE (recovered after host reboot; implementation was on disk, report was missing)  
**Date:** 2026-07-21  
**Commits:** none

## Summary

Agent self-terminates destructive/hardware jobs at local lease deadline without Controller contact; on adopt after `completed_awaiting_upload`, resumes artifact upload from persisted staging (hash-verified, no workspace re-collect); disk-pressure admission refuses new leases then cleans expired artifacts → old terminal workspaces → old terminal spools → inactive repo caches, never touching active attempts. Capabilities publish `disk_free_*` and `accepting_jobs`.

## Deliverables

| Item | Location |
|------|----------|
| Lease deadline timer + destructive/hardware self-term | `apps/agent/src/executor/index.ts` (`isDestructiveOrHardwareRisk`, `leaseDeadlineMs`, kill + `job_exit`/`lease_expired`) |
| Artifact resume from staging | `resumeArtifactUpload()`; wired from `apps/agent/src/recovery/coordinator.ts` on adopt |
| Disk-pressure cleanup order | `apps/agent/src/recovery/disk-pressure.ts` |
| Config `RBO_DISK_MIN_FREE_BYTES` | `apps/agent/src/config.ts` (`diskMinFreeBytes`) |
| Capabilities disk fields + `accepting_jobs` | `apps/agent/src/capabilities/probe.ts`, heartbeat in `connection/client.ts` |

## Tests (post-reboot verification)

```bash
pnpm exec vitest run apps/controller/test/disk-pressure.test.ts apps/agent/test/lease-self-term.test.ts apps/agent/test/artifact-resume.test.ts
```

**Result:** 3 files, **6 passed** (exit 0).

| File | Coverage |
|------|----------|
| `apps/agent/test/lease-self-term.test.ts` | Hardware kills at deadline; safe does not |
| `apps/agent/test/artifact-resume.test.ts` | Adopt re-sends manifest from staging; no re-collect |
| `apps/controller/test/disk-pressure.test.ts` | Cleanup order; never active; artifact grant only missing objects |

## Recovery note

Host reboot interrupted the SDD session while Task 4 was marked `in progress`. Code + tests were already present; `.superpowers/sdd/task-4-report.md` still held the Phase 5 git_overlay report and was replaced by this Phase 6 report.

## Fix pass (post-reboot review)

Critical: `applyDiskPressureCleanup` was unit-tested but never called at runtime; `spoolPressure` was hardcoded false.

Fixes:
- Heartbeat path in `apps/agent/src/connection/client.ts` invokes `applyDiskPressureCleanup` when disk or spool pressure is detected
- `getSpoolPressure` wired from `SpoolSender.isUnderPressure()` via `AgentJobExecutor.isUnderSpoolPressure()`
- `DiskPressureCleanupOptions.spoolPressure` honored; heartbeat publishes `spool_pressure`

Re-verify: disk-pressure + lease-self-term + artifact-resume → **7 passed**

