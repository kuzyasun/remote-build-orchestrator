# Cursor — MCP configuration

```json
{
  "mcpServers": {
    "rbo": {
      "command": "node",
      "args": ["${RBO_ROOT}/apps/mcp-stdio/dist/main.js"],
      "env": {
        "RBO_CONTROLLER_URL": "http://127.0.0.1:7410"
      }
    }
  }
}
```

HTTP: `http://127.0.0.1:7410/mcp`.

Status: not verified on this host until Cursor smoke evidence is recorded.
