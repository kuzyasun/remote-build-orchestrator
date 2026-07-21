# Evidence: test-mcp-client / stdio

- client: test-mcp-client (Vitest MCP SDK harness)
- transport: stdio
- workflow: submit → wait → logs → artifacts → materialize; cancel
- verified_by: `apps/controller/test/mcp-smoke-workflow.test.ts`
- known limitation: not a Codex/Claude/Cursor/Antigravity UI client

## Notes

Harness compatibility is proven by the automated MCP smoke workflow under
`pnpm verify` / CI. Per-run job IDs, timestamps, and call transcripts are
ephemeral and must not be written into this tracked evidence directory.
