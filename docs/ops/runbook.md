# Operator runbook (Phase 8)

Exact recoverable procedures for a new worker machine. Commands assume the
package archive has been extracted and `RBO_ROOT` / `RBO_DATA_DIR` are set.
Never commit or copy Agent private keys between machines.

## Install

1. Extract the OS archive from `packaging/<os>/` (after `pnpm package:archives`).
2. `config/controller.example.json` is a **reference only** — the Controller reads configuration
   exclusively from environment variables (it does not load any config file); set at least
   `RBO_DATA_DIR` and `RBO_ALLOWED_PROJECT_ROOTS` before starting it (see the full walkthrough in
   `docs/ops/getting-started.md`).
3. Initialize Controller identity (reads `$RBO_DATA_DIR` from the environment — there is no
   `--data-dir` flag): `node bin/rbo.js controller init`.
4. Start Controller: `node bin/rbo-controller.js` (foreground or service), listening on loopback
   MCP `127.0.0.1:7410`.
5. Install Agent service (dry-run first):
   - `node bin/rbo.js agent install`
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

1. Drain Agents and stop services.
2. Backup Controller state.
3. Replace binaries from new versioned archive; keep `data_dir` and identity.
4. Start Controller; migrations apply on boot.
5. Start Agents; confirm wire negotiate still succeeds (incompatible peers stay diagnostic-only).

## Backup

See [backup-restore.md](./backup-restore.md). Backup SQLite, attempts/artifacts/logs as needed,
and identity only through an operator-protected path.

## Restore

1. Stop the Controller.
2. Stage backup files (including `BACKUP_MANIFEST.json`) into a directory.
3. With `$RBO_DATA_DIR` exported (no `--data-dir` flag — the CLI reads it from the environment,
   same as every other `rbo controller` subcommand): `node bin/rbo.js controller restore
   <staging-dir>` — validates ownership, hashes, and schema (fails closed with a structured error,
   e.g. `ownership_mismatch`, `hash_mismatch`, `unsupported_downgrade`) and only then copies files
   into `$RBO_DATA_DIR`.
4. Start the Controller; confirm `rbo doctor`.

See [backup-restore.md](./backup-restore.md) for the full ownership/hash/schema model.

## Uninstall

1. Drain and revoke Agents.
2. `node bin/rbo.js agent uninstall` (dry-run) then `--execute`.
3. Stop Controller; optionally archive then delete `$RBO_DATA_DIR`.
4. Remove package files.
