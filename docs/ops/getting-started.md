# Getting started with RBO

Audience: an operator setting up RBO for the first time — a Controller, one or more Agents, and
one or more AI coding clients (Codex, Claude, Cursor, Antigravity) talking to it over MCP.
For building RBO itself from source, see [`docs/dev/release-builds.md`](../dev/release-builds.md).
For day-2 operations (drain/revoke/repair/update/backup), see [`runbook.md`](./runbook.md).

## 1. What you're setting up

- **Controller** — one process, one machine. Owns the SQLite database, the MCP endpoint your AI
  client talks to, and the TLS endpoint Agents connect to.
- **Agent(s)** — a worker process on each machine that should actually run builds/tests/QEMU/Docker
  jobs. Can run on the same machine as the Controller, or on remote machines.
- **`rbo-mcp-stdio`** — a separate binary (`bin/rbo-mcp-stdio.js`, not a subcommand of the `rbo`
  CLI) that your AI client launches directly; it's a small stdio↔HTTP proxy so clients that only
  speak stdio MCP can still reach the Controller's loopback HTTP endpoint.

Nothing here executes a job until you finish pairing at least one Agent (or explicitly allow local
fallback — see step 4).

## 2. Prerequisites

- Node.js ≥ 22.14 on every machine (Controller and every Agent)
- Git on `PATH` on every machine that will run a job (snapshot capture shells out to `git`)
- Windows Agents: nothing extra — the Job Object helper (`rbo-windows-executor.exe`) ships prebuilt
  in the Windows package
- macOS/Linux Agents: scripts run without the equivalent process-tree containment layer today (see
  Known limitations in the release guide) — fine for trusted local dev use, be aware for anything
  more adversarial

## 3. Install the package

Extract the archive for your OS (built per [`docs/dev/release-builds.md`](../dev/release-builds.md)
or provided by whoever built your release). Layout:

```text
bin/rbo-controller.js
bin/rbo-agent.js
bin/rbo.js                    ← the `rbo` CLI
bin/rbo-mcp-stdio.js
bin/rbo-windows-executor.exe  ← Windows only
config/controller.example.json ← reference only, see step 4
```

## 4. Set up the Controller

The Controller reads **all** configuration from environment variables — `config/
controller.example.json` is a documentation reference, not a file it loads. Set at least:

```bash
export RBO_DATA_DIR="$HOME/.rbo"                         # default: ~/.rbo (Windows: %LOCALAPPDATA%/RBO)
export RBO_ALLOWED_PROJECT_ROOTS="/home/you/projects/app-a,/home/you/projects/app-b"
export RBO_ALLOWED_ARTIFACT_DESTINATIONS="/home/you/build-out"
```

`RBO_ALLOWED_PROJECT_ROOTS` is not optional in practice: it defaults to empty, and `job_submit`
rejects every job whose `source.project_root` isn't inside one of these roots. List every
repository you intend to build through RBO.

Then, once per machine (the CLI reads `$RBO_DATA_DIR` from the environment set above — there is no
`--data-dir` flag, so make sure it's exported in the same shell):

```bash
node bin/rbo.js controller init         # generates the pinned TLS cert + signing keys under $RBO_DATA_DIR
node bin/rbo.js controller fingerprint  # print it — you'll need this on every Agent
node bin/rbo-controller.js   # foreground; Ctrl-C to stop. See runbook.md for a real service install.
```

Confirm it's up: `node bin/rbo.js doctor` (checks git, data dir permissions, shell availability,
and Controller reachability at `http://127.0.0.1:7410`).

Other env vars you may want (all optional, sane defaults shown):

| Env var | Default | Purpose |
|---|---|---|
| `RBO_MCP_HOST` / `RBO_MCP_PORT` | `127.0.0.1` / `7410` | MCP endpoint your AI client/`rbo-mcp-stdio` connects to |
| `RBO_AGENT_PORT` | `7411` | TLS port Agents connect to |
| `RBO_ALLOW_LOCAL_FALLBACK` | `true` | Allow the Controller itself to run a job locally when no eligible Agent is available and the job's `queue_policy`/`preferences.allow_local_fallback` permit it |
| `RBO_LOCAL_MAX_CONCURRENT_JOBS` | `1` | Cap on concurrent locally-executed jobs |
| `RBO_ALLOWED_ARTIFACT_DESTINATIONS` | (empty) | Comma-separated absolute paths `artifact_materialize` is allowed to write to — same shape as `RBO_ALLOWED_PROJECT_ROOTS`, checked independently |

> **Naming trap**: the `rbo` CLI (`agents`/`agent`/`submit`/`logs`/`cancel`/`doctor` — anything
> talking to the Controller's HTTP admin/tool API) reads **`RBO_CONTROLLER_URL_HTTP`** (default
> `http://127.0.0.1:7410`) for that endpoint. This is a *different* variable from the Agent's
> `RBO_CONTROLLER_URL` (a `wss://...:7411/agent` WebSocket URL, step 5) — don't set one expecting
> it to satisfy the other. If you're running `rbo` from a machine other than the Controller itself,
> export `RBO_CONTROLLER_URL_HTTP=http://<controller-host>:7410` first.

## 5. Set up an Agent and pair it

On the Agent machine (same or different from the Controller):

```bash
export RBO_CONTROLLER_URL="wss://<controller-host>:7411/agent"
export RBO_CONTROLLER_FINGERPRINT="<value printed by 'controller fingerprint' above>"
export RBO_AGENT_NAME="my-laptop"          # default: rbo-agent
export RBO_MAX_JOBS=1                       # Phase 4: effective capacity is min(this, 1) anyway

node bin/rbo-agent.js
```

The Agent connects, presents its device identity, and sits in `pairing_pending` until an operator
approves it. Back on the Controller machine (or any other machine with `rbo` and network access to
it — remember to `export RBO_CONTROLLER_URL_HTTP=http://<controller-host>:7410` there first):

```bash
node bin/rbo.js agents                      # list agents — the new one shows as unpaired/pending
# find its pairing_request_id via the admin API, then:
node bin/rbo.js agent approve <pairing_request_id>
node bin/rbo.js agents                      # confirm it now appears with reported capabilities
```

Verify the wrong-fingerprint case is actually rejected once, on purpose, before trusting the setup:
start an Agent with a deliberately wrong `RBO_CONTROLLER_FINGERPRINT` and confirm it never
authenticates — this is the whole point of pinning it out-of-band instead of trusting DNS/TLS CA.

To revoke later: `node bin/rbo.js agent revoke <agent_id>` (see [`runbook.md`](./runbook.md) for
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

Every snippet uses `${RBO_ROOT}` as a placeholder for wherever you extracted the package — replace
it with your real path before pasting it into the client's MCP config. None of these have been
smoke-tested against the real product client yet (see
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
node bin/rbo.js submit job.json          # → { "job_id": "job_..." }
node bin/rbo.js logs <job_id>
node bin/rbo.js cancel <job_id> "changed my mind"   # only if it's still running
```

Via an AI client, the same workflow is the `job_submit` → `job_wait` → `job_logs` →
`job_artifacts` → `artifact_materialize` tool calls — the AI client drives this, you don't type it
yourself. `risk_level: "destructive"` or `"hardware"` jobs come back `awaiting_confirmation` with a
short-lived `confirmation_token`; the client must call `job_confirm` with that exact token before
the job actually queues (this is a deliberate, non-bypassable safety gate — see
`remote-build-orchestrator-design.md` §23.2.1).

## 8. Tell your AI coding assistant to actually use RBO

RBO only routes jobs your AI client explicitly submits through it. If you want Codex/Claude
Code/Cursor to *default* to using RBO for builds/tests instead of running them inline in your
project's own working tree, add something like this to that project's own `AGENTS.md` /
`CLAUDE.md` (not this repo's — the project you're building with RBO's help):

```markdown
## Remote builds via RBO

This project has an RBO Controller + Agent available (see `<path-to-your-notes>` for the
Controller URL and allowed project roots). For any build, test, or long-running/destructive
command:

- Prefer the `job_submit` MCP tool (server name `rbo`) over running the command directly, so it
  runs against an isolated snapshot instead of your live working tree.
- Use `job_wait` / `job_logs` to follow progress; don't poll faster than a few seconds.
- Materialize needed outputs with `artifact_materialize` rather than assuming the job ran in-place
  — it didn't, by design (§0.2: the job's snapshot is isolated from your live tree).
- Destructive or hardware-risk commands come back `awaiting_confirmation`; call `job_confirm` with
  the returned token before assuming the job will run.
- If no RBO Agent is reachable, ask before falling back to running the command locally.
```

Adjust the specifics (server name, which commands should route through RBO) to match your actual
`mcpServers` config name and workflow.

## 9. Troubleshooting

- `node bin/rbo.js doctor` first, always — it checks git, data dir writability, shell
  availability, and Controller reachability in one shot.
- `job_submit` rejects with `"Project root is not under allowed roots: ..."`: add the path to
  `RBO_ALLOWED_PROJECT_ROOTS` on the Controller and restart it.
- Agent stuck at `pairing_pending`: confirm you approved the right `pairing_request_id` (list
  pending requests via the admin API) and that the Agent's `RBO_CONTROLLER_FINGERPRINT` exactly
  matches `controller fingerprint`'s current output.
- Agent connects but never gets work: check `node bin/rbo.js agents` for its reported capacity/
  capabilities, and confirm your job's `requirements` (OS, labels, toolchain) actually match it.
- For anything else, see [`runbook.md`](./runbook.md)'s Repair section.
