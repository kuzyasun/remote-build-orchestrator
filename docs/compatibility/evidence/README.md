# Evidence directory

Committed smoke evidence for the compatibility matrix (`matrix.json`).

- **Product AI-client evidence** (Codex, Claude, Cursor, Antigravity): add a file
  when a real client smoke is run on a host. Record it manually; `pnpm verify`
  must not rewrite these files.
- **Harness evidence** (`test-mcp-client-stdio.md`, `test-mcp-client-http.md`):
  stable pointers to `apps/controller/test/mcp-smoke-workflow.test.ts`. That
  test asserts live redacted transcripts in memory / under `os.tmpdir()` and
  must not mutate this directory.

Never store credentials, tokens, or private keys here.
