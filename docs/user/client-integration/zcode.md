# ZCode — MCP configuration

Paste via **Settings → MCP Servers → New MCP Server → Full configuration**,
or use Form mode: type `stdio`, command `rbo-mcp-stdio`, env
`RBO_CONTROLLER_URL=http://127.0.0.1:7410`.

Stdio (preferred) — ZCode accepts `mcpServers` paste:

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
HTTP alternative:

```json
{
  "mcpServers": {
    "rbo": {
      "type": "http",
      "url": "http://127.0.0.1:7410/mcp"
    }
  }
}
```
