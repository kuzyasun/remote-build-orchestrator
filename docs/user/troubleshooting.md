# Troubleshooting

Start with:

```bash
rbo doctor
rbo agents
```

`rbo doctor` checks the local installation and Controller. `rbo agents` shows whether workers are
paired, online, compatible, and below capacity.

## The AI client cannot start `rbo-mcp-stdio`

GUI applications sometimes do not inherit the terminal's npm `PATH`.

1. Restart the AI client after installing RBO.
2. Confirm `rbo-mcp-stdio` works in a new terminal.
3. If needed, configure the client to launch the proxy through an absolute path:

   ```json
   {
     "type": "stdio",
     "command": "node",
     "args": ["<absolute-path-to-rbo>/dist/rbo-mcp-stdio.js"],
     "env": {
       "RBO_CONTROLLER_URL": "http://127.0.0.1:7410"
     }
   }
   ```

For a release archive, the script is `<RBO_ROOT>/bin/rbo-mcp-stdio.js`. For a repository build, it
is `<REPO>/apps/cli/dist/rbo-mcp-stdio.js`.

## The project root is not allowed

Symptom:

```text
Project root is not under allowed roots
```

Add the project's absolute path to `allowed_project_roots` in
`~/.rbo/controller.json`, then restart the Controller. Parent directories are allowed only when
you list them explicitly.

## An artifact cannot be materialized

`artifact_materialize` checks the existing destination parent against
`allowed_artifact_destinations` on the Controller PC. If it reports that the
parent directory does not exist, create that directory before retrying. If it
reports that the path is outside allowed destinations, compare the returned
`resolved_parent` and `resolved_allowed_roots`. Add a stable, narrow destination
root to Controller configuration if needed, then restart the Controller.
Junctions and symlinks are checked by their resolved paths.

On Windows, the Controller needs a compatible RBO Windows helper to publish files into the
verified directory. Check `windows_executor` with `rbo doctor` and install or update the helper
from the matching RBO release if it is missing or out of date.

## A Windows job fails with an unsupported helper protocol

Windows job execution requires Windows 10 or Windows Server 2016 or later and helper protocol v3.
Install the Windows helper from the same RBO
release as the Agent or Controller. If `RBO_WINDOWS_EXECUTOR` points to a custom helper, update
that executable and restart the Agent or Controller before retrying the job.

## A build succeeds but required artifacts are missing

Read `missing_required_artifacts` in the final `job_run` response. It includes
the glob, status, counts, and `artifact_search_base` for the terminal attempt.
The base is the submitted `source.project_root`, not `source.cwd`.

`no_match` means the Agent found no path. `skipped` includes a collection
reason. `limit_exceeded` reports a file-count or byte limit. `not_stored`
means the Controller is missing one or more collected artifacts for the rule.
`interrupted` means the Controller reached the end of attempt recovery without a complete artifact summary.
In that case, `collection_interrupted: true` identifies the interruption and the process outcome
is preserved.
`job_artifacts` provides complete per-rule counts and skip reasons.
When `collection_reported` is false and there is no `collection_interrupted` flag, update the
remote Agent to receive exact match counts. A successful
command still has outcome `succeeded` when a required artifact is missing.

## The Agent stays in `pairing_pending`

On the Controller:

```bash
rbo agents
rbo agent approve <pairing-request-id>
```

If no request appears, check the Agent's `controller_url`, network access to port `7411`, and
`controller_fingerprint`. The fingerprint must exactly match `rbo controller fingerprint`.

## The Agent still dials an old Controller address

`rbo agent status` shows `connect ECONNREFUSED` for an address the Controller no longer uses
(DHCP or a network change). A running Agent rechecks mDNS at startup, about once a minute, and
after each failed connect. When the advertisement has the same fingerprint at a new routable IP,
the Agent writes that address into `agent.json` and reconnects. The pairing credential is kept.

If `rbo discover` cannot see the Controller, mDNS is not reaching this machine — set
`controller_url` by hand, or export `RBO_CONTROLLER_URL` to pin an address and skip the refresh.

The Controller accepts that Agent from a new address with its existing credential
once the old connection closes or its heartbeat expires.

## Doctor reports duplicate Agent sessions

`WARN agent_session_conflicts` means a paired Agent tried to connect while the
Controller still had a live session for the same Agent ID. The first session keeps
its jobs. The other connection retries automatically.

`rbo doctor` lists affected Agent IDs when it has the local admin token. You can
also find the ID in the `duplicate agent session refused` Controller log entry.
On that worker, check `rbo agent status` and whether a service and a
manually started Agent are both running. Stop the extra instance. With the working
session still connected, the finding clears two minutes after the last refusal.

## Firewall blocks Agent connections or mDNS discovery

If remote Agents cannot discover the Controller (`rbo discover` finds nothing) or cannot connect to
the Agent plane (port `7411`), the host firewall is likely blocking incoming traffic. Run
`rbo doctor` on the Controller to inspect firewall and port status.

### Windows (PowerShell as Administrator)

Allow the Node.js executable (for `nvm4w` or standard installations) and open the dedicated inbound
ports for the Agent plane (TCP `7411`) and mDNS discovery (UDP `5353`):

```powershell
# Allow Node.js binary (example for nvm4w or standard path)
New-NetFirewallRule -DisplayName "RBO Node.js Controller" -Direction Inbound -Program "C:\nvm4w\nodejs\node.exe" -Action Allow -Profile Private,Public

# Open inbound ports for Agent plane (TCP 7411) and mDNS discovery (UDP 5353)
New-NetFirewallRule -DisplayName "RBO Agent Plane Port" -Direction Inbound -LocalPort 7411 -Protocol TCP -Action Allow -Profile Private,Public
New-NetFirewallRule -DisplayName "RBO mDNS Port" -Direction Inbound -LocalPort 5353 -Protocol UDP -Action Allow -Profile Private,Public
```

> [!TIP]
> To dynamically target your active Node.js executable regardless of where it is installed:
> ```powershell
> New-NetFirewallRule -DisplayName "RBO Node.js Controller" -Direction Inbound -Program (Get-Command node).Source -Action Allow -Profile Private,Public
> ```

### Linux

If `ufw` or `firewalld` is active:

```bash
# ufw
sudo ufw allow 7411/tcp comment "RBO Agent Plane"
sudo ufw allow 5353/udp comment "RBO mDNS Discovery"

# firewalld
sudo firewall-cmd --permanent --add-port=7411/tcp
sudo firewall-cmd --permanent --add-port=5353/udp
sudo firewall-cmd --reload
```

### macOS

If the macOS Application Firewall is active:

```bash
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add $(which node)
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp $(which node)
```

## The Agent is online but receives no jobs

RBO selects an Agent by OS, architecture, shell, labels, free capacity, and — when the job asks
for them — `git` or `git-lfs`. It does not match compilers or SDKs from an inventory.

- Inspect the Agent with `rbo agents` (state, OS, capacity).
- Check that `execution.shell` exists on that Agent.
- Check the job's `requirements`.
- Wait for capacity, or change the queue policy deliberately.

Compilers and SDKs are activated by the job script. If the build fails because one is missing,
install it on that Agent. `rbo agent probe` only refreshes the small PATH report (`git`,
`git-lfs`); it does not discover SDKs.

## Git overlay capture fails

RBO prefers a Git overlay so it transfers local changes instead of the entire repository. Common
causes are:

- the repository has no commit or fetch remote;
- the remote host is missing from `git_allowlist.hosts`;
- an SSH alias such as `github-work` is allowed as `github.com` instead of by its actual alias;
- the Agent cannot authenticate to the remote;
- a submodule is uninitialized, dirty, or uses a disallowed host;
- Git LFS content is missing locally or unavailable to the Agent.

Fix the reason shown in the error. Keep Controller and Agent Git allowlists aligned.

If an Agent cannot restore a submitted Git overlay, RBO fails that job with a diagnostic. For a new
job, select a full snapshot at submission with `rbo run --full-snapshot`, `snapshot_mode: "full"`
in `job_run`, or `source.snapshot_mode: "full"` in `job_submit`.

`allow_full_snapshot_fallback` is off by default because a full upload can be slow and large.
It applies when overlay capture is unavailable at submission time. Enable it only for repositories
that genuinely cannot use an overlay:

```json
{
  "allow_full_snapshot_fallback": true
}
```

## The Agent reports a Git mirror lock

Cancelling a preparation that is waiting for a mirror clone or fetch frees its Agent slot. Git
keeps the mirror locked until it finishes, so other jobs for the same repository may still wait.
If a mirror lock blocks worktree cleanup, the Agent records it and retries during heartbeats,
including after reconnect or restart. The workspace stays in place until Git cleanup succeeds.

Once Git finishes, the lock can be reclaimed even if the Agent process exited first. A legacy lock
or a marker left after the Git launcher itself stops can require manual recovery. Stop the Agent
and confirm that the previous Git operation has ended before removing the lock identified in the
Agent log.

## Submission is slow and uses a full CPU core

The Controller is probably creating a full snapshot of a large working tree. Check its log for the
overlay fallback reason. An allowlisted, reachable Git remote and an Agent `repo_cache_dir` usually
make repeated jobs much faster.

Move large tracked assets to Git LFS where practical. Push both commits and LFS objects before a
remote Agent needs them.

## The CLI cannot reach a remote Controller

The `rbo` CLI defaults to `http://127.0.0.1:7410`. When running the CLI on another machine, set:

```bash
export RBO_CONTROLLER_URL_HTTP=http://<controller-host>:7410
```

In PowerShell:

```powershell
$env:RBO_CONTROLLER_URL_HTTP = "http://<controller-host>:7410"
```

Do not confuse this with `RBO_CONTROLLER_URL`, which is used by Agents and the MCP stdio proxy.

## A process still uses the old version after update

Stop and restart both Controller and Agent processes. npm may skip RBO's lifecycle hook when
install scripts are disabled, leaving an old daemon alive after the package files change.

## An Agent reports that it is already running

A stale PID file can remain after an unclean shutdown. Run:

```bash
rbo agent stop-process
rbo agent start --daemon
```

Be careful with `--replace`: it can stop all matching RBO Agent or Controller processes on that
machine, including instances using another state directory.

For updates, recovery, and service commands, see the [operator runbook](runbook.md).
