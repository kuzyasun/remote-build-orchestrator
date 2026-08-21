# Getting started with RBO

This guide takes you from installation to a first remote job. You will set up:

- one **Controller**, which receives jobs from AI clients and schedules them;
- one or more **Agents**, which run those jobs;
- an **MCP connection** from your AI client to the Controller.

The Controller and an Agent may run on the same machine, but RBO is most useful when an Agent runs
on another machine.

## 1. Before you begin

Install these on every Controller and Agent machine:

- Node.js 22.14 or newer;
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

For a manual CLI test, create `job.json`:

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
    "script": "echo RBO is working",
    "timeout_seconds": 60
  },
  "risk_level": "safe",
  "artifacts": []
}
```

Change `project_root` to an allowed absolute path. On Windows, use an escaped Windows path,
`"shell": "powershell"`, and a PowerShell command.

Submit and inspect the job:

```bash
rbo submit job.json
rbo logs <job-id> --follow
```

The AI client can also retrieve declared artifacts. RBO never writes job output into your live
checkout unless the client explicitly materializes an artifact into an allowed destination.

## 7. Make your AI assistant prefer RBO

Connecting MCP exposes the tools, but project guidance tells an assistant when to use them. Add a
short rule like this to the target project's `AGENTS.md` or equivalent:

```markdown
## Remote builds with RBO

Prefer the RBO MCP tools for builds, tests, and long-running commands when a compatible Agent is
available. Use `agents_list` to check the target OS and tools, then use `job_run`. Match the command
and shell to the Agent OS. Read the returned outcome, exit code, and log tail; request artifacts
only when a file is needed locally. Ask before falling back to the live local checkout.
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
