# Backup and restore

Controller state contains job metadata, retained logs and artifacts, and the Controller identity.
The identity is sensitive: store backups on an encrypted or access-controlled destination.

Never copy Agent private keys between machines. Revoke and re-pair an Agent when its credentials
are lost or compromised.

## What to back up

The default Controller data directory is `~/.rbo` (or `%USERPROFILE%\.rbo` on Windows). A complete
backup includes:

- `controller.sqlite`;
- `identity/`;
- `attempts/` when retained logs and artifacts matter;
- the Controller configuration.

Stop the Controller before taking a filesystem copy so the database and files represent one
consistent point in time.

## Current backup workflow

RBO currently validates manifest-based restores but does not expose a CLI command that creates a
backup bundle. Until that command exists, the simplest recoverable backup is a protected copy of
the complete Controller data directory.

To recover that copy to the same location:

1. Stop the Controller.
2. Move the damaged data directory aside; do not overwrite it immediately.
3. Restore the complete protected copy to the original path with the original ownership and
   permissions.
4. Start the same or a newer RBO version.
5. Run `rbo doctor` and a small test job.

Do not restore state created by a newer RBO version into an older binary.

## Manifest-based restore

`rbo controller restore` is for a staging directory produced by compatible backup tooling. The
directory must contain `BACKUP_MANIFEST.json`, `controller.sqlite`, and `identity/`, with hashes
and Controller ownership recorded in the manifest:

```bash
rbo controller restore <staging-directory>
```

Use `--data-dir <path>` when restoring outside the default location. RBO validates required files,
hashes, schema compatibility, and Controller identity before copying anything. A failed validation
leaves the target data directory unchanged.

Do not hand-write the manifest or bypass validation. Keep the original backup until the restored
Controller has started and passed `rbo doctor`.

## Credential recovery

If an Agent credential is lost or compromised:

1. run `rbo agent revoke <agent-id>` on the Controller;
2. remove the Agent's local state if it is compromised;
3. initialize and pair it again.

If the Controller identity is compromised, restore only from a protected identity backup and
revoke and re-pair every Agent.
