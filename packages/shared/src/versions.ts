export const RBO_CONTROLLER_VERSION = '0.6.2';
export const RBO_AGENT_VERSION = '0.6.2';
export const RBO_STDIO_ADAPTER_VERSION = '0.6.2';

export const RBO_WIRE_PROTOCOL_MIN_VERSION = 1;
export const RBO_WIRE_PROTOCOL_MAX_VERSION = 1;

/**
 * Number of migrations in apps/controller/src/storage/migrations.ts (`MIGRATIONS.length`).
 * Duplicated here — not imported from apps/controller — so apps/cli can validate a restore
 * (`validateRestore`'s `latestSchemaVersion`) without a cross-app source import; a guard test in
 * apps/controller/test asserts `MIGRATIONS.length === RBO_CONTROLLER_SCHEMA_VERSION` so the two
 * never silently drift.
 */
export const RBO_CONTROLLER_SCHEMA_VERSION = 4;
