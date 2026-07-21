# RBO client compatibility report (Phase 8)

Policy: **Option A** — a cell is `verified` only with recorded smoke evidence.
Inferred compatibility is not claimed. AI product clients not launched on this
host remain `not_verified`.

## Matrix summary

| Client | Transport | Status | Evidence / limitation |
|---|---|---|---|
| test-mcp-client | stdio | verified | `evidence/test-mcp-client-stdio.md` |
| test-mcp-client | streamable_http | verified | `evidence/test-mcp-client-http.md` |
| Fusion | stdio / streamable_http | not_verified | client_not_launched_on_host |
| Codex | stdio / streamable_http | not_verified | client_not_launched_on_host |
| Claude | stdio / streamable_http | not_verified | client_not_launched_on_host |
| Cursor | stdio / streamable_http | not_verified | client_not_launched_on_host |
| Antigravity | stdio / streamable_http | not_verified | client_not_launched_on_host |

Machine-readable source: [`matrix.json`](./matrix.json).

## Workflow covered by harness

1. Isolated dirty snapshot via `job_submit`
2. `job_wait` until terminal
3. Incremental `job_logs`
4. `job_artifacts` + `artifact_materialize`
5. Separate long-running job → `job_cancel`
6. Malformed input rejected by shared Zod on both transports

## Snippets

See `snippets/` for copy/paste configs. Placeholders only — no credentials,
Controller private keys, or developer absolute paths.
