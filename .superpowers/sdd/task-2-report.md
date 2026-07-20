# Phase 5 Task 2 — Agent Repository Mirror Infrastructure

## Status

**DONE**

## Summary

Implemented Agent-side bare repository mirror management with allowlist enforcement, per-`repo_key` fetch/import serialization, detached worktree lifecycle, bundle import under `refs/rbo/bundles/...`, metadata persistence, and LRU eviction with active-worktree protection.

## Files changed

| File | Change |
|------|--------|
| `apps/agent/src/repos/mirror.ts` | **New** — `RepoMirrorManager`, mirror metadata, mutex/fetch.lock, fetch, bundle import, worktree add/remove, eviction |
| `apps/agent/src/config.ts` | Extended `AgentConfig` with `gitAllowlist` + `repoCache` (defaults per §10.10), env parsing, `resolveReposDir()` |
| `apps/agent/test/mirror.test.ts` | **New** — 9 tests covering allowlist, commit detection, worktrees, concurrency, bundle import, eviction |

## Test command and results

```bash
pnpm exec vitest run apps/agent/test/mirror.test.ts
```

```
Test Files  1 passed (1)
     Tests  9 passed (9)
```

Agent package build:

```bash
pnpm --filter @rbo/agent build
```

Succeeds.

## Concerns

1. **Windows git paths** — Git for Windows rejects extended `\\?\` paths; `toGitOsPath()` strips the prefix before passing worktree/bundle paths to git CLI. Production paths under `ProgramData` should be fine; very long temp paths in tests required this workaround.

2. **`onFetchMutexHeld` test hook** — Optional constructor callback used only by tests to assert fetch/import serialization without mocking `execFile` (not spyable in ESM). Production callers must leave it unset.

3. **Monorepo `pnpm verify`** — Fails on pre-existing `@rbo/snapshot` TypeScript errors in `capture.ts` (overlay/source manifest typing from other Phase 5 work). Unrelated to this task; agent mirror tests and `@rbo/agent` build are green.

4. **Initial mirror clone** — Uses `git clone --mirror` with `cwd` set to the repo directory and a relative `mirror.git` target to avoid Windows `--git-dir` extended-path issues.
