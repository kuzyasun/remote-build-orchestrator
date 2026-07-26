# Getting started with RBO

Audience: an operator setting up RBO for the first time — a Controller, one or more Agents, and
one or more AI coding clients (Codex, Claude, Cursor, Antigravity) talking to it over MCP.
For building a release from this monorepo or publishing `@gemslibe/rbo` to npm, see
[`docs/dev/release-builds.md`](../dev/release-builds.md) (maintainer guide). Operators who need
a **local build** (not npm.js) can use [Install from a local build](#install-from-a-local-build)
below.
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
- Windows Agents: nothing extra on **win32-x64** — with `npm install -g @gemslibe/rbo`, the Job
  Object helper arrives via optionalDependency `@gemslibe/rbo-windows-executor-win32-x64`
  (`rbo-windows-executor.exe`). Archives ship the same exe under `bin/`. Other Windows arches /
  OSes run without the helper; `rbo doctor` warns.
- macOS/Linux Agents: scripts run without the equivalent process-tree containment layer today (see
  Known limitations in the release guide) — fine for trusted local dev use, be aware for anything
  more adversarial

### What must be installed on each Agent

The Agent **probes** its own machine on connect and reports what it finds; the Controller then
only schedules a job onto an Agent that satisfies the job's `requirements`. So a missing tool does
not produce a crash — it produces an Agent that never gets picked (see Troubleshooting).

| On the Agent | Needed for | If missing |
|---|---|---|
| **Node.js ≥ 22.14** | the Agent process itself | Agent won't run |
| **`git`** on `PATH` | any git-sourced job; overlay materialization | reported as absent; jobs requiring `git` never match this Agent |
| **`git-lfs`** on `PATH` | repos that use Git LFS — see [Recommended: Git LFS](#recommended-git-lfs-for-large-binary-assets) | LFS repos never match this Agent |
| **the shell your jobs use** | `execution.shell` | a job naming a shell this Agent lacks never matches |
| network/credential access to your git remote | fetching the base commit into `repo_cache_dir` | overlay materialization fails |

Shell detection is best-effort per platform: on Linux/macOS it probes `bash`, `zsh`, `sh`, `pwsh`;
on Windows `powershell`, `cmd`, `pwsh`, `bash`, `sh`, `zsh`. Whatever it finds is what your jobs may
name in `execution.shell`.

Check what an Agent actually reported with `rbo agents` — the `tools` object is the probe result
(e.g. `"tools": { "git": ["2.50.1"], "git-lfs": ["3.5.1"] }`), and `rbo agent probe <agent-id>`
re-runs it on demand.

### On the machine holding the project checkout (the Controller's `source.project_root`)

Capture reads this working tree, so it must be in a state RBO can reason about:

- **Submodules initialized and clean.** If the repo has a `.gitmodules`, capture fails with
  `uninitialized_submodule` or `dirty_submodule`. Run
  `git submodule update --init --recursive` first. A repo with submodules also makes the job
  require `git` on the Agent.
- **LFS content materialized.** If a tracked file is still an LFS *pointer* rather than real
  content, capture fails with `Git LFS content missing for: <paths>`. Run `git lfs pull`.

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

### Install from a local build

Use this when you have the monorepo checkout and want a global `rbo` / `rbo-mcp-stdio` **without**
pulling from the npm registry (dev builds, unpublished fixes, air-gapped pack+copy).

From the **repo root** (Node.js ≥ 22.14, pnpm 10.5.2):

```powershell
pnpm install
pnpm build           # tsc + esbuild → apps/cli/dist (rbo.js, rbo-mcp-stdio.js)
pnpm verify          # optional: lint + unit tests + Rust fmt/test (does not build)
pnpm release:pack    # writes .tgz under apps/cli/ and (on win32-x64) packages/rbo-windows-executor-win32-x64/
```

Then install the packed tarballs globally (replace `0.4.0` with the version in `apps/cli/package.json`):

```powershell
# Windows x64 — install the Job Object helper first, then the main CLI
npm install -g .\packages\rbo-windows-executor-win32-x64\gemslibe-rbo-windows-executor-win32-x64-0.4.0.tgz
npm install -g .\apps\cli\gemslibe-rbo-0.4.0.tgz

rbo --help
rbo doctor
```

On macOS/Linux (no Windows executor tarball):

```bash
npm install -g ./apps/cli/gemslibe-rbo-0.4.0.tgz
```

> Global install from a `.tgz` still runs the same `preinstall` / `preuninstall` stop hook as a
> registry install. Stop any live Controller/Agent first, or let the hook do it.

**Without packing** (monorepo-only smoke; `rbo` is not on `PATH`):

```powershell
pnpm install
pnpm --filter @gemslibe/rbo build
node .\apps\cli\dist\rbo.js --help
node .\apps\cli\dist\rbo.js controller start
node .\apps\cli\dist\rbo-mcp-stdio.js   # MCP stdio proxy from the same build
```

Full pack/publish detail (bump, checksums, archives) stays in
[`docs/dev/release-builds.md`](../dev/release-builds.md).

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
| `git_allowlist` | `{schemes:[https,ssh], hosts:[github.com]}` | Remotes eligible for **git-overlay capture** — see [Overlay vs full snapshot](#overlay-vs-full-snapshot-and-why-a-job-may-refuse-to-start) |
| `allow_local_fallback` | `true` | Allow the Controller to run a job locally when no eligible Agent matches |
| `allow_full_snapshot_fallback` | `false` | Allow uploading the **entire working tree** when git-overlay capture is impossible. Off by default — see below |
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

### Overlay vs full snapshot, and why a job may refuse to start

RBO has two ways to get your source onto an Agent, and the difference is large:

- **git overlay** (preferred) — the Controller ships only your **dirty diff**; the Agent
  materializes the rest by fetching the base commit from the remote into its
  `repo_cache_dir`. On a clean working tree the payload is a few **bytes**.
- **full snapshot** (fallback) — the Controller packs the **entire working tree**. On a repo with
  large tracked binaries (CAD, PCB, media, vendored blobs) that is hundreds of **MB** per submit,
  and capture is CPU-bound, so it can look like the Controller has hung.

Overlay requires all of:

1. at least one Agent connected (otherwise there is nothing to fetch remotely);
2. a `git_allowlist` on the Controller;
3. the project inside a git repo with a HEAD commit;
4. **a fetch remote whose host is in `git_allowlist.hosts`.**

> **The trap — SSH host aliases.** If you use a `~/.ssh/config` alias for multiple accounts,
> your remote is `git@github-myorg:org/repo.git`, and its host is **`github-myorg`**, *not*
> `github.com`. The default allowlist only contains `github.com`, so such a repo is **not**
> overlay-eligible and every job would otherwise fall back to a full snapshot. Either list the
> alias explicitly:
>
> ```json
> { "git_allowlist": { "schemes": ["https", "ssh"], "hosts": ["github.com", "github-myorg"] } }
> ```
>
> …or normalize the remote to `github.com` (e.g. `git config remote.origin.url
> git@github.com:org/repo.git` plus a `Host github.com` entry with the right `IdentityFile`, or
> `url.insteadOf`). Normalizing is usually better: the repo's canonical id — and therefore the
> Agent's `repo_cache_dir` entry — is derived from the host, so `github-myorg/...` and
> `github.com/...` are cached as two different repositories.

Because a silent downgrade to full snapshot is expensive and easy to miss,
**`allow_full_snapshot_fallback` defaults to `false`**: when overlay is impossible, `job_submit`
fails with the specific reason instead. Fix the reason, or opt in explicitly:

```json
{ "allow_full_snapshot_fallback": true }
```

(or `RBO_ALLOW_FULL_SNAPSHOT_FALLBACK=true`). With the opt-in enabled the fallback still logs a
`git overlay capture unavailable; falling back to full snapshot` warning naming the cause, so it
is never silent. You need the opt-in for repos with **no** allowlisted remote at all — local-only
repos, or a Controller running with no Agent connected.

Also set `repo_cache_dir` in `agent.json` (step 5) so Agents reuse one clone per repo instead of
re-fetching per job.

### Recommended: Git LFS for large binary assets

If your repo tracks large binaries directly in git — CAD/PCB exports, media, vendored archives,
firmware blobs — move them to [Git LFS](https://git-lfs.com/). This is a recommendation, not a
requirement, and it pays off in two places:

- **Clone size.** Every Agent's `repo_cache_dir` clone carries the full history of those blobs.
  With LFS the Agent fetches only the versions it actually checks out.
- **Full-snapshot cost.** If a repo ever *does* take the full-snapshot path, capture packs the whole
  working tree. Hundreds of MB of tracked binaries make that slow and CPU-bound.

Once a repo uses LFS, RBO detects it automatically (`git lfs ls-files`, or `filter=lfs` in
`.gitattributes`) and **adds `git-lfs` to the job's requirements**, so:

1. **Install `git-lfs` on every Agent** that should be eligible for that repo. Without it the
   Agent is simply never selected; if it is selected anyway the run fails with
   `git-lfs is required but not available on this Agent`.
2. **Give each Agent credentials/network access to the LFS store.** The Agent materializes content
   itself with `git lfs install --local` + `git lfs pull` — LFS objects are **not** shipped inside
   the job payload.
3. **Push your LFS objects.** Objects that exist only on your machine cannot be fetched by the
   Agent (see Limitations).
4. On the checkout host, keep content materialized (`git lfs pull`) — capture refuses to package
   pointer files with `Git LFS content missing for: <paths>`.

Then start (defaults already use `~/.rbo`; override with `RBO_DATA_DIR` or `--data-dir <dir>` on
**every** `rbo controller` subcommand — init, fingerprint, start, restore — so init and start
always target the same tree):

```bash
rbo controller fingerprint  # print it — you'll need this on every Agent
rbo controller start        # foreground; Ctrl-C to stop. Pass --daemon for detached PID+log.
                            # If already running: TTY prompts to restart; or pass --replace.
rbo controller stop         # stop a live Controller (pid file + process scan)
# Archive alternative: node bin/rbo.js controller start
```

Confirm it's up: `rbo doctor` (checks git, data dir permissions, shell availability,
and Controller reachability at `http://127.0.0.1:7410`).

Optional env overrides (same names as before; they win over the file when set):
`RBO_MCP_HOST`, `RBO_MCP_PORT`, `RBO_AGENT_PORT`, `RBO_ALLOWED_PROJECT_ROOTS` (comma-separated),
`RBO_ALLOWED_ARTIFACT_DESTINATIONS`, `RBO_ALLOW_LOCAL_FALLBACK`,
`RBO_ALLOW_FULL_SNAPSHOT_FALLBACK`, `RBO_LOCAL_MAX_CONCURRENT_JOBS`,
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
#   repo_cache_dir         → recommended: one reusable clone per repo instead of
#                            re-fetching every job (default null = no cache)
#   git_allowlist          → the Agent enforces this too, on the remote it fetches
#                            AND on every submodule URL. Keep it in sync with the
#                            Controller's, including any SSH host aliases.

rbo agent start          # foreground; pass --daemon for detached PID+log
                         # If already running: TTY prompts to restart; or pass --replace.
rbo agent stop-process   # stop a live Agent process (OS service plans stay on `rbo agent stop`)
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
| From-source monorepo (`pnpm install` + `pnpm build`) | `node <REPO>/apps/cli/dist/rbo-mcp-stdio.js` |
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

**Monorepo packages:** `project_root` may point at a subdirectory (e.g. `…/radar-a121/radev` or
`…/DTrack/flutter`). Snapshot still captures the git repository (ignored paths like `node_modules`
stay out). When `cwd` is left as `"."`, the Controller derives the package-relative cwd
(`radev`, `flutter`, …) so the job script runs in that package — install deps on the Agent
(`pnpm install` / `flutter pub get`), do not expect ignored build trees to be shipped in the
snapshot. An explicit non-default `cwd` is left unchanged.

Via an AI client, prefer **`job_run`** (one call: submit + wait + summary). Keep `job_submit` /
`job_wait` / `job_logs` for CI or advanced workflows. `risk_level: "destructive"` or `"hardware"`
jobs come back `awaiting_confirmation` with a short-lived `confirmation_token`; the client must
call `job_confirm` before the job queues (see `remote-build-orchestrator-design.md` §23.2.1).

## 8. Tell your AI coding assistant to actually use RBO

MCP (§6) only exposes the tools. Without project guidance, the assistant still runs builds/tests in
the live tree. Paste this into that project's `AGENTS.md` / `CLAUDE.md` (not this repo's):

```markdown
## Remote builds via RBO

Prefer RBO MCP over a local shell for build/test/long commands when an agent is reachable.
Server name: `rbo` / `user-rbo`.

### Shell vs agent OS

- Before submit: `agents_list` once — pick a live agent that can run this build.
- Match shell/command to **target agent OS**, not Cursor host:
  - Windows → `powershell` (+ Windows-native cmds when that toolchain applies)
  - macOS/Linux → `bash`/`zsh` (unix cmds; no PowerShell / Windows-only tools unless the agent has them)
- `job_run` picks shell from **Controller** OS (no `shell` arg). Wrong OS/shell live? Tell the user
  and ask to start the right agent — do **not** hope `local_fallback` will fix a PowerShell job on a
  Mac-only fleet.
- Explicit shell: `job_submit` → `execution.shell` = target agent (`powershell` | `bash`/`zsh`).

Primary tool: `job_run` with:
- `project_root`: this repo (absolute path)
- `command`: the shell command to run
- optional `artifacts`: only when you need outputs back — choose globs for *this* task.
  Skip when `outcome` / `exit_code` / `log_tail` suffice.

Use `outcome` / `exit_code` / `log_tail` / `artifacts`. If `resume: true`, call `job_run` again
with the same `job_id` until finished. Do not assume the job wrote into the live tree — use
`artifact_materialize` when you need a file locally.

Destructive/hardware jobs return `awaiting_confirmation`; call `job_confirm`, then `job_wait` /
`job_get` (or resume `job_run`).

`job_logs` is pull-based (cursor). There is no MCP subscribe/streaming. Live follow is CLI-only:
`rbo logs <job_id> --follow` (human; outside model context).

If `job_run` fails or no agent is reachable, tell the user why and ask before running locally.
```

If your `mcpServers` entry is not named `rbo` / `user-rbo`, change the server name in the first line.

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
- `job_submit` fails with `Cannot capture this job with git overlay: ...`: that is the
  default-off full-snapshot fallback refusing to upload your whole working tree. The message names
  the cause — most often a fetch remote whose host is not in `git_allowlist.hosts` (watch for SSH
  host aliases like `github-myorg`, which are a different host than `github.com`). See
  [Overlay vs full snapshot](#overlay-vs-full-snapshot-and-why-a-job-may-refuse-to-start).
  Set `allow_full_snapshot_fallback: true` only if you really do want the full-tree upload.
- `job_submit` takes minutes and pegs a CPU: you are on the full-snapshot path with a large
  tracked tree. Confirm with the Controller log — a
  `git overlay capture unavailable; falling back to full snapshot` warning names the cause. Making
  the repo overlay-eligible turns that capture into a few bytes.
- For anything else, see [`runbook.md`](./runbook.md)'s Repair section.

## 10. Limitations to plan around

Current behavior worth knowing before you wire RBO into a real workflow. Release-level caveats live
in [`docs/dev/release-builds.md`](../dev/release-builds.md); this list is about day-to-day operation.

**Source materialization**

- **LFS objects are never transferred in the payload.** The Agent fetches them with `git lfs pull`,
  so objects that exist only on your machine are unreachable — push them first. (Tracked as a
  §11.15 follow-up in `git-source-policy.ts`.)
- **Submodule URLs must also pass `git_allowlist`** — not just the top-level remote. A submodule
  pointing at an SSH host alias, or a host you did not list, fails with
  `Submodule URL rejected (unknown_host)`.
- **Submodules are cloned shallow** (`--depth 1`). Job scripts that need submodule history have to
  deepen it themselves.
- **Submodules must be initialized and clean on the checkout host** before submit; capture will not
  do it for you.
- **Base commits that are not pushed** are shipped as a git bundle, capped by
  `max_git_bundle_bytes` (default 512 MiB). Above that the job fails rather than falling back.
- **Full-snapshot capture is CPU-bound and runs on the Controller's event loop.** On a repo with a
  large tracked tree a single submit can occupy a core for minutes and make the Controller
  unresponsive meanwhile. Prefer overlay; this is the main reason
  `allow_full_snapshot_fallback` is off by default.

**Process containment**

- **macOS/Linux Agents have no process-tree containment layer** equivalent to the Windows Job
  Object helper. Job scripts get their own process group and cancellation walks the descendant
  tree, but a determined process can still escape; fine for trusted local use, weaker for
  adversarial workloads.

**Operational**

- **`--replace` is not scoped to a state directory.** `rbo agent start --replace` /
  `rbo controller start --replace` stop *every* matching agent/controller process on the machine,
  including instances running under a different `--state-dir` / `--data-dir`. Running a test rig
  next to a real paired Agent will take the real one down — stop and restart it deliberately
  instead of relying on `--replace`.
- **A stale pid file can report a process that is gone** ("Agent already running (pid N)" for a dead
  pid). `rbo agent stop-process` clears it; then start normally.
- **Global npm installs may skip the stop hook.** With npm's `allowScripts` policy the
  `preinstall` hook that stops running daemons does not run, so a live Controller/Agent keeps
  serving the *old* bundle after an upgrade. Restart both after installing.
