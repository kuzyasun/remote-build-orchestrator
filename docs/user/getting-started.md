# Getting started with RBO

This guide takes you from installation to a first remote job. You will set up:

- one **Controller**, which receives jobs from AI clients and schedules them;
- one or more **Agents**, which run those jobs;
- an **MCP connection** from your AI client to the Controller.

The Controller and an Agent may run on the same machine, but RBO is most useful when an Agent runs
on another machine.

## 1. Before you begin

Install these on every Controller and Agent machine:

- Node.js 24.0 or newer;
- Git;
- the shells and build tools that jobs on that machine need.

If a project uses Git LFS, install `git-lfs` on every Agent that should build it. Remote Agents
also need network access and credentials for the project's Git remote.

The default ports are:

| Port | Used by | Typical access |
| --- | --- | --- |
| `7410` | AI clients and the `rbo` CLI | Controller machine only |
| `7411` | Agent connections | reachable from Agent machines |

Keep port `7410` on loopback unless you deliberately secure and expose it. Allow Agents to reach
port `7411` through the host firewall.

## 2. Install RBO

Install the package on the Controller and every Agent:

```bash
npm install -g @gemslibe/rbo
```

This installs two commands:

- `rbo` — Controller, Agent, operations, and manual job commands;
- `rbo-mcp-stdio` — the MCP proxy used by most AI clients.

Confirm the installation:

```bash
rbo --help
rbo doctor
```

### Install from this repository

Use a local package when developing RBO or testing an unpublished version:

```bash
pnpm install
pnpm build
pnpm release:pack
```

Install the generated archive from `apps/cli/`:

```bash
npm install -g ./apps/cli/gemslibe-rbo-<version>.tgz
```

On Windows x64, install the matching archive from
`packages/rbo-windows-executor-win32-x64/` first. Both packages must have the same version.

You can also run a built checkout without installing it globally:

```bash
node apps/cli/dist/rbo.js --help
```

Replace `rbo` with `node <repo>/apps/cli/dist/rbo.js` in the commands below when using this mode.

## 3. Set up the Controller

Initialize the Controller:

```bash
rbo controller init
```

This creates `~/.rbo/controller.json` (on Windows,
`%USERPROFILE%\.rbo\controller.json`) and the Controller identity.

Edit `controller.json`. At minimum, add the projects that RBO may capture:

```json
{
  "allowed_project_roots": ["/home/you/projects/my-app"],
  "allowed_artifact_destinations": ["/home/you/rbo-output"]
}
```

Use absolute paths. On Windows, escape backslashes in JSON:

```json
{
  "allowed_project_roots": ["C:\\Users\\you\\projects\\my-app"],
  "allowed_artifact_destinations": ["C:\\Users\\you\\rbo-output"]
}
```

For Agents on other machines, also set `controller_public_host` to a hostname or IP address they
can reach:

```json
{
  "controller_public_host": "build-controller.local"
}
```

Snapshot capture is bounded before compression by conservative Controller defaults: 1 GiB total
source bytes, 100,000 regular files, 256 MiB per file, and a 1.25 GiB temporary tar estimate.
If a known large workspace needs more capacity, raise the corresponding
`max_snapshot_source_bytes`, `max_snapshot_file_count`, `max_snapshot_single_file_bytes`, or
`max_snapshot_temporary_bytes` value in `controller.json` only after confirming available
Controller disk space.

Start the Controller and print the fingerprint you will use when configuring Agents:

```bash
rbo controller start --daemon
rbo controller fingerprint
rbo doctor
```

Use `rbo controller start` without `--daemon` when you want logs in the current terminal.

## 4. Set up and pair an Agent

Run these steps on each worker machine.

Initialize its configuration:

```bash
rbo agent init
```

Edit `~/.rbo/agent/agent.json` (on Windows,
`%USERPROFILE%\.rbo\agent\agent.json`):

```json
{
  "controller_url": "wss://build-controller.local:7411/agent",
  "controller_fingerprint": "<output of rbo controller fingerprint>",
  "display_name": "workstation-1",
  "max_jobs": 1,
  "repo_cache_dir": "/home/you/.rbo/repositories"
}
```

Use the Controller's reachable host in `controller_url`. Keep the generated fingerprint exact:
it protects the Agent from connecting to the wrong Controller. `repo_cache_dir` is optional but
recommended because it avoids cloning the same repository for every job.

Start the Agent:

```bash
rbo agent start --daemon
```

Back on the Controller machine, approve the pending request:

```bash
rbo agents
rbo agent approve <pairing-request-id>
rbo agents
```

The second `rbo agents` should show the worker and its detected OS, shells, tools, and capacity.

## 5. Connect an AI client

Most clients start `rbo-mcp-stdio`, which forwards MCP requests to the Controller at
`http://127.0.0.1:7410`.

Choose the configuration example for your client:

- [Codex](client-integration/codex.md)
- [Claude](client-integration/claude.md)
- [Cursor](client-integration/cursor.md)
- [Antigravity](client-integration/antigravity.md)
- [OpenCode](client-integration/opencode.md)
- [ZCode](client-integration/zcode.md)

Restart the AI client after changing its MCP configuration. If the client cannot find
`rbo-mcp-stdio`, use the absolute `node` command described in
[AI client configuration](client-integration/README.md).

## 6. Run a first job

The simplest test is to ask your AI client to use RBO for a build or test in an allowed project.
RBO's primary MCP tool, `job_run`, submits the command and waits for a useful result.

For a manual CLI test, run one command from the allowed project directory. `rbo run` captures the
current project, submits the same compact request as MCP `job_run`, waits for its terminal result,
and streams logs with `--follow`.

POSIX shell:

```bash
cd /home/you/projects/my-app
rbo run --follow --shell bash --target-os linux --timeout 600 -- 'printf "%s\\n" "RBO is working"'
```

PowerShell:

```powershell
Set-Location C:\projects\my-app
rbo run --follow --shell powershell --target-os windows --timeout 600 -- 'Write-Output "RBO is working"'
```

Windows `cmd.exe`:

```bat
cd /d C:\projects\my-app
rbo run --follow --shell cmd --target-os windows --timeout 600 -- "echo RBO is working"
```

Pass exactly one target-shell command string after `--`. The local shell removes its outer quoting;
RBO sends the remaining text unchanged to the selected target shell. This is shell text, not an
argv-safe direct-execution interface. Use the target's shell syntax and select a compatible
`--shell` and `--target-os`; RBO never translates command syntax between shell families.

`--timeout` is the remote execution timeout. It does not impose an overall CLI wait deadline:
the CLI continues its resume loop while the job is active, although individual Controller requests
and SSE reconnects are bounded. Use `--queue-policy fail_fast` when a missing compatible Agent
should fail immediately, `wait` to queue until one is available, or `local_fallback` only when
Controller-local execution is acceptable.

Use `--json` for scripts. It writes exactly one final JSON object to stdout; CLI diagnostics stay
on stderr. The initial interface rejects `--json --follow` rather than providing a JSONL log stream.

For jobs that require confirmation, RBO writes the snapshot and warnings to stderr and prompts only
when stdin is a TTY. A non-interactive invocation refuses without a bypass, exits 125, and prints
the job ID with instructions to confirm from a TTY-enabled client. Ctrl+C sends one cancellation
request, waits at most 10 seconds for cancellation to be confirmed, then exits 130; if confirmation
does not arrive, stderr identifies the job so it can still be checked.

### Use `rbo submit` for advanced requests

`rbo submit <job-request.json>` remains available for full request JSON that `rbo run` intentionally
does not expose. In particular, use it when an artifact must be required rather than the optional
rules added by repeated `rbo run --artifact <glob>`:

```json
{
  "client_request_id": "first-job-1",
  "name": "first-rbo-job",
  "source": {
    "project_root": "/home/you/projects/my-app",
    "cwd": "."
  },
  "execution": {
    "shell": "bash",
    "script": "pnpm test",
    "timeout_seconds": 600
  },
  "risk_level": "safe",
  "artifacts": [{ "glob": "coverage/**", "required": true }]
}
```

Submit the advanced request with `rbo submit job.json`; use `rbo logs <job-id> --follow` to inspect
an existing job separately.

### Select a remote shell and OS explicitly

`job_run` is the compact MCP path for an AI client. When the chosen Agent differs from the
Controller's OS, the client should name both the shell and target OS. RBO schedules that exact
shell; it never translates command syntax between shell families.

```json
{
  "command": "printf '%s\\n' \"$HOME\"",
  "project_root": "/home/you/projects/my-app",
  "shell": "bash",
  "target_os": ["linux"],
  "queue_policy": "fail_fast"
}
```

`queue_policy` is optional: use `fail_fast` when a missing compatible Agent should return an
immediate answer, `wait` to leave the job queued for one, or `local_fallback` only when local
execution is acceptable. An omitted shell keeps the Controller's same-platform convenience default;
do not rely on it for a cross-platform command. A no-match result includes a compact `no_match`
object with the required shell, target OS, and an actionable hint. It intentionally does not expose
Agent hostnames or complete capabilities.

The AI client can also retrieve declared artifacts. RBO never writes job output into your live
checkout unless the client explicitly materializes an artifact into an allowed destination.

## 7. Make your AI assistant prefer RBO

Connecting MCP exposes the tools, but project guidance tells an assistant when to use them. Add a
short rule like this to the target project's `AGENTS.md` or equivalent:

```markdown
## Remote builds with RBO

Prefer the RBO MCP tools for builds, tests, and long-running commands when a compatible Agent is
available. Use `job_run` with explicit `shell` and `target_os` for cross-platform work; RBO does not
translate command syntax between shell families. Read the returned outcome, exit code, and log tail;
request artifacts only when a file is needed locally. A compact `no_match` result is actionable in
normal cases, so do not call `agents_list` solely to diagnose it. Ask before falling back to the live
local checkout.
```

For destructive or hardware-risk work, the client must present RBO's confirmation request before
the job can run.

## 8. Source transfer in one minute

RBO normally transfers a **Git overlay**: the Agent obtains the base commit from the Git remote,
then RBO sends only your local changes. This keeps repeated jobs fast.

For this to work:

- the project needs a Git commit and a fetchable remote;
- the remote host must appear in `git_allowlist.hosts` on both Controller and Agent;
- the Agent needs access to the remote;
- submodules must be initialized and clean;
- Git LFS objects must be pushed and available to the Agent.

RBO does not silently upload the entire tree when overlay capture fails:
`allow_full_snapshot_fallback` is `false` by default. The error explains what must be fixed. Enable
full snapshots only when you understand the cost, especially for repositories with large files.

## Next steps

- Run [`rbo doctor`](troubleshooting.md) first when something does not work.
- Use the [operator runbook](runbook.md) for updates, recovery, backup, and removal.
- Read [backup and restore](backup-restore.md) before moving Controller state.
- See [current limitations](../../README.md#current-limitations) before running untrusted or
  platform-sensitive workloads.
