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

Start the Controller:

```bash
rbo controller start --daemon
rbo doctor
```

The Controller starts the agent plane and automatically advertises itself on the local network via
mDNS (`_rbo-controller._tcp`). Use `rbo controller start` without `--daemon` when you want logs in
the current terminal.

## 4. Set up and pair an Agent

Run these steps on each worker machine.

### Auto-discovery setup (default)

Initialize the Agent:

```bash
rbo agent init
```

`rbo agent init` automatically scans the local network via mDNS, discovers your Controller, and
prompts you to select it:

```
Scanning for RBO controllers on local network...

Found 1 controller(s):
  1) rbo-controller (192.168.1.50:7411)
     controller_01JXYZ...  fingerprint: sha256:abcd1234...
  0) Skip — configure manually later

Select controller [1, 0 to skip]: 1

Configured controller: rbo-controller (wss://192.168.1.50:7411/agent)
Run `rbo agent start` to connect and begin pairing.
```

Selecting your Controller automatically configures `controller_url` and pins `controller_fingerprint`
in `agent.json` — no manual IP lookup or fingerprint copying required.

> [!WARNING]
> On untrusted or shared networks, verify that the displayed fingerprint matches `rbo controller fingerprint` on your Controller before connecting, or use manual setup (`rbo agent init --skip-discovery`).

Start the Agent:

```bash
rbo agent start --daemon
```

Back on the Controller machine, approve the pending pairing request:

```bash
rbo agent approve          # prompts to select from pending requests (or pass <id> directly)
rbo agents                 # confirms the worker is connected
```

If multiple workers are pairing, `rbo agent approve` presents an interactive numbered menu displaying each worker's display name, hostname, ID, and one-time code. If only one worker is waiting, pressing Enter accepts the default `[1]`.

To reject an unrecognized request instead: `rbo agent reject` (or `rbo agent reject <pairing-request-id>`).

You can also run `rbo discover` on any machine at any time to scan for active Controllers.

### Manual fallback (routed networks or headless CI)

If the worker is on a different subnet where mDNS multicast is not forwarded, skip discovery with
`rbo agent init --skip-discovery` and edit `~/.rbo/agent/agent.json` (on Windows,
`%USERPROFILE%\.rbo\agent\agent.json`):

```json
{
  "controller_url": "wss://build-controller.local:7411/agent",
  "controller_fingerprint": "<output of rbo controller fingerprint on Controller>",
  "display_name": "workstation-1",
  "max_jobs": 1,
  "repo_cache_dir": "/home/you/.rbo/repositories"
}
```

Use the Controller's reachable host in `controller_url`. Keep the generated fingerprint exact:
it protects the Agent from connecting to the wrong Controller. `repo_cache_dir` is optional but
recommended because it avoids cloning the same repository for every job.

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

From your project directory:

```bash
cd /home/you/projects/my-app
rbo run --follow -- 'echo "RBO is working"'
```

PowerShell:

```powershell
rbo run --follow --shell powershell -- 'Write-Output "RBO is working"'
```

Pass one command string after `--`. Use `--shell` and `--target-os` when the Agent runs a different
OS than the Controller.

For a full request with required artifacts, use `rbo submit job.json`. See the
[CLI reference](cli-reference.md) for all options and flags.

## 7. Guide your AI assistant

Add this rule to your project's `AGENTS.md`:

```markdown
## Remote builds
Use RBO MCP tools for builds and tests. Always specify `shell` and
`target_os` matching a live Agent (`agents_list`). If `job_run` returns
`resume: true`, call again with the same `job_id` and pass the returned
`next_log_cursor` under `log_cursor`.
```

The complete template is in [AI client configuration](client-integration/README.md).

## 8. How source transfer works

RBO sends only your uncommitted changes over a Git base commit (**overlay**). This requires a
fetchable Git remote in `git_allowlist.hosts`. If overlay capture fails, the job fails by default —
enable `allow_full_snapshot_fallback` in `controller.json` to upload the full tree instead.

## Next steps

- Explore the [CLI reference](cli-reference.md) for command syntax, flags, and exit codes.
- Run [`rbo doctor`](troubleshooting.md) first when something does not work.
- Use the [operator runbook](runbook.md) for updates, recovery, backup, and removal.
- Read [backup and restore](backup-restore.md) before moving Controller state.
- See [current limitations](../../README.md#current-limitations) before running untrusted or
  platform-sensitive workloads.
