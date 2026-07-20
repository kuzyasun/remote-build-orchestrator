# Phase 5 Task 4 — git_overlay Integration Report

**Status:** Complete  
**Date:** 2026-07-20  
**Verification:** `pnpm format` + `pnpm verify` green (229 tests)

## Summary

End-to-end `git_overlay` prepare with bundle fallback is wired across Agent and Controller. Full-mode remote execution (Phase 4) remains unchanged and passing.

## Agent

| Area | Change |
|------|--------|
| `apps/agent/src/executor/index.ts` | `RepoMirrorManager` from config; `handlePrepareGitOverlay` (mirror → fetch → `source_need` → bundle wait → worktree → overlay download → `applyGitOverlay` → `source_ready`); `handleBundleDownload`; overlay worktree cleanup on cancel/run completion |
| `apps/agent/src/connection/client.ts` | `bundle_download` WS handler; pass `gitAllowlist` / `repoCache` into executor |
| `apps/agent/src/main.ts` | Pass git config into connection |

### Overlay prepare flow

1. `ensureMirror` + optional `fetchRefs`
2. `hasCommit` — if missing: `source_need` (`base_commit_missing` or `repo_fetch_failed`)
3. On `base_commit_missing`: wait for `bundle_download`, `importBundle`, re-check commit
4. On `repo_fetch_failed`: return and wait for Controller full-mode `prepare_source` fallback
5. `createWorktree` at `workspaces/<attempt>/project`
6. Download overlay archive (size/hash verified)
7. `applyGitOverlay` → `source_ready`

## Controller

| Area | Change |
|------|--------|
| `apps/controller/src/security/data-tokens.ts` | Ops: `overlay_download`, `bundle_download` |
| `apps/controller/src/http/data-plane.ts` | `GET .../overlay`, `GET .../bundle`; snapshot route prefers transfer fallback archive |
| `apps/controller/src/execution/remote-execution.ts` | Mode-aware `sendPrepareSource`; `handleRemoteSourceNeed` (bundle create + full fallback) |
| `apps/controller/src/execution/runner.ts` | `captureGitOverlaySnapshot` when remote-capable + allowlist passes; `attemptTransferDir` |
| `apps/controller/src/config.ts` | `gitAllowlist` env parsing (same pattern as agent) |
| `apps/controller/src/websocket/server.ts` | `source_need` handler |
| `apps/controller/src/mcp/handlers.ts`, `http/server.ts`, `main.ts` | Plumb `gitAllowlist` through submit/dispatch context |

### source_need handling

| Reason | Controller action |
|--------|-------------------|
| `base_present` | No-op (wait for `source_ready`) |
| `base_commit_missing` / `bundle_required` | Create git bundle from local project (`HEAD` when base matches), store under `transfers/<attempt>/`, send `bundle_download` |
| `full_snapshot_required` / `repo_fetch_failed` | Re-send full `prepare_source` if full archive exists; else on-demand `captureFullSnapshot` to transfer dir |

## Tests added

| File | Coverage |
|------|----------|
| `apps/agent/test/prepare-overlay.test.ts` | Mirror seed → worktree → overlay apply; bundle import into empty mirror |
| `apps/controller/test/source-need.test.ts` | `source_need` → `bundle_download`; allowlist rejection falls back to full capture |

## Files touched (primary)

- Agent: `executor/index.ts`, `connection/client.ts`, `main.ts`
- Controller: `remote-execution.ts`, `runner.ts`, `data-plane.ts`, `data-tokens.ts`, `config.ts`, `websocket/server.ts`, `mcp/handlers.ts`, `http/server.ts`, `main.ts`
- Snapshot: `canonical.ts` (TS union narrowing fix for build)
- Tests: `prepare-overlay.test.ts`, `source-need.test.ts`, updates to `remote-execution.test.ts`, `agent-connection.test.ts`, `cancel-signal.test.ts`

## Concerns / follow-ups

1. **Git bundle by SHA on Windows:** `git bundle create <sha>` can fail with "empty bundle"; controller uses `HEAD` when it matches `base_commit`, with `--all` fallback.
2. **repo_fetch_failed path:** Agent does not wait for bundle; relies on Controller sending full `prepare_source`. No automated e2e for this branch yet.
3. **Transfer snapshot SHA header:** Data-plane may serve transfer fallback with DB overlay sha256 in header; agent verifies against `prepare_source` expected values.
4. **Task 5 cache affinity:** Not implemented (out of scope).
5. **No git commit** per instructions.
