# Operator runbook

Exact recoverable procedures for a new worker machine. Prefer
`npm install -g @gemslibe/rbo` and [`getting-started.md`](./getting-started.md) when online;
commands below assume an OS archive extract (air-gap) with `RBO_ROOT` / `RBO_DATA_DIR` set.
Maintainers cutting/publishing a release: [`docs/dev/release-builds.md`](../dev/release-builds.md).
Never commit or copy Agent private keys between machines.

## Install

1. Extract the OS archive from `packaging/<os>/` (after `pnpm package:archives` / assemble per
   `docs/dev/release-builds.md`).
2. `rbo controller init` / `rbo agent init` write live operator configs
   (`~/.rbo/controller.json` and `~/.rbo/agent/agent.json`, or under `$RBO_DATA_DIR` /
   `$RBO_AGENT_STATE_DIR`). Edit those files for day-to-day setup. Env vars override the file when
   set (useful for CI/scripts). Package/archive templates under `config/controller.json` and
   `config/agent.json` match the defaults init writes. Fill `allowed_project_roots` before
   expecting jobs to submit (see `docs/ops/getting-started.md`).
3. Initialize Controller identity (optional `--data-dir <dir>`, same as env `RBO_DATA_DIR`):
   `node bin/rbo.js controller init`.
4. Start Controller: `node bin/rbo.js controller start` (foreground or `--daemon`), listening on
   loopback MCP `127.0.0.1:7410`.
5. Start the Agent (prefer process mode): `node bin/rbo.js agent start` or
   `node bin/rbo.js agent start --daemon`. Optional OS service registration is best-effort:
   - `node bin/rbo.js agent install` prints a dry-run plan using `node` + bundled `rbo.js`
     `agent start --state-dir …` (not a Program Files `rbo-agent.exe`).
   - Review printed commands, then `node bin/rbo.js agent install --execute` (requires elevation).
6. `node bin/rbo.js doctor`

## Pair

1. On Agent: start pairing / connect to Controller WSS with pinned fingerprint from
   `node bin/rbo.js controller fingerprint`.
2. On Controller admin API: list pairing requests.
3. Approve only expected display names / hosts.

## Approve

1. `rbo agent approve <pairing_id>` (or admin HTTP `/internal/v1/admin/pairing/approve`).
2. Confirm Agent appears in `agents_list` with capabilities.

## Drain

1. Stop scheduling new work: disable Agent or set capacity to zero via admin revoke/disable.
2. Wait for running attempts to reach terminal state (`job_wait`).
3. Confirm no active leases.

## Revoke

1. `rbo agent revoke <agent_id>` — invalidates credentials.
2. Agent must re-pair; do **not** copy private keys to another host.
3. Confirm revoked Agent cannot obtain leases or data tokens.

## Repair

1. Run `rbo doctor`.
2. If Agent stuck: stop service → inspect `$RBO_DATA_DIR` / agent state → start service.
3. If Controller DB locked: stop Controller, run backup, restore from last good backup.
4. Credential issues → revoke + re-pair (see [backup-restore.md](./backup-restore.md)).

## Update

1. Drain Agents. For `npm install -g @gemslibe/rbo`, the package `preinstall` hook stops
   running foreground/`--daemon` Controller and Agent processes automatically (set
   `RBO_SKIP_INSTALL_STOP=1` to skip). Stop OS services yourself if you use them.
2. Backup Controller state.
3. Install the new package (`npm install -g @gemslibe/rbo` or replace binaries from a new
   versioned archive); keep `data_dir` and identity.
4. Start Controller; migrations apply on boot.
5. Start Agents; confirm wire negotiate still succeeds (incompatible peers stay diagnostic-only).

## Backup

See [backup-restore.md](./backup-restore.md). Backup SQLite, attempts/artifacts/logs as needed,
and identity only through an operator-protected path.

## Restore

1. Stop the Controller.
2. Stage backup files (including `BACKUP_MANIFEST.json`) into a directory.
3. With `$RBO_DATA_DIR` exported and/or `--data-dir <dir>` (same override as `controller init` /
   `start`): `node bin/rbo.js controller restore <staging-dir>` — validates ownership, hashes, and
   schema (fails closed with a structured error, e.g. `ownership_mismatch`, `hash_mismatch`,
   `unsupported_downgrade`) and only then copies files into the target data dir.
4. Start the Controller; confirm `rbo doctor`.

See [backup-restore.md](./backup-restore.md) for the full ownership/hash/schema model.

## Uninstall

1. Drain and revoke Agents.
2. `node bin/rbo.js agent uninstall` (dry-run) then `--execute`.
3. Stop Controller; optionally archive then delete `$RBO_DATA_DIR`.
4. Remove package files.
