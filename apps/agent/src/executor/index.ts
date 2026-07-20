import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import {
  appendLogChunk,
  collectArtifactFiles,
  ensureAttemptLogs,
  runCleanupScript,
  spawnJobScript,
  waitForCompletion,
  writeJobScript,
} from '@rbo/executor';
import type {
  ArtifactManifestPayload,
  ArtifactUploadGrantPayload,
  CancelJobPayload,
  CleanupCompletePayload,
  JobExitPayload,
  LeaseOfferPayload,
  PrepareSourcePayload,
  RunJobPayload,
} from '@rbo/protocol';
import { certificateFingerprint, createLogger, generateId, resolveContainedCwd } from '@rbo/shared';
import { materializeFullSnapshot } from '@rbo/snapshot';
import type { WebSocket } from 'ws';
import { StreamRedactor } from './redactor.js';

const logger = createLogger('agent.executor');
const ARTIFACT_TOKEN_TIMEOUT_MS = 60_000;

type ToolchainProfile = NonNullable<LeaseOfferPayload['selected_toolchain_profiles']>[number];

export interface AgentExecutorConfig {
  stateDir: string;
  /** Controller TLS certificate fingerprint (sha256:...), same pin as the WS session. */
  controllerFingerprint: string;
  /** Maps store ref name → environment variable that holds the secret value. */
  secretMap?: Record<string, string>;
  /** Current capability toolchain profiles for fingerprint recheck before spawn. */
  toolchainProfiles?: ToolchainProfile[];
}

function assertPinnedPeerCert(
  res: IncomingMessage,
  expectedFingerprint: string,
): Error | undefined {
  const socket = res.socket as unknown as {
    getPeerCertificate?: (detailed?: boolean) => { raw?: Buffer };
  };
  const cert = socket.getPeerCertificate?.(true);
  if (!cert?.raw) {
    return new Error('Controller did not present a TLS certificate');
  }
  const actual = certificateFingerprint(cert.raw);
  if (actual !== expectedFingerprint) {
    return new Error(
      `Controller certificate fingerprint mismatch: expected ${expectedFingerprint}, got ${actual}`,
    );
  }
  return undefined;
}

export class AgentJobExecutor {
  private activeAttemptId: string | null = null;
  private currentOffer: LeaseOfferPayload | null = null;
  private currentPrepare: PrepareSourcePayload | null = null;
  private materializedProjectPath: string | null = null;
  private activeProcessKill?: (graceSeconds?: number) => Promise<void>;
  private cancelSignal = { cancelled: false };
  private pendingArtifactUpload: {
    attemptId: string;
    resolve: (grant: ArtifactUploadGrantPayload) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(
    private socket: WebSocket,
    private config: AgentExecutorConfig,
  ) {}

  public isBusy(): boolean {
    return this.activeAttemptId !== null;
  }

  private sendFrame(
    type: string,
    attemptId: string,
    leaseId: string,
    leaseEpoch: number,
    payload: Record<string, unknown>,
  ): void {
    if (this.socket.readyState !== this.socket.OPEN) {
      return;
    }
    this.socket.send(
      JSON.stringify({
        protocol: 1,
        type,
        message_id: generateId('msg'),
        sent_at: new Date().toISOString(),
        attempt_id: attemptId,
        lease_id: leaseId,
        lease_epoch: leaseEpoch,
        payload,
      }),
    );
  }

  private matchesReservedLease(attemptId: string, leaseId: string, leaseEpoch: number): boolean {
    return (
      this.activeAttemptId === attemptId &&
      this.currentOffer?.attempt_id === attemptId &&
      this.currentOffer.lease_id === leaseId &&
      this.currentOffer.lease_epoch === leaseEpoch
    );
  }

  private clearAttempt(): void {
    this.activeAttemptId = null;
    this.currentOffer = null;
    this.currentPrepare = null;
    this.materializedProjectPath = null;
    this.activeProcessKill = undefined;
    this.cancelSignal = { cancelled: false };
    if (this.pendingArtifactUpload) {
      clearTimeout(this.pendingArtifactUpload.timer);
      const pending = this.pendingArtifactUpload;
      this.pendingArtifactUpload = null;
      pending.reject(new Error('attempt cleared'));
    }
  }

  /**
   * On WS disconnect / close: kill any running process and free the one-slot
   * registry so a reconnect cannot accept a new lease while work still runs.
   * Frames are not sent — the Controller already treats disconnect as terminal.
   */
  public async abandonOnDisconnect(): Promise<void> {
    this.cancelSignal.cancelled = true;
    if (this.activeProcessKill) {
      try {
        await this.activeProcessKill(10);
      } catch (error) {
        logger.warn('failed to kill process on disconnect', { error: String(error) });
      }
    }
    this.clearAttempt();
  }

  private sendCancelledTerminal(
    attemptId: string,
    leaseId: string,
    leaseEpoch: number,
    message: string,
  ): void {
    const exitPayload: JobExitPayload = {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: leaseEpoch,
      exit_code: null,
      outcome: 'cancelled',
      failure_category: 'cancelled',
      failure_message: message,
    };
    this.sendFrame(
      'job_exit',
      attemptId,
      leaseId,
      leaseEpoch,
      exitPayload as unknown as Record<string, unknown>,
    );

    const cleanupPayload: CleanupCompletePayload = {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: leaseEpoch,
      exit_code: null,
      timed_out: false,
      message,
    };
    this.sendFrame(
      'cleanup_complete',
      attemptId,
      leaseId,
      leaseEpoch,
      cleanupPayload as unknown as Record<string, unknown>,
    );
  }

  private failTerminal(
    attemptId: string,
    leaseId: string,
    leaseEpoch: number,
    failureCategory: NonNullable<JobExitPayload['failure_category']>,
    failureMessage: string,
  ): void {
    const exitPayload: JobExitPayload = {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: leaseEpoch,
      exit_code: 1,
      outcome: 'failed',
      failure_category: failureCategory,
      failure_message: failureMessage,
    };
    this.sendFrame(
      'job_exit',
      attemptId,
      leaseId,
      leaseEpoch,
      exitPayload as unknown as Record<string, unknown>,
    );

    const cleanupPayload: CleanupCompletePayload = {
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: leaseEpoch,
      exit_code: 1,
      timed_out: false,
      message: failureMessage,
    };
    this.sendFrame(
      'cleanup_complete',
      attemptId,
      leaseId,
      leaseEpoch,
      cleanupPayload as unknown as Record<string, unknown>,
    );
  }

  public handleLeaseOffer(offer: LeaseOfferPayload): void {
    if (this.isBusy()) {
      this.sendFrame('lease_reject', offer.attempt_id, offer.lease_id, offer.lease_epoch, {
        attempt_id: offer.attempt_id,
        lease_id: offer.lease_id,
        lease_epoch: offer.lease_epoch,
        reason: 'Agent capacity limit reached (1 active job max)',
      });
      return;
    }

    this.activeAttemptId = offer.attempt_id;
    this.currentOffer = offer;

    this.sendFrame('lease_accept', offer.attempt_id, offer.lease_id, offer.lease_epoch, {
      attempt_id: offer.attempt_id,
      lease_id: offer.lease_id,
      lease_epoch: offer.lease_epoch,
    });
  }

  public async handlePrepareSource(prepare: PrepareSourcePayload): Promise<void> {
    if (!this.matchesReservedLease(prepare.attempt_id, prepare.lease_id, prepare.lease_epoch)) {
      return;
    }
    this.currentPrepare = prepare;

    const attemptDir = join(this.config.stateDir, 'workspaces', prepare.attempt_id);
    const archivePartPath = join(attemptDir, 'snapshot.tar.zst.part');
    const archivePath = join(attemptDir, 'snapshot.tar.zst');
    const workspaceRoot = join(attemptDir, 'workspace');

    await mkdir(attemptDir, { recursive: true });

    try {
      if (prepare.expected_size_bytes <= 0 || !prepare.expected_sha256) {
        throw new Error('prepare_source missing expected size or sha256');
      }
      if (this.cancelSignal.cancelled) {
        throw new Error('cancelled');
      }

      await this.downloadSnapshotFile(
        prepare.download_url,
        prepare.data_token,
        archivePartPath,
        prepare.expected_size_bytes,
        prepare.expected_sha256,
      );

      if (this.cancelSignal.cancelled) {
        throw new Error('cancelled');
      }

      await rename(archivePartPath, archivePath);

      const materialized = await materializeFullSnapshot({
        manifest: prepare.manifest,
        archivePath,
        workspaceRoot,
      });
      this.materializedProjectPath = materialized.projectPath;

      if (this.cancelSignal.cancelled) {
        this.sendCancelledTerminal(
          prepare.attempt_id,
          prepare.lease_id,
          prepare.lease_epoch,
          'Job cancelled during prepare_source',
        );
        await rm(attemptDir, { recursive: true, force: true }).catch(() => undefined);
        this.clearAttempt();
        return;
      }

      this.sendFrame('source_ready', prepare.attempt_id, prepare.lease_id, prepare.lease_epoch, {
        attempt_id: prepare.attempt_id,
        lease_id: prepare.lease_id,
        lease_epoch: prepare.lease_epoch,
      });
    } catch (error) {
      logger.error('prepare_source failed', {
        attemptId: prepare.attempt_id,
        error: String(error),
      });
      if (this.cancelSignal.cancelled || String(error).includes('cancelled')) {
        this.sendCancelledTerminal(
          prepare.attempt_id,
          prepare.lease_id,
          prepare.lease_epoch,
          'Job cancelled during prepare_source',
        );
      } else {
        this.failTerminal(
          prepare.attempt_id,
          prepare.lease_id,
          prepare.lease_epoch,
          'materialization',
          String(error),
        );
      }
      await rm(attemptDir, { recursive: true, force: true }).catch(() => undefined);
      this.clearAttempt();
    }
  }

  public async handleRunJob(run: RunJobPayload): Promise<void> {
    if (
      !this.matchesReservedLease(run.attempt_id, run.lease_id, run.lease_epoch) ||
      !this.currentOffer ||
      !this.currentPrepare
    ) {
      return;
    }

    const offer = this.currentOffer;
    const request = offer.job_request;
    const attemptDir = join(this.config.stateDir, 'workspaces', run.attempt_id);
    const workspaceRoot = join(attemptDir, 'workspace');
    const controlDir = join(attemptDir, 'control');
    const artifactsDir = join(attemptDir, 'artifacts');
    const logsDir = join(attemptDir, 'logs');

    await mkdir(controlDir, { recursive: true });
    await mkdir(artifactsDir, { recursive: true });

    const logs = await ensureAttemptLogs(logsDir);

    // Toolchain recheck before spawn: path + environment_fingerprint vs current caps
    const currentProfiles = this.config.toolchainProfiles ?? [];
    for (const profile of offer.selected_toolchain_profiles ?? []) {
      const activationPath = profile.activation.path;
      if (activationPath && !existsSync(activationPath)) {
        this.failTerminal(
          run.attempt_id,
          run.lease_id,
          run.lease_epoch,
          'toolchain_changed',
          `Selected toolchain path missing: ${activationPath}`,
        );
        await rm(attemptDir, { recursive: true, force: true }).catch(() => undefined);
        this.clearAttempt();
        return;
      }
      const current = currentProfiles.find((p) => p.id === profile.id);
      if (
        !current ||
        current.environment_fingerprint !== profile.environment_fingerprint ||
        current.version !== profile.version ||
        (activationPath && current.activation.path && current.activation.path !== activationPath)
      ) {
        this.failTerminal(
          run.attempt_id,
          run.lease_id,
          run.lease_epoch,
          'toolchain_changed',
          `Selected toolchain fingerprint mismatch for profile '${profile.id}'`,
        );
        await rm(attemptDir, { recursive: true, force: true }).catch(() => undefined);
        this.clearAttempt();
        return;
      }
    }

    if (this.cancelSignal.cancelled) {
      this.sendCancelledTerminal(
        run.attempt_id,
        run.lease_id,
        run.lease_epoch,
        'Job cancelled before spawn',
      );
      await rm(attemptDir, { recursive: true, force: true }).catch(() => undefined);
      this.clearAttempt();
      return;
    }

    // Resolve secrets: execution.secret_refs is { ENV_NAME: store_ref }
    const secretMap = this.config.secretMap ?? {};
    const secretEnv: Record<string, string> = {};
    const secretValuesToRedact: string[] = [];

    for (const [envName, storeRef] of Object.entries(request.execution.secret_refs ?? {})) {
      const sourceEnvVar = secretMap[storeRef] ?? storeRef;
      const val = process.env[sourceEnvVar];
      if (!val) {
        this.failTerminal(
          run.attempt_id,
          run.lease_id,
          run.lease_epoch,
          'secret_missing',
          `Missing required secret ref '${storeRef}'`,
        );
        await rm(attemptDir, { recursive: true, force: true }).catch(() => undefined);
        this.clearAttempt();
        return;
      }
      secretEnv[envName] = val;
      secretValuesToRedact.push(val);
    }

    const stdoutRedactor = new StreamRedactor(secretValuesToRedact);
    const stderrRedactor = new StreamRedactor(secretValuesToRedact);

    try {
      await writeJobScript(controlDir, request.execution);

      const projectPath = this.materializedProjectPath ?? join(workspaceRoot, 'main_mount');
      const projectCwd = await resolveContainedCwd(projectPath, request.source.cwd);

      let sequence = 0;
      const child = spawnJobScript({
        attemptId: run.attempt_id,
        controlDir,
        workspacePath: workspaceRoot,
        projectPath: projectCwd,
        execution: request.execution,
        env: {
          ...request.execution.env,
          ...secretEnv,
          RBO_JOB_ID: offer.job_id,
          RBO_ATTEMPT_ID: run.attempt_id,
          RBO_ARTIFACTS_DIR: artifactsDir,
        },
        logs,
        attachLogs: false,
      });

      this.sendFrame('job_started', run.attempt_id, run.lease_id, run.lease_epoch, {
        attempt_id: run.attempt_id,
        lease_id: run.lease_id,
        lease_epoch: run.lease_epoch,
        ...(child.pid && child.pid > 0 ? { pid: child.pid } : {}),
      });

      this.activeProcessKill = (grace) => child.kill(grace ?? 10);
      // Keep the same cancelSignal object through waitForCompletion so a cancel
      // that fired during spawn is not wiped.

      child.stdout.on('data', (rawChunk: Buffer) => {
        const redacted = stdoutRedactor.redact(rawChunk.toString('utf8'));
        if (redacted) {
          sequence += 1;
          void appendLogChunk(logs, 'stdout', redacted);
          this.sendFrame('log_chunk', run.attempt_id, run.lease_id, run.lease_epoch, {
            attempt_id: run.attempt_id,
            lease_id: run.lease_id,
            lease_epoch: run.lease_epoch,
            stream: 'stdout',
            sequence,
            bytes: redacted,
          });
        }
      });

      child.stderr.on('data', (rawChunk: Buffer) => {
        const redacted = stderrRedactor.redact(rawChunk.toString('utf8'));
        if (redacted) {
          sequence += 1;
          void appendLogChunk(logs, 'stderr', redacted);
          this.sendFrame('log_chunk', run.attempt_id, run.lease_id, run.lease_epoch, {
            attempt_id: run.attempt_id,
            lease_id: run.lease_id,
            lease_epoch: run.lease_epoch,
            stream: 'stderr',
            sequence,
            bytes: redacted,
          });
        }
      });

      const result = await waitForCompletion({
        child,
        execution: request.execution,
        logs,
        signal: this.cancelSignal,
      });

      for (const [stream, redactor] of [
        ['stdout', stdoutRedactor],
        ['stderr', stderrRedactor],
      ] as const) {
        const flushed = redactor.flush();
        if (flushed) {
          sequence += 1;
          void appendLogChunk(logs, stream, flushed);
          this.sendFrame('log_chunk', run.attempt_id, run.lease_id, run.lease_epoch, {
            attempt_id: run.attempt_id,
            lease_id: run.lease_id,
            lease_epoch: run.lease_epoch,
            stream,
            sequence,
            bytes: flushed,
          });
        }
      }

      let timedOut = false;
      let logFailure = false;
      let durationComplete = false;

      if (result.type === 'timeout') {
        timedOut = true;
        await child.kill(request.execution.cancel_grace_seconds);
      } else if (result.type === 'duration_complete') {
        durationComplete = true;
        await child.kill(request.execution.cancel_grace_seconds);
      } else if (result.type === 'log_success') {
        await child.kill(request.execution.cancel_grace_seconds);
      } else if (result.type === 'log_failure') {
        logFailure = true;
        await child.kill(request.execution.cancel_grace_seconds);
      }

      const exitCode = result.type === 'exit' ? result.exitCode : null;
      const outcome = this.cancelSignal.cancelled
        ? 'cancelled'
        : timedOut
          ? 'timed_out'
          : logFailure
            ? 'failed'
            : durationComplete || result.type === 'log_success'
              ? 'succeeded'
              : exitCode === 0
                ? 'succeeded'
                : 'failed';

      this.sendFrame('job_exit', run.attempt_id, run.lease_id, run.lease_epoch, {
        attempt_id: run.attempt_id,
        lease_id: run.lease_id,
        lease_epoch: run.lease_epoch,
        exit_code: exitCode,
        outcome,
        ...(outcome === 'failed'
          ? {
              failure_category: 'process_exit' as const,
              failure_message: logFailure
                ? 'Completion failure_pattern matched in logs'
                : `Script exited with code ${exitCode}`,
            }
          : outcome === 'timed_out'
            ? {
                failure_category: 'timeout' as const,
                failure_message: 'Execution timed out',
              }
            : {}),
      });

      const collection = await collectArtifactFiles({
        projectPath,
        rules: request.artifacts ?? [],
        tempDir: join(artifactsDir, '.collect-tmp'),
      });

      const artifactItems = collection.files.map((f) => ({
        logical_name: f.logical_name,
        path: f.sourcePath,
        size_bytes: f.size_bytes,
        sha256: f.sha256,
      }));

      const uploadGrant = await this.requestArtifactUploadTokens(
        run.attempt_id,
        run.lease_id,
        run.lease_epoch,
        artifactItems,
      );

      for (const art of uploadGrant.artifacts) {
        try {
          await this.uploadArtifactFile(
            art.upload_url,
            art.upload_token,
            art.path,
            art.logical_name,
            art.size_bytes,
            art.sha256,
          );
        } catch (error) {
          logger.error('failed artifact upload', {
            artifact: art.logical_name,
            error: String(error),
          });
        }
      }

      const cleanup = await runCleanupScript({
        attemptId: run.attempt_id,
        controlDir,
        workspacePath: workspaceRoot,
        projectPath: projectCwd,
        execution: request.execution,
        env: {
          RBO_JOB_ID: offer.job_id,
          RBO_ATTEMPT_ID: run.attempt_id,
          RBO_ARTIFACTS_DIR: artifactsDir,
        },
        logs,
      }).catch(() => ({ exitCode: null, timedOut: false }));

      this.sendFrame('cleanup_complete', run.attempt_id, run.lease_id, run.lease_epoch, {
        attempt_id: run.attempt_id,
        lease_id: run.lease_id,
        lease_epoch: run.lease_epoch,
        exit_code: cleanup.exitCode,
        timed_out: cleanup.timedOut,
      });
    } catch (error) {
      logger.error('run_job failed', { attemptId: run.attempt_id, error: String(error) });
      this.failTerminal(run.attempt_id, run.lease_id, run.lease_epoch, 'internal', String(error));
    } finally {
      await rm(attemptDir, { recursive: true, force: true }).catch(() => undefined);
      this.clearAttempt();
    }
  }

  public handleArtifactUploadGrant(grant: ArtifactUploadGrantPayload): void {
    if (this.pendingArtifactUpload && this.pendingArtifactUpload.attemptId === grant.attempt_id) {
      clearTimeout(this.pendingArtifactUpload.timer);
      const { resolve } = this.pendingArtifactUpload;
      this.pendingArtifactUpload = null;
      resolve(grant);
    }
  }

  public async handleCancelJob(cancel: CancelJobPayload): Promise<void> {
    if (!this.matchesReservedLease(cancel.attempt_id, cancel.lease_id, cancel.lease_epoch)) {
      return;
    }
    this.cancelSignal.cancelled = true;
    if (this.activeProcessKill) {
      await this.activeProcessKill(cancel.grace_seconds);
      return;
    }
    // In-flight prepare_source / pre-spawn run_job observe cancelSignal.
    if (this.currentPrepare) {
      return;
    }
    // Lease reserved but prepare not started yet — free the slot now.
    this.sendCancelledTerminal(
      cancel.attempt_id,
      cancel.lease_id,
      cancel.lease_epoch,
      cancel.reason ?? 'Job cancelled before process start',
    );
    const attemptDir = join(this.config.stateDir, 'workspaces', cancel.attempt_id);
    await rm(attemptDir, { recursive: true, force: true }).catch(() => undefined);
    this.clearAttempt();
  }

  private requestArtifactUploadTokens(
    attemptId: string,
    leaseId: string,
    leaseEpoch: number,
    artifacts: Array<{
      logical_name: string;
      path: string;
      size_bytes: number;
      sha256: string;
    }>,
  ): Promise<ArtifactUploadGrantPayload> {
    return new Promise((resolve, reject) => {
      if (this.pendingArtifactUpload) {
        reject(new Error('artifact upload already pending'));
        return;
      }
      const timer = setTimeout(() => {
        this.pendingArtifactUpload = null;
        reject(new Error('timed out waiting for artifact upload tokens'));
      }, ARTIFACT_TOKEN_TIMEOUT_MS);
      this.pendingArtifactUpload = { attemptId, resolve, reject, timer };
      const manifest: ArtifactManifestPayload = {
        attempt_id: attemptId,
        lease_id: leaseId,
        lease_epoch: leaseEpoch,
        artifacts,
      };
      this.sendFrame(
        'artifact_manifest',
        attemptId,
        leaseId,
        leaseEpoch,
        manifest as unknown as Record<string, unknown>,
      );
    });
  }

  private pinnedTlsOptions(): {
    rejectUnauthorized: false;
    checkServerIdentity: (_host: string, cert: { raw?: Buffer }) => Error | undefined;
  } {
    // Self-signed Controller certs are not in the system trust store. Disable
    // CA trust and pin the peer certificate fingerprint (same model as WS).
    const expected = this.config.controllerFingerprint;
    return {
      rejectUnauthorized: false,
      checkServerIdentity: (_host, cert) => {
        if (!cert.raw) {
          return new Error('Controller did not present a TLS certificate');
        }
        const actual = certificateFingerprint(cert.raw);
        if (actual !== expected) {
          return new Error(
            `Controller certificate fingerprint mismatch: expected ${expected}, got ${actual}`,
          );
        }
        return undefined;
      },
    };
  }

  private downloadSnapshotFile(
    downloadUrl: string,
    dataToken: string,
    destPath: string,
    expectedSize: number,
    expectedSha256: string,
  ): Promise<void> {
    return new Promise<void>((resolvePromise, rejectPromise) => {
      const req = httpsRequest(
        downloadUrl,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${dataToken}`,
          },
          ...this.pinnedTlsOptions(),
        },
        (res) => {
          const pinError = assertPinnedPeerCert(res, this.config.controllerFingerprint);
          if (pinError) {
            res.resume();
            rejectPromise(pinError);
            return;
          }
          if (res.statusCode !== 200) {
            rejectPromise(new Error(`Snapshot download failed with HTTP ${res.statusCode}`));
            return;
          }

          const hasher = createHash('sha256');
          const writeStream = createWriteStream(destPath);
          let sizeCounter = 0;

          res.on('data', (chunk: Buffer) => {
            sizeCounter += chunk.length;
            hasher.update(chunk);
          });

          writeStream.on('finish', () => {
            const sha256 = hasher.digest('hex');
            if (sizeCounter !== expectedSize) {
              void rm(destPath, { force: true });
              rejectPromise(
                new Error(`Downloaded size ${sizeCounter} mismatch with expected ${expectedSize}`),
              );
              return;
            }
            if (sha256 !== expectedSha256) {
              void rm(destPath, { force: true });
              rejectPromise(
                new Error(`Downloaded sha256 ${sha256} mismatch with expected ${expectedSha256}`),
              );
              return;
            }
            resolvePromise();
          });

          writeStream.on('error', rejectPromise);
          res.pipe(writeStream);
        },
      );

      req.on('error', rejectPromise);
      req.end();
    });
  }

  private uploadArtifactFile(
    uploadUrl: string,
    uploadToken: string,
    filePath: string,
    logicalName: string,
    _sizeBytes: number,
    sha256: string,
  ): Promise<void> {
    return new Promise<void>((resolvePromise, rejectPromise) => {
      void stat(filePath)
        .then((info) => {
          const req = httpsRequest(
            uploadUrl,
            {
              method: 'PUT',
              headers: {
                Authorization: `Bearer ${uploadToken}`,
                'Content-Length': info.size,
                'X-RBO-SHA256': sha256,
                'X-RBO-Artifact-Name': logicalName,
              },
              ...this.pinnedTlsOptions(),
            },
            (res) => {
              const pinError = assertPinnedPeerCert(res, this.config.controllerFingerprint);
              if (pinError) {
                res.resume();
                rejectPromise(pinError);
                return;
              }
              res.resume();
              if (res.statusCode === 200) {
                resolvePromise();
              } else {
                rejectPromise(new Error(`Artifact upload failed HTTP ${res.statusCode}`));
              }
            },
          );

          req.on('error', rejectPromise);
          createReadStream(filePath).pipe(req);
        })
        .catch(rejectPromise);
    });
  }
}
