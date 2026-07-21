# Fusion — MCP configuration (Streamable HTTP preferred)

Do not embed secrets. Replace placeholders before use.

```json
{
  "mcpServers": {
    "rbo": {
      "url": "http://127.0.0.1:7410/mcp"
    }
  }
}
```

Stdio alternative:

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

Status: not verified on this host until Fusion UI smoke evidence is recorded.
