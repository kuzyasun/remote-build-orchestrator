# Operator runbook

This guide covers routine operation after the first successful job. For initial installation and
pairing, use [Getting started](getting-started.md).

Commands below assume a global npm installation. For a release archive, replace `rbo` with
`node <RBO_ROOT>/bin/rbo.js`.

## Verify installation

To check an existing installation:

```bash
rbo doctor
rbo agents
```

`rbo doctor` checks the local installation, Controller reachability, data directory, Git, shells,
and the Windows executor when applicable. `rbo agents` shows registered workers, pending pairing
requests, detected tools, and current capacity.

## Start and stop processes

```bash
rbo controller start --daemon
rbo controller stop

rbo agent start --daemon
rbo agent status
rbo agent stop-process
```

`rbo agent status` reports the local process, its controller URL, whether a pairing
credential is stored, and whether the process is connected. Omit `--daemon` to run a process in
the current terminal. `rbo agent stop` belongs to the optional OS-service workflow; use
`stop-process` for a foreground or daemon process.

## Pair

On the new worker (auto-discovery path):

```bash
rbo agent init       # scans LAN via mDNS; select your Controller [1]
rbo agent start --daemon
```

*(If mDNS is unavailable, use `rbo agent init --skip-discovery` and configure `controller_url` / `controller_fingerprint` in `agent.json` manually.)*

The Agent connects to the Controller and enters `pairing_pending` state.

## Approve

On the Controller:

```bash
rbo agent approve          # interactive selection, or `rbo agent approve <pairing-request-id>`
```

Approve only a request whose display name, host, and fingerprint exchange you expect.

## Reject

To reject a pending pairing request:

```bash
rbo agent reject           # interactive selection, or `rbo agent reject <pairing-request-id>`
```

## Drain

RBO does not currently expose a dedicated drain command.

1. Pause new job submissions.
2. Wait for the Agent's active jobs to finish.
3. Run `rbo agent stop-process` on that machine.
4. Confirm it is offline with `rbo agents`.

## Revoke

If the Agent must no longer be trusted, revoke it:

```bash
rbo agent revoke <agent-id>
```

Revocation invalidates its credentials. To use that machine again, initialize or start the Agent
and approve a new pairing request. Never copy Agent private keys between machines.

## Repair

1. Run `rbo doctor` on the Agent machine.
2. Run `rbo agents` on the Controller and inspect the Agent's state, tools, shells, and capacity.
3. Check the daemon log under the Agent state directory.
4. Restart the Agent with `rbo agent stop-process` followed by `rbo agent start --daemon`.
5. Revoke and re-pair only when credentials or Controller identity changed.

After an Agent process restart, its new boot ID lets the Controller mark orphaned attempts as lost.
Do not edit the SQLite database to repair them.

See [Troubleshooting](troubleshooting.md) for common symptoms.

## Update RBO

1. Pause submissions and let active jobs finish.
2. Create a protected Controller backup; see [Backup and restore](backup-restore.md).
3. Stop any OS services. A global npm install normally stops RBO daemon processes, but confirm
   they are stopped.
4. Install the new version on the Controller and Agents:

   ```bash
   npm install -g @gemslibe/rbo
   ```

5. Start the Controller. Database migrations run at startup.
6. Start Agents and confirm them with `rbo agents`.
7. Run `rbo doctor` and a small test job.

If npm lifecycle scripts are disabled, the automatic stop hook may not run. Restart every process
explicitly so it uses the new bundle.

## Backup

Controller state includes its database, identity, logs, and retained artifacts. Treat the identity
as a secret and keep the backup encrypted or access-controlled.

Follow [Backup and restore](backup-restore.md). Stop the Controller before taking a filesystem-level
backup.

## Restore

The supported recovery path depends on whether you have a complete data-directory copy or a
manifest-based backup. Follow [Backup and restore](backup-restore.md), and keep the original backup
until `rbo doctor` and a test job succeed.

## Install an Agent as an OS service

Service integration is best-effort and prints a plan by default:

```bash
rbo agent install
rbo agent install --execute
rbo agent stop --execute
rbo agent uninstall --execute
```

Review generated commands before using `--execute`; elevation may be required. For most developer
machines, `rbo agent start --daemon` is simpler.

## Uninstall

1. Pause submissions and finish or cancel active jobs.
2. Revoke Agents that should no longer be trusted.
3. Remove any installed Agent service with `rbo agent uninstall --execute`.
4. Stop Controller and Agent processes.
5. Back up Controller state if it may be needed later.
6. Uninstall the package:

   ```bash
   npm uninstall -g @gemslibe/rbo
   ```

7. Delete the RBO data directories only after confirming the backup and exact paths.

## Network discovery (mDNS)

The Controller advertises itself via mDNS/DNS-SD (`_rbo-controller._tcp.local`) by default. Agents
discover controllers automatically during `rbo agent init`. You can also scan manually:

```bash
rbo discover
```

### Disabling mDNS

To disable mDNS advertisement, set `mdns_enabled` to `false` in `controller.json` or use the
environment variable:

```bash
RBO_MDNS_ENABLED=false rbo controller start
```

When mDNS is disabled, agents must be configured manually with `controller_url` and
`controller_fingerprint` in `agent.json`.

## Snapshot limits and tuning

By default, the Controller enforces bounds on snapshot size to prevent unintentional uploads of large
binaries or unbounded node_modules folders. These limits can be adjusted in `controller.json`:

```json
{
  "max_snapshot_source_bytes": 1073741824,
  "max_snapshot_file_count": 100000,
  "max_snapshot_single_file_bytes": 268435456,
  "max_git_bundle_bytes": 536870912,
  "allow_full_snapshot_fallback": false
}
```

- **`max_snapshot_source_bytes`**: Maximum total uncompressed source bytes across all files (default: 1 GiB / 1,073,741,824 bytes).
- **`max_snapshot_file_count`**: Maximum number of regular files included in a snapshot (default: 100,000).
- **`max_snapshot_single_file_bytes`**: Maximum size of any individual uncommitted file (default: 256 MiB / 268,435,456 bytes).
- **`max_git_bundle_bytes`**: Maximum Git bundle transfer size when seeding missing commits to an Agent (default: 512 MiB / 536,870,912 bytes).
- **`allow_full_snapshot_fallback`**: When `false` (default), jobs fail fast if Git overlay capture is unavailable (e.g. non-allowlisted remotes or missing upstream). Set to `true` to permit uploading full working trees when overlay fails.
