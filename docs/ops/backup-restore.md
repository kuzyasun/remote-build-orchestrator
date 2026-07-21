# Backup, restore, and credential recovery

## Backup boundaries

Include:

- Controller SQLite database (`controller.sqlite`)
- Attempt artifacts and logs under `attempts/` (as required by retention policy)
- Controller identity material (`identity/`) **only** via an operator-protected mechanism
  (encrypted volume, offline vault, or access-controlled backup store)

Never back up into a public repo or package archive. Packaging exclude rules reject
identity keys, `.env`, credentials, caches, logs, and snapshots.

## Restore procedure

1. Stop the Controller.
2. Stage backup files into a restore directory containing `BACKUP_MANIFEST.json`.
3. With `$RBO_DATA_DIR` exported and/or `--data-dir <dir>`, run
   `node bin/rbo.js controller restore <staging-dir>`. This is an enforced code path,
   not a manual step: it runs restore validation (ownership + hashes + required paths + schema
   version check) and only copies files into the target data dir if validation passes — it never
   partially applies a failed restore.
4. On validation failure: the command exits non-zero with a structured error code
   (`ownership_mismatch`, `hash_mismatch`, `missing_file`, `missing_manifest`, or
   `unsupported_downgrade`) and leaves `$RBO_DATA_DIR` untouched; do not start Controller.
5. On success: start Controller, confirm `rbo doctor`.

Ownership: `BACKUP_MANIFEST.json` records the `controller_id` of the Controller it was taken
from. When restoring onto a data dir that already has a provisioned identity, pass that
identity's `controllerId` as `expectedControllerId` to `validateRestore` — a mismatch fails
closed with `ownership_mismatch` before anything is touched. Restoring onto a genuinely fresh,
never-provisioned data dir (no prior identity to compare against) omits this check, since the
backup is establishing ownership for the first time.

Unsupported downgrade: if backup `controller_schema_version` is **newer** than the
running binary's migration set, restore **must fail** with `unsupported_downgrade`.

## Credential recovery

If an Agent credential is lost or compromised:

1. Revoke the Agent on the Controller.
2. Re-pair the Agent on the same or a new machine.
3. **Never copy Agent private keys** between machines.

Controller identity recovery uses the protected identity backup — rotate credentials
for all Agents after a Controller key compromise.
