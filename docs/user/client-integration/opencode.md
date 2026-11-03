# OpenCode — MCP configuration

Merge into project `opencode.json` / `opencode.jsonc`, or the global
`~/.config/opencode/opencode.json`.

Stdio (preferred):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "rbo": {
      "type": "local",
      "command": ["rbo-mcp-stdio"],
      "enabled": true,
      "environment": {
        "RBO_CONTROLLER_URL": "http://127.0.0.1:7410"
      }
    }
  }
}
```

Remote HTTP alternative (requires Bearer token from `~/.rbo/security/admin-token` or `<dataDir>/security/admin-token`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "rbo": {
      "type": "remote",
      "url": "http://127.0.0.1:7410/mcp",
      "headers": {
        "Authorization": "Bearer <ADMIN_TOKEN>"
      },
      "enabled": true
    }
  }
}
```
