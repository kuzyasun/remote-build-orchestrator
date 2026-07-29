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

## The Agent stays in `pairing_pending`

On the Controller:

```bash
rbo agents
rbo agent approve <pairing-request-id>
```

If no request appears, check the Agent's `controller_url`, network access to port `7411`, and
`controller_fingerprint`. The fingerprint must exactly match `rbo controller fingerprint`.

## The Agent is online but receives no jobs

RBO selects only an Agent that matches the job's OS, architecture, shell, tools, labels, and free
capacity.

- Inspect the Agent with `rbo agents`.
- Re-probe installed tools with `rbo agent probe <agent-id>`.
- Check that `execution.shell` exists on that Agent.
- Check the job's `requirements`.
- Wait for capacity, or change the queue policy deliberately.

Installing a tool after the Agent starts requires a new probe or restart before the Controller can
schedule against it.

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

`allow_full_snapshot_fallback` is off by default because a full upload can be slow and large.
Enable it only for repositories that genuinely cannot use an overlay:

```json
{
  "allow_full_snapshot_fallback": true
}
```

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
