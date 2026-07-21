# Codex — MCP configuration (stdio preferred)

```json
{
  "mcpServers": {
    "rbo": {
      "command": "rbo-mcp-stdio",
      "env": {
        "RBO_CONTROLLER_URL": "http://127.0.0.1:7410"
      }
    }
  }
}
```

HTTP alternative: `http://127.0.0.1:7410/mcp`.

Status: not verified on this host until Codex smoke evidence is recorded.
