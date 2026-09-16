# RBO CLI reference

This document is the complete reference for the `rbo` command-line interface.

For an introductory walkthrough, see [Getting started](getting-started.md). For day-2 operations, see the [Operator runbook](runbook.md).

---

## Global options & environment

```bash
rbo [--help|-h|help] [--version|-v]
```

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `RBO_CONTROLLER_URL_HTTP` | `http://127.0.0.1:7410` | Controller HTTP base URL |
| `RBO_DATA_DIR` | `~/.rbo` | Controller state directory (`%USERPROFILE%\.rbo` on Windows) |
| `RBO_AGENT_STATE_DIR` | `~/.rbo/agent` | Agent state directory (`%USERPROFILE%\.rbo\agent` on Windows) |
| `RBO_MDNS_ENABLED` | `true` | Enable or disable Controller mDNS advertisement |
| `RBO_MDNS_DISPLAY_NAME` | `rbo-controller` | Instance name advertised via mDNS/DNS-SD |

---

## Job execution commands

### `rbo run`

Executes a command remotely in an isolated snapshot of your working tree.

```bash
rbo run [options] -- <shell-command-string>
```

#### Options

| Option | Description |
| --- | --- |
| `--follow` | Stream live logs until the job completes. Mutually exclusive with `--json`. |
| `--json` | Output one final JSON execution result object to stdout. Mutually exclusive with `--follow`. |
| `--project <path>` | Path to project root (default: current working directory). Must be inside `allowed_project_roots`. |
| `--cwd <relative-path>` | Working directory inside the project root (default: `.`). |
| `--shell <shell>` | Target shell: `bash`, `zsh`, `sh`, `powershell`, `pwsh`, `cmd`, or `direct`. Default: Controller host default shell. |
| `--target-os <os>` | Repeatable OS filter: `linux`, `macos`, or `windows`. Default: Controller host OS. |
| `--timeout <seconds>` | Remote execution timeout in seconds (default: Controller config). |
| `--risk <level>` | Declared risk level: `safe`, `normal`, `destructive`, or `hardware`. Default: `normal`. |
| `--artifact <glob>` | Repeatable optional artifact glob pattern to collect upon job completion. |
| `--queue-policy <policy>` | Policy when no remote Agent is available: `local_fallback`, `wait`, or `fail_fast`. Default: Controller config. |

#### Command syntax and quoting

Pass exactly **one** target-shell command string after `--`.

Your local shell strips one level of quotes before invoking `rbo`. RBO transmits the remaining string verbatim to the target shell on the worker Agent without translation.

- **Bash / Linux / macOS**:
  ```bash
  rbo run --follow -- 'echo "Building..." && pnpm test'
  ```
- **PowerShell / Windows**:
  ```powershell
  rbo run --follow --shell powershell -- 'Write-Output "Running on worker"; npm test'
  ```
- **Cross-platform target**:
  When submitting from a Windows Controller to a Linux Agent, specify `--shell bash --target-os linux`:
  ```powershell
  rbo run --follow --shell bash --target-os linux -- 'make clean && make -j4'
  ```

#### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Job succeeded. |
| `1` | Job failed (command exited non-zero or execution error). |
| `125` | Job requires confirmation (destructive or hardware risk) and terminal is non-interactive. |
| `130` | Cancelled by user (Ctrl+C). |

#### Interactive confirmation

When `--risk destructive` or `--risk hardware` is requested:
- In an interactive TTY, `rbo run` prompts the operator to confirm before execution begins.
- In a non-interactive environment (CI / scripts), `rbo run` exits immediately with code `125`.

---

### `rbo submit`

Submits a structured JSON job specification to the Controller.

```bash
rbo submit <job-request.json>
```

#### Specification schema (`job.json`)

```json
{
  "client_request_id": "job-build-001",
  "name": "production-build",
  "source": {
    "project_root": "/home/you/projects/my-app",
    "cwd": "."
  },
  "execution": {
    "shell": "bash",
    "script": "pnpm build && pnpm test",
    "timeout_seconds": 600
  },
  "risk_level": "safe",
  "artifacts": [
    { "glob": "dist/**", "required": true },
    { "glob": "coverage/**", "required": false }
  ],
  "queue_policy": "wait"
}
```

---

### `rbo logs`

Inspects or follows logs for an existing job.

```bash
rbo logs <job-id> [--follow]
```

- Without `--follow`: Fetches and prints logs collected up to the current moment.
- With `--follow`: Streams logs continuously until the job reaches a terminal state (`succeeded`, `failed`, or `cancelled`).

---

### `rbo cancel`

Requests graceful cancellation of a queued or running job.

```bash
rbo cancel <job-id> [reason]
```

---

## Fleet & discovery commands

### `rbo discover`

Scans the local network for RBO Controllers via mDNS/DNS-SD (`_rbo-controller._tcp.local`).

```bash
rbo discover [--json]
```

- Default: Displays a formatted table with name, IP address, port, Controller ID, and TLS fingerprint.
- `--json`: Outputs raw JSON array of discovered controller descriptors.

---

### `rbo agents`

Lists registered worker Agents, online statuses, capacity, and pending pairing requests.

```bash
rbo agents
```

---

## Controller management

```bash
rbo controller init [--force] [--data-dir <dir>]
rbo controller fingerprint [--data-dir <dir>]
rbo controller start [--daemon] [--replace] [--data-dir <dir>]
rbo controller stop [--data-dir <dir>]
rbo controller restore <staging-dir> [--data-dir <dir>]
```

| Command | Description |
| --- | --- |
| `init` | Initializes Controller state directory and generates identity if missing. Use `--force` to rewrite defaults. |
| `fingerprint` | Prints Controller SHA-256 TLS certificate fingerprint for agent pairing. |
| `start` | Starts Controller daemon. Use `--daemon` for detached background process, `--replace` to restart an existing instance. |
| `stop` | Stops a running background Controller daemon. |
| `restore` | Restores Controller database and certificates from a backup staging directory. |

---

## Agent management

```bash
rbo agent init [--force] [--skip-discovery] [--state-dir <dir>]
rbo agent start [--daemon] [--replace] [--state-dir <dir>]
rbo agent stop-process [--state-dir <dir>]
rbo agent approve [<pairing-request-id>]
rbo agent reject [<pairing-request-id>]
rbo agent revoke <agent-id>
rbo agent probe <agent-id>
rbo agent install|status|stop|uninstall [--execute]
```

| Command | Description |
| --- | --- |
| `init` | Initializes Agent configuration (`agent.json`). Scans LAN via mDNS unless `--skip-discovery` is passed. |
| `start` | Starts Agent worker process. Use `--daemon` for detached background execution, `--replace` to restart. |
| `stop-process` | Stops a running foreground or daemon Agent process. |
| `approve [<id>]` | Approves a pending agent pairing request on the Controller (interactive menu if `<id>` omitted). |
| `reject [<id>]` | Rejects a pending agent pairing request (interactive menu if `<id>` omitted). |
| `revoke <id>` | Revokes credentials and authorization for an existing Agent. |
| `probe <id>` | Queries an active Agent for hardware capabilities, shells, and installed tools. |
| `install\|status...` | Generates or executes OS service plans (systemd, launchd, Windows Service). |

---

## Diagnostics

### `rbo doctor`

Performs comprehensive pre-flight and runtime checks.

```bash
rbo doctor [--data-dir <dir>]
```

Validates:
- Node.js runtime version compatibility (`>=24.0.0`);
- Git availability and version;
- Local shell availability (Bash, PowerShell, Cmd);
- Windows executor binary and Job Object process isolation (on Windows x64);
- Controller connectivity and database state;
- Data directory read/write permissions.
