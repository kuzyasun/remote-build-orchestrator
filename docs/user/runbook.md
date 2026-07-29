# Operator runbook

This guide covers routine operation after the first successful job. For initial installation and
pairing, use [Getting started](getting-started.md).

Commands below assume a global npm installation. For a release archive, replace `rbo` with
`node <RBO_ROOT>/bin/rbo.js`.

## Install

For first-time installation, follow [Getting started](getting-started.md). To check an existing
installation, start with:

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
rbo agent stop-process
```

Omit `--daemon` to run a process in the current terminal. `rbo agent stop` belongs to the optional
OS-service workflow; use `stop-process` for a foreground or daemon process.

## Pair

On the new worker:

```bash
rbo agent init
# edit ~/.rbo/agent/agent.json
rbo agent start --daemon
```

The Agent will connect in `pairing_pending` state.

## Approve

On the Controller:

```bash
rbo agents
rbo agent approve <pairing-request-id>
```

Approve only a request whose display name, host, and fingerprint exchange you expect.

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
rbo agent status
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
