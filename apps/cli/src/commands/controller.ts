import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { writeDefaultControllerConfigFile } from '@rbo/controller/config';
import { validateRestoredControllerDatabase } from '@rbo/controller/restore';
import { runController } from '@rbo/controller/run';
import {
  type BackupManifest,
  RBO_CONTROLLER_SCHEMA_VERSION,
  applyRestoredFiles,
  ensureControllerIdentity,
  recoverPendingControllerRestore,
  validateRestore,
} from '@rbo/shared';
import {
  controllerLogPath,
  controllerPidPath,
  isDaemonChild,
  spawnDetachedDaemon,
} from './daemon.js';
import {
  ensureNotRunningOrReplace,
  runRegisteredRole,
  stopRoleForCli,
} from './process-lifecycle.js';

export interface ControllerInitOptions {
  dataDir: string;
  /** Rewrite `controller.json` even if it already exists. */
  force?: boolean;
}

export interface ControllerIdentitySummary {
  controllerId: string;
  fingerprint: string;
  /** Operator config path loaded at runtime (`controller.json`). */
  configPath: string;
  /** Whether init wrote (or rewrote) the operator config. */
  configWritten: boolean;
}

// `rbo controller init` (§33, Phase 2): generate the pinned TLS certificate
// and signing keys once; safe to re-run — it reuses the existing identity.
// Also writes a complete default `controller.json` if missing (or with --force).
export async function runControllerInit(
  options: ControllerInitOptions,
): Promise<ControllerIdentitySummary> {
  await recoverPendingControllerRestore(options.dataDir);
  const identity = await ensureControllerIdentity(options.dataDir);
  const config = writeDefaultControllerConfigFile(options.dataDir, { force: options.force });
  return {
    controllerId: identity.controllerId,
    fingerprint: identity.fingerprint,
    configPath: config.path,
    configWritten: config.written,
  };
}

// `rbo controller fingerprint`: display the fingerprint out-of-band so the
// operator can compare it on the Agent side before approving pairing.
export async function runControllerFingerprint(
  options: ControllerInitOptions,
): Promise<Pick<ControllerIdentitySummary, 'controllerId' | 'fingerprint'>> {
  await recoverPendingControllerRestore(options.dataDir);
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

export async function isControllerInitialized(dataDir: string): Promise<boolean> {
  return (await readExistingControllerId(dataDir)) !== undefined;
}

export interface ControllerStartOptions {
  dataDir: string;
  daemon?: boolean;
  /** Restart a live Controller after TTY confirm or when true. */
  replace?: boolean;
  /** CLI script path (`process.argv[1]`) for daemon re-exec. */
  cliScriptPath?: string;
}

/** @returns `undefined` when started in foreground, pid when daemon, or `null` when operator declined restart. */
export async function runControllerStart(
  options: ControllerStartOptions,
): Promise<number | undefined | null> {
  await recoverPendingControllerRestore(options.dataDir);
  if (!(await isControllerInitialized(options.dataDir))) {
    throw new Error('Controller is not initialized. Run `rbo controller init` first.');
  }

  // The daemon launcher already checked/replaced the running role. Scanning again
  // would mistake the launcher (which now waits for readiness) for another Controller.
  const daemonChild = !options.daemon && isDaemonChild();
  const shouldStart =
    daemonChild ||
    (await ensureNotRunningOrReplace('controller', {
      dataDir: options.dataDir,
      replace: options.replace,
    }));
  if (!shouldStart) {
    return null;
  }

  if (options.daemon) {
    const cliScript = options.cliScriptPath;
    if (!cliScript) {
      throw new Error('cliScriptPath is required for daemon start');
    }
    const pid = await spawnDetachedDaemon({
      command: process.execPath,
      args: [cliScript, 'controller', 'start', '--data-dir', resolve(options.dataDir)],
      pidFile: controllerPidPath(options.dataDir),
      logFile: controllerLogPath(options.dataDir),
      label: 'Controller',
      role: 'controller',
      readyMessage: 'rbo:controller-ready',
    });
    return pid;
  }

  const run = () => runController({ dataDir: options.dataDir });
  if (daemonChild) {
    // The parent uses an absolute path in the child command line.
    await run();
  } else {
    await runRegisteredRole('controller', { dataDir: options.dataDir }, run);
  }
}

export async function runControllerStop(options: ControllerInitOptions): Promise<{
  stopped: number[];
  alreadyStopped: boolean;
}> {
  return stopRoleForCli('controller', { dataDir: options.dataDir });
}

// `rbo controller restore <staging-dir>` (§26, Phase 8 runbook step "Run restore validation"):
// the enforced code path the operator runbook previously only described as a manual step. Stop
// the Controller before running this — restore does not check whether one is currently running.
export async function runControllerRestore(
  options: ControllerRestoreOptions,
): Promise<ControllerRestoreResult> {
  await recoverPendingControllerRestore(options.dataDir, options.stagingDir);
  const expectedControllerId = await readExistingControllerId(options.dataDir);
  const manifest: BackupManifest = await validateRestore(options.stagingDir, {
    latestSchemaVersion: RBO_CONTROLLER_SCHEMA_VERSION,
    expectedControllerId,
  });
  await applyRestoredFiles(
    options.stagingDir,
    options.dataDir,
    manifest,
    validateRestoredControllerDatabase,
  );
  return {
    ok: true,
    controller_id: manifest.controller_id,
    controller_schema_version: manifest.controller_schema_version,
    files_restored: manifest.files.length,
  };
}
