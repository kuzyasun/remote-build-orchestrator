# Getting started with RBO

Audience: an operator setting up RBO for the first time — a Controller, one or more Agents, and
one or more AI coding clients (Codex, Claude, Cursor, Antigravity) talking to it over MCP.
For building a release from this monorepo or publishing `@gemslibe/rbo` to npm, see
[`docs/dev/release-builds.md`](../dev/release-builds.md) (maintainer guide — not required for
operators installing from npm).
For day-2 operations (drain/revoke/repair/update/backup), see [`runbook.md`](./runbook.md).

## 1. What you're setting up

- **Controller** — one process, one machine. Owns the SQLite database, the MCP endpoint your AI
  client talks to, and the TLS endpoint Agents connect to.
- **Agent(s)** — a worker process on each machine that should actually run builds/tests/QEMU/Docker
  jobs. Can run on the same machine as the Controller, or on remote machines.
- **`rbo-mcp-stdio`** — a separate binary (not a subcommand of the `rbo` CLI) that your AI client
  launches directly; it's a small stdio↔HTTP proxy so clients that only speak stdio MCP can still
  reach the Controller's loopback HTTP endpoint. After `npm install -g` it is on `PATH` as
  `rbo-mcp-stdio`; archives ship the same file as `bin/rbo-mcp-stdio.js`.

Nothing here executes a job until you finish pairing at least one Agent (or explicitly allow local
fallback — see step 4).

## 2. Prerequisites

- Node.js ≥ 22.14 on every machine (Controller and every Agent)
- Git on `PATH` on every machine that will run a job (snapshot capture shells out to `git`)
- Windows Agents: nothing extra on **win32-x64** — with `npm install -g @gemslibe/rbo`, the Job
  Object helper arrives via optionalDependency `@gemslibe/rbo-windows-executor-win32-x64`
  (`rbo-windows-executor.exe`). Archives ship the same exe under `bin/`. Other Windows arches /
  OSes run without the helper; `rbo doctor` warns.
- macOS/Linux Agents: scripts run without the equivalent process-tree containment layer today (see
  Known limitations in the release guide) — fine for trusted local dev use, be aware for anything
  more adversarial

## 3. Install the package

**Preferred — global npm install** (ships CLI + Controller + Agent + `rbo-mcp-stdio` in one package):

```bash
npm install -g @gemslibe/rbo
```

Requires Node.js ≥ 22.14. After install, `rbo` and `rbo-mcp-stdio` are on your `PATH`.

> **Reinstall / upgrade:** global `npm install -g` / `npm uninstall -g` run a `preinstall` /
> `preuninstall` hook that stops any running Controller/Agent (`rbo.js … start`, including
> `--daemon` via pid files) so Windows can replace locked `better-sqlite3` natives. The hook
> only runs for **global** installs (not monorepo `pnpm install`). Set
> `RBO_SKIP_INSTALL_STOP=1` to skip. OS services are not stopped.

**Offline / air-gap fallback:** extract an OS archive built per
[`docs/dev/release-builds.md`](../dev/release-builds.md) (same bundled bits at the same semver). Layout:

```text
bin/rbo.js                    ← the `rbo` CLI (bundled Controller + Agent + CLI)
bin/rbo-mcp-stdio.js          ← MCP stdio proxy (bundled)
bin/rbo-windows-executor.exe  ← Windows only
config/controller.json        ← template of the live operator config (init writes ~/.rbo/controller.json)
config/agent.json             ← template of the live agent config (init writes ~/.rbo/agent/agent.json)
```

Archives ship the **same bundled bits** as `npm install -g @gemslibe/rbo` (including the
`config/*.json` templates). Start Controller/Agent with
`node bin/rbo.js controller start` / `node bin/rbo.js agent start` (or `rbo ...` after a global
install). There are no separate thin `rbo-controller` / `rbo-agent` archive entrypoints.

## 4. Set up the Controller

The Controller loads **`~/.rbo/controller.json`** (or `$RBO_DATA_DIR/controller.json`) on start.
`rbo controller init` writes a complete default config there if missing (use `--force` to rewrite).
**Precedence:** built-in defaults → config file → environment variables → programmatic overrides.
Edit the file for day-to-day setup; use env vars only when scripting/CI needs a temporary override.

```bash
rbo controller init         # TLS identity + ~/.rbo/controller.json (defaults)
# Windows: same paths under %USERPROFILE%\.rbo
```

Then edit `~/.rbo/controller.json` (or `%USERPROFILE%\.rbo\controller.json` on Windows). At minimum
fill the allowlists — they default to empty and `job_submit` rejects every project root until you set them:

| Field | Default | Purpose |
|---|---|---|
| `allowed_project_roots` | `[]` | Absolute paths whose trees may be used as `source.project_root` — **you must fill this** |
| `allowed_artifact_destinations` | `[]` | Absolute paths `artifact_materialize` may write into |
| `mcp_host` / `mcp_port` | `127.0.0.1` / `7410` | MCP endpoint your AI client / `rbo-mcp-stdio` connects to |
| `agent_plane_port` | `7411` | TLS port Agents connect to |
| `controller_public_host` | `127.0.0.1` | Host Agents use in data-plane HTTPS URLs (set to a reachable address for remote Agents) |
| `allow_local_fallback` | `true` | Allow the Controller to run a job locally when no eligible Agent matches |
| `local_max_concurrent_jobs` | `1` | Cap on concurrent locally-executed jobs |
| `local_fallback_max_host_cpu_percent` | `80` | Host-aware local fallback CPU busy% threshold |

Example (Linux/macOS paths):

```json
{
  "allowed_project_roots": ["/home/you/projects/app-a", "/home/you/projects/app-b"],
  "allowed_artifact_destinations": ["/home/you/build-out"]
}
```

Windows example:

```json
{
  "allowed_project_roots": ["C:\\Users\\you\\projects\\app-a"],
  "allowed_artifact_destinations": ["C:\\Users\\you\\build-out"]
}
```

Then start (defaults already use `~/.rbo`; override with `RBO_DATA_DIR` or `--data-dir <dir>` on
**every** `rbo controller` subcommand — init, fingerprint, start, restore — so init and start
always target the same tree):

```bash
rbo controller fingerprint  # print it — you'll need this on every Agent
rbo controller start        # foreground; Ctrl-C to stop. Pass --daemon for detached PID+log.
# Archive alternative: node bin/rbo.js controller start
```

Confirm it's up: `rbo doctor` (checks git, data dir permissions, shell availability,
and Controller reachability at `http://127.0.0.1:7410`).

Optional env overrides (same names as before; they win over the file when set):
`RBO_MCP_HOST`, `RBO_MCP_PORT`, `RBO_AGENT_PORT`, `RBO_ALLOWED_PROJECT_ROOTS` (comma-separated),
`RBO_ALLOWED_ARTIFACT_DESTINATIONS`, `RBO_ALLOW_LOCAL_FALLBACK`, `RBO_LOCAL_MAX_CONCURRENT_JOBS`,
`RBO_LOCAL_FALLBACK_MAX_HOST_CPU_PERCENT`, `RBO_CONTROLLER_PUBLIC_HOST`, `RBO_DATA_DIR`.

> **Naming trap**: the `rbo` CLI (`agents`/`agent`/`submit`/`logs`/`cancel`/`doctor` — anything
> talking to the Controller's HTTP admin/tool API) reads **`RBO_CONTROLLER_URL_HTTP`** (default
> `http://127.0.0.1:7410`) for that endpoint. This is a *different* variable from the Agent's
> `controller_url` / `RBO_CONTROLLER_URL` (a `wss://...:7411/agent` WebSocket URL, step 5) — don't
> set one expecting it to satisfy the other. If you're running `rbo` from a machine other than the
> Controller itself, export `RBO_CONTROLLER_URL_HTTP=http://<controller-host>:7410` first.

## 5. Set up an Agent and pair it

On the Agent machine (same or different from the Controller). The Agent loads
`~/.rbo/agent/agent.json` (or `$RBO_AGENT_STATE_DIR/agent.json` /
`$RBO_DATA_DIR/agent/agent.json`). `rbo agent init` writes a complete default config if missing
(`--force` to rewrite). Same precedence as the Controller: **file first for operators, env
overrides the file**.

```bash
rbo agent init
# Edit ~/.rbo/agent/agent.json (Windows: %USERPROFILE%\.rbo\agent\agent.json):
#   controller_url         → wss://<controller-host>:7411/agent
#   controller_fingerprint → value from `rbo controller fingerprint`
#   display_name           → e.g. "my-laptop" (default: rbo-agent)
#   max_jobs               → default 1

rbo agent start          # foreground; pass --daemon for detached PID+log
# Archive alternative: node bin/rbo.js agent start
```

Agent state defaults to `~/.rbo/agent` (or `$RBO_DATA_DIR/agent`). Override with
`RBO_AGENT_STATE_DIR` or `--state-dir <dir>` on `rbo agent init` / `rbo agent start` (same flag
for both). You can also set `RBO_CONTROLLER_URL` / `RBO_CONTROLLER_FINGERPRINT` /
`RBO_AGENT_NAME` / `RBO_MAX_JOBS` to override the file for a single run.

The Agent connects, presents its device identity, and sits in `pairing_pending` until an operator
approves it. Back on the Controller machine (or any other machine with `rbo` and network access to
it — remember to `export RBO_CONTROLLER_URL_HTTP=http://<controller-host>:7410` there first):

```bash
rbo agents                      # { agents, pending_pairings } — pending shows pairing id
rbo agent approve <pairing_request_id>   # id from pending_pairings[].id
rbo agents                      # confirm it moved into agents[] with reported capabilities
```

Verify the wrong-fingerprint case is actually rejected once, on purpose, before trusting the setup:
start an Agent with a deliberately wrong `controller_fingerprint` and confirm it never
authenticates — this is the whole point of pinning it out-of-band instead of trusting DNS/TLS CA.

To revoke later: `rbo agent revoke <agent_id>` (see [`runbook.md`](./runbook.md) for
the full lifecycle — drain/revoke/repair/update/backup/restore).

## 6. Connect an AI coding client over MCP

Every client talks to the same Controller through the same canonical MCP tools
(`job_submit`, `job_confirm`, `job_get`, `job_wait`, `job_logs`, `job_cancel`, `job_artifacts`,
`artifact_materialize`, `agents_list`, `agent_probe`). Two transports are available:

- **stdio** (via the separate `rbo-mcp-stdio` binary, a small proxy to the Controller's loopback
  HTTP endpoint) — what most local-only clients expect.
- **Streamable HTTP** directly at `http://127.0.0.1:7410/mcp` — for clients that support it
  natively (skips the extra proxy process).

Copy/paste starting points per client live in `docs/compatibility/snippets/` — use the real one for
your client rather than retyping it:

| Client | File |
|---|---|
| Codex | [`snippets/codex.md`](../compatibility/snippets/codex.md) (stdio preferred) |
| Claude | [`snippets/claude.md`](../compatibility/snippets/claude.md) |
| Cursor | [`snippets/cursor.md`](../compatibility/snippets/cursor.md) |
| Antigravity | [`snippets/antigravity.md`](../compatibility/snippets/antigravity.md) |

The snippets use `command: "rbo-mcp-stdio"` — that matches a global npm install (`rbo-mcp-stdio` on
`PATH`). Other install modes need a path to the same proxy binary:

| Install | How to launch MCP stdio |
|---|---|
| `npm install -g @gemslibe/rbo` | `rbo-mcp-stdio` on `PATH` (what the snippets use) |
| From-source monorepo (`pnpm install` + build / `pnpm verify`) | `node <REPO>/apps/cli/dist/rbo-mcp-stdio.js` |
| OS archive extract | `node <RBO_ROOT>/bin/rbo-mcp-stdio.js` |

For from-source or archive, replace the snippet's `command` with `node` and put the absolute path
in `args` (keep the same `env`):

```json
{
  "command": "node",
  "args": ["<REPO>/apps/cli/dist/rbo-mcp-stdio.js"],
  "env": {
    "RBO_CONTROLLER_URL": "http://127.0.0.1:7410"
  }
}
```

Use `<RBO_ROOT>/bin/rbo-mcp-stdio.js` instead of the `<REPO>/…` path when running from an OS
archive.

None of the product clients have been smoke-tested against the real product yet (see
[`docs/compatibility/report.md`](../compatibility/report.md) — status `not_verified` is honest, not
a bug); the harness itself (the same `job_submit → job_wait → job_logs → job_artifacts →
artifact_materialize` + cancel workflow, over both transports) is what's actually verified today.

## 7. Submit and watch a job

Via the CLI (useful for a first smoke test, or scripting outside an AI client):

```bash
cat > job.json <<'EOF'
{
  "client_request_id": "first-job-1",
  "name": "hello-world",
  "source": { "project_root": "/home/you/projects/app-a", "cwd": "." },
  "execution": { "shell": "bash", "script": "echo hello && date > out.txt", "timeout_seconds": 60 },
  "risk_level": "safe",
  "artifacts": [{ "glob": "out.txt", "required": true }]
}
EOF
rbo submit job.json          # → { "job_id": "job_..." }  (archive: node bin/rbo.js …)
rbo logs <job_id>
rbo cancel <job_id> "changed my mind"   # only if it's still running
```

Via an AI client, prefer **`job_run`** (one call: submit + wait + summary). Keep `job_submit` /
`job_wait` / `job_logs` for CI or advanced workflows. `risk_level: "destructive"` or `"hardware"`
jobs come back `awaiting_confirmation` with a short-lived `confirmation_token`; the client must
call `job_confirm` before the job queues (see `remote-build-orchestrator-design.md` §23.2.1).

## 8. Tell your AI coding assistant to actually use RBO

MCP (§6) only exposes the tools. Without project guidance, the assistant still runs builds/tests in
the live tree. Paste this into that project's `AGENTS.md` / `CLAUDE.md` (not this repo's):

```markdown
## Remote builds via RBO

For build/test/long commands, call MCP `job_run` (server `rbo`) with:
- `project_root`: this repo (absolute path)
- `command`: the shell command to run

Optional `artifacts`: only when you need outputs back — choose globs for the files that matter
for *this* task (binaries, logs, reports, configs, etc.). Skip artifacts when you only need
`outcome` / `exit_code` / `log_tail`. Avoid scooping an entire huge build tree unless you
really need it.

Use `outcome` / `exit_code` / `log_tail` / `artifacts`. If the response has `resume: true`, call
`job_run` again with the same `job_id` until `resume` is false (keeps each MCP call under ~60s).

Do not run the same command in the live tree unless `job_run` fails and the user approves a local
fallback.

Destructive or hardware-risk jobs return `awaiting_confirmation`; call `job_confirm` with the
token, then `job_wait` / `job_get` as needed.
```

If your `mcpServers` entry is not named `rbo`, change the server name in the first line.

## 9. Troubleshooting

- `rbo doctor` first, always (archive: `node bin/rbo.js doctor`) — it checks git, data dir
  writability, shell availability, and Controller reachability in one shot.
- MCP client can't start `rbo-mcp-stdio` (command not found): GUI apps on Windows often miss the
  shell's npm-global `PATH`. Restart the client after install, confirm the npm global bin dir is on
  the user/system `PATH`, or use the `node` + absolute-path form from §6 instead.
- `job_submit` rejects with `"Project root is not under allowed roots: ..."`: add the path to
  `allowed_project_roots` in `~/.rbo/controller.json` (or set `RBO_ALLOWED_PROJECT_ROOTS`) and
  restart the Controller.
- Agent stuck at `pairing_pending`: run `rbo agents` and approve the id under
  `pending_pairings` (`rbo agent approve <id>`). Confirm the Agent's `controller_fingerprint` in
  `agent.json` (or `RBO_CONTROLLER_FINGERPRINT`) exactly matches `controller fingerprint`'s
  current output.
- Agent connects but never gets work: check `rbo agents` for its reported capacity/capabilities,
  and confirm your job's `requirements` (OS, labels, toolchain) actually match it.
- For anything else, see [`runbook.md`](./runbook.md)'s Repair section.
