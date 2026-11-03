# AI client configuration

Choose a copy-paste example:

- [Codex](codex.md)
- [Claude](claude.md)
- [Cursor](cursor.md)
- [Antigravity](antigravity.md)
- [OpenCode](opencode.md)
- [ZCode](zcode.md)

Most examples start the local `rbo-mcp-stdio` proxy and connect it to
`http://127.0.0.1:7410`. Restart the client after changing its configuration.

The examples assume `npm install -g @gemslibe/rbo`, which puts `rbo-mcp-stdio` on `PATH`. If a GUI
client cannot find it, launch the same script through Node:

| Installation | Command | First argument |
| --- | --- | --- |
| Repository build | `node` | `<REPO>/apps/cli/dist/rbo-mcp-stdio.js` |
| Release archive | `node` | `<RBO_ROOT>/bin/rbo-mcp-stdio.js` |

Keep `RBO_CONTROLLER_URL=http://127.0.0.1:7410` in the proxy environment. The `rbo-mcp-stdio` proxy
automatically reads the admin token from `~/.rbo/security/admin-token` (or `<dataDir>/security/admin-token`
if `RBO_DATA_DIR` is overridden, or `RBO_ADMIN_TOKEN`).
Clients that support Streamable HTTP can instead connect directly to `http://127.0.0.1:7410/mcp`,
supplying an `Authorization: Bearer <ADMIN_TOKEN>` header (the token can be read from
`~/.rbo/security/admin-token` on the Controller host).

These are configuration examples, not a guarantee that every client version has been tested. For
the complete Controller and Agent setup, see [Getting started](../getting-started.md).
