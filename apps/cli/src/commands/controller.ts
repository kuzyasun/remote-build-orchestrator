import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type BackupManifest,
  RBO_CONTROLLER_SCHEMA_VERSION,
  applyRestoredFiles,
  ensureControllerIdentity,
  validateRestore,
} from '@rbo/shared';

export interface ControllerInitOptions {
  dataDir: string;
}

export interface ControllerIdentitySummary {
  controllerId: string;
  fingerprint: string;
}

// `rbo controller init` (§33, Phase 2): generate the pinned TLS certificate
// and signing keys once; safe to re-run — it reuses the existing identity.
export async function runControllerInit(
  options: ControllerInitOptions,
): Promise<ControllerIdentitySummary> {
  const identity = await ensureControllerIdentity(options.dataDir);
  return { controllerId: identity.controllerId, fingerprint: identity.fingerprint };
}

// `rbo controller fingerprint`: display the fingerprint out-of-band so the
// operator can compare it on the Agent side before approving pairing.
export async function runControllerFingerprint(
  options: ControllerInitOptions,
): Promise<ControllerIdentitySummary> {
  const identity = await ensureControllerIdentity(options.dataDir);
  return { controllerId: identity.controllerId, fingerprint: identity.fingerprint };
}

export interface ControllerRestoreOptions {
  stagingDir: string;
  dataDir: string;
}

export interface ControllerRestoreResult {
  ok: true;
  controller_id: string;
  controller_schema_version: number;
  files_restored: number;
}

/**
 * Read-only: does `dataDir` already have a provisioned identity? Deliberately does NOT call
 * ensureControllerIdentity, which would create one — that would make every restore look like a
 * "fresh dir" (defeating the ownership check) the first time it's ever invoked.
 */
async function readExistingControllerId(dataDir: string): Promise<string | undefined> {
  const certPath = join(dataDir, 'security', 'controller-cert.pem');
  const metaPath = join(dataDir, 'security', 'controller.json');
  if (!existsSync(certPath) || !existsSync(metaPath)) {
    return undefined;
  }
  const meta = JSON.parse(await readFile(metaPath, 'utf8')) as { controller_id: string };
  return meta.controller_id;
}

// `rbo controller restore <staging-dir>` (§26, Phase 8 runbook step "Run restore validation"):
// the enforced code path the operator runbook previously only described as a manual step. Stop
// the Controller before running this — restore does not check whether one is currently running.
export async function runControllerRestore(
  options: ControllerRestoreOptions,
): Promise<ControllerRestoreResult> {
  const expectedControllerId = await readExistingControllerId(options.dataDir);
  const manifest: BackupManifest = await validateRestore(options.stagingDir, {
    latestSchemaVersion: RBO_CONTROLLER_SCHEMA_VERSION,
    expectedControllerId,
  });
  await applyRestoredFiles(options.stagingDir, options.dataDir, manifest);
  return {
    ok: true,
    controller_id: manifest.controller_id,
    controller_schema_version: manifest.controller_schema_version,
    files_restored: manifest.files.length,
  };
}
