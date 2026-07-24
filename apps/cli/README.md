# @gemslibe/rbo

Remote Build Orchestrator (RBO) — global CLI, Controller, Agent, and MCP stdio adapter in one package.

## Install

```bash
npm install -g @gemslibe/rbo
```

Requires Node.js ≥ 22.14. See the monorepo [`docs/ops/getting-started.md`](../../docs/ops/getting-started.md) for Controller/Agent setup and MCP client wiring.

Global reinstall/uninstall runs `scripts/stop-running-rbo.mjs` (`preinstall` /
`preuninstall`) to stop live Controller/Agent processes so native deps can be replaced on
Windows. Only global installs trigger the stop (`npm_config_global=true`). Set
`RBO_SKIP_INSTALL_STOP=1` to disable.

`rbo controller init` / `rbo agent init` write live operator configs
(`~/.rbo/controller.json` and `~/.rbo/agent/agent.json`). Daemons load those files on start;
environment variables override the file when set. The package also ships matching templates at
`config/controller.json` and `config/agent.json`. Use `--force` on init to rewrite a config back
to defaults.

`rbo controller start` / `rbo agent start` detect an already-running same-role process (pid file +
`rbo.js … start` scan). In a TTY they prompt to restart; pass `--replace` to skip the prompt
(required in non-TTY). Stop explicitly with `rbo controller stop` or `rbo agent stop-process`
(`rbo agent stop` remains the OS-service plan).

## Binaries

| Command | Purpose |
|---|---|
| `rbo` | CLI — controller/agent lifecycle, job submit/logs/cancel, doctor |
| `rbo-mcp-stdio` | MCP stdio proxy to the Controller's loopback HTTP endpoint |

## Windows Job Object helper

On Windows x64, `@gemslibe/rbo` pulls in `@gemslibe/rbo-windows-executor-win32-x64` as an
optional dependency (the `rbo-windows-executor.exe` helper). Other platforms skip it; `rbo doctor`
prints a WARN when the helper is unavailable.

## License

**Default terms: [AGPL-3.0-only](LICENSE).**

- Using RBO locally as a tool on your own machines is permitted under the AGPL.
- Offering RBO (or a modified or embedded form) **as a network service**, or **embedding it into a proprietary product** without complying with the AGPL, requires a **separate commercial license** from the copyright holder.

To request a commercial license, contact the copyright holder (gemslibe).
