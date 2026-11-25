# Claude — MCP configuration

```json
{
  "mcpServers": {
    "rbo": {
      "type": "stdio",
      "command": "rbo-mcp-stdio",
      "env": {
        "RBO_CONTROLLER_URL": "http://127.0.0.1:7410"
      }
    }
  }
}
```

HTTP alternative: `http://127.0.0.1:7410/mcp` (requires `Authorization: Bearer <MCP_TOKEN>` from `~/.rbo/security/mcp-token`, see [overview](README.md)).
