import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  appendEvent,
  collectArtifactFiles,
  ensureAttemptLogs,
  readLogTail,
  runCleanupScript,
  spawnJobScript,
  waitForCompletion,
  writeJobScript,
} from '@rbo/executor';
import type { JobEvent, JobRequest } from '@rbo/protocol';
import { RboError, resolveContainedCwd } from '@rbo/shared';
import { captureFullSnapshot, materializeFullSnapshot } from '@rbo/snapshot';
import {
  createAttempt,
  createJobEvent,
  getJob,
  getLatestAttempt,
  isTerminalJobState,
  persistSnapshot,
  recordEvent,
  transitionAttemptState,
  transitionJobState,
} from '../jobs/lifecycle.js';
import type { ControllerDatabase } from '../storage/database.js';
import { nowIso } from '../storage/database.js';
import { persistCollectedArtifacts } from './artifacts.js';

export interface LocalRunnerContext {
  db: ControllerDatabase;
  dataDir: string;
  allowedProjectRoots: string[];
  allowedArtifactDestinations: string[];
  maxConcurrentJobs?: number;
}

const activeCancels = new Map<string, () => Promise<void>>();
/** Jobs cancelled before an attempt cancel-handle exists (queued / materializing). */
const pendingCancels = new Set<string>();

/** In-process admission semaphore — closes the COUNT→async-setup race. */
let admissionActive = 0;
const admissionWaiters: Array<() => void> = [];

async function acquireAdmission(maxConcurrentJobs: number): Promise<() => void> {
  while (admissionActive >= maxConcurrentJobs) {
    await new Promise<void>((resolvePromise) => {
      admissionWaiters.push(resolvePromise);
    });
  }
  admissionActive += 1;
  return () => {
    admissionActive = Math.max(0, admissionActive - 1);
    const next = admissionWaiters.shift();
    if (next) {
      next();
    }
  };
}

async function emitJobEvent(
  ctx: LocalRunnerContext,
  logs: Awaited<ReturnType<typeof ensureAttemptLogs>>,
  partial: { type: JobEvent['type']; job_id: string; attempt_id: string } & Record<string, unknown>,
): Promise<void> {
  const event = createJobEvent(ctx.db, partial);
  recordEvent(ctx.db, event);
  await appendEvent(logs, event);
}

function isCancelRequested(jobId: string): boolean {
  return pendingCancels.has(jobId);
}

export function requestJobCancel(db: ControllerDatabase, jobId: string): boolean {
  const job = getJob(db, jobId);
  if (!job || isTerminalJobState(job.state)) {
    return false;
  }

  const attempt = getLatestAttempt(db, jobId);
  if (attempt) {
    const cancel = activeCancels.get(attempt.id);
    if (cancel) {
      pendingCancels.add(jobId);
      void cancel();
      return true;
    }
  }

  // Queued / pre-process cancel: mark terminal so fire-and-track will not execute.
  pendingCancels.add(jobId);
  if (attempt) {
    transitionAttemptState(db, attempt.id, 'completed', {
      outcome: 'cancelled',
      finished_at: nowIso(),
    });
  }
  transitionJobState(db, jobId, 'completed', {
    outcome: 'cancelled',
    finished_at: nowIso(),
    failure_category: 'cancelled',
    failure_message: 'Job cancelled before execution',
  });
  return true;
}

export function attemptBaseDir(dataDir: string, attemptId: string): string {
  return join(dataDir, 'attempts', attemptId);
}

export function attemptWorkspaceDir(dataDir: string, attemptId: string): string {
  return join(attemptBaseDir(dataDir, attemptId), 'workspace');
}

export function attemptLogDir(dataDir: string, attemptId: string): string {
  return join(attemptBaseDir(dataDir, attemptId), 'logs');
}

export function attemptArtifactsDir(dataDir: string, attemptId: string): string {
  return join(attemptBaseDir(dataDir, attemptId), 'artifacts');
}

export function attemptControlDir(dataDir: string, attemptId: string): string {
  return join(attemptBaseDir(dataDir, attemptId), 'control');
}

export { readLogTail };

export async function runLocalJob(ctx: LocalRunnerContext, jobId: string): Promise<void> {
  if (isCancelRequested(jobId)) {
    pendingCancels.delete(jobId);
    return;
  }

  const row = ctx.db.prepare('SELECT request_json FROM jobs WHERE id = ?').get(jobId) as
    | { request_json: string }
    | undefined;
  if (!row) {
    throw new Error(`Missing request for job ${jobId}`);
  }
  const request = JSON.parse(row.request_json) as JobRequest;
  const current = getJob(ctx.db, jobId);
  if (!current || isTerminalJobState(current.state) || current.outcome === 'cancelled') {
    pendingCancels.delete(jobId);
    return;
  }

  const maxConcurrent = ctx.maxConcurrentJobs ?? 1;
  const releaseAdmission = await acquireAdmission(maxConcurrent);

  // Re-check after waiting for a slot — cancel may have won the race.
  if (isCancelRequested(jobId)) {
    releaseAdmission();
    pendingCancels.delete(jobId);
    return;
  }
  const afterAdmit = getJob(ctx.db, jobId);
  if (!afterAdmit || isTerminalJobState(afterAdmit.state) || afterAdmit.outcome === 'cancelled') {
    releaseAdmission();
    pendingCancels.delete(jobId);
    return;
  }

  const attempt = createAttempt(ctx.db, jobId, 1);
  if (isCancelRequested(jobId)) {
    transitionAttemptState(ctx.db, attempt.id, 'completed', {
      outcome: 'cancelled',
      finished_at: nowIso(),
    });
    const latest = getJob(ctx.db, jobId);
    if (latest && !isTerminalJobState(latest.state)) {
      transitionJobState(ctx.db, jobId, 'completed', {
        outcome: 'cancelled',
        finished_at: nowIso(),
        failure_category: 'cancelled',
        failure_message: 'Job cancelled before execution',
      });
    }
    releaseAdmission();
    pendingCancels.delete(jobId);
    return;
  }
  const workspaceRoot = attemptWorkspaceDir(ctx.dataDir, attempt.id);
  const persistentLogs = attemptLogDir(ctx.dataDir, attempt.id);
  const controlDir = attemptControlDir(ctx.dataDir, attempt.id);
  const artifactsDir = attemptArtifactsDir(ctx.dataDir, attempt.id);
  await mkdir(artifactsDir, { recursive: true });
  await mkdir(persistentLogs, { recursive: true });
  await mkdir(controlDir, { recursive: true });

  let timedOut = false;
  let cancelled = false;
  let durationComplete = false;
  let logFailure = false;
  let materializedWorkspacePath = '';
  let materializedProjectPath = '';
  const cancelSignal = { cancelled: false };
  const logs = await ensureAttemptLogs(persistentLogs);

  try {
    if (isCancelRequested(jobId)) {
      cancelled = true;
      throw new RboError('cancelled', 'Job cancelled before materialization', false);
    }

    transitionJobState(ctx.db, jobId, 'matching');
    transitionJobState(ctx.db, jobId, 'leased', { started_at: nowIso() });
    transitionJobState(ctx.db, jobId, 'materializing');

    const snapshotRow = ctx.db
      .prepare(
        'SELECT id, manifest_path, payload_path FROM snapshots WHERE id = (SELECT snapshot_id FROM jobs WHERE id = ?)',
      )
      .get(jobId) as { id: string; manifest_path: string; payload_path: string } | undefined;
    if (!snapshotRow?.payload_path) {
      throw new RboError('internal', 'Job is missing snapshot payload');
    }
    const manifest = JSON.parse(await readFile(snapshotRow.manifest_path, 'utf8'));
    const materialized = await materializeFullSnapshot({
      manifest,
      archivePath: snapshotRow.payload_path,
      workspaceRoot,
    });
    materializedWorkspacePath = materialized.workspaceRoot;
    materializedProjectPath = materialized.projectPath;
    const contentId = (manifest as { content_id: string }).content_id;
    await emitJobEvent(ctx, logs, {
      type: 'snapshot_captured',
      job_id: jobId,
      attempt_id: attempt.id,
      snapshot_id: snapshotRow.id,
      content_id: contentId,
    });

    const warningsPath = join(dirname(snapshotRow.manifest_path), 'secret-warnings.json');
    try {
      const warnings = JSON.parse(await readFile(warningsPath, 'utf8')) as Array<{
        path: string;
        pattern: string;
      }>;
      for (const warning of warnings) {
        await emitJobEvent(ctx, logs, {
          type: 'secret_warning',
          job_id: jobId,
          attempt_id: attempt.id,
          path: warning.path,
          reason: `Matched secret denylist pattern '${warning.pattern}'`,
        });
      }
    } catch {
      // no warnings sidecar
    }

    await emitJobEvent(ctx, logs, {
      type: 'materialized',
      job_id: jobId,
      attempt_id: attempt.id,
      workspace: materialized.projectPath,
    });

    if (isCancelRequested(jobId)) {
      cancelled = true;
      throw new RboError('cancelled', 'Job cancelled after materialization', false);
    }

    await writeJobScript(controlDir, request.execution);

    transitionJobState(ctx.db, jobId, 'starting');

    let projectCwd: string;
    try {
      projectCwd = await resolveContainedCwd(materialized.projectPath, request.source.cwd);
    } catch (error) {
      throw new RboError(
        'validation',
        error instanceof Error ? error.message : 'Invalid source.cwd',
        false,
      );
    }

    const injectedEnv = {
      RBO_JOB_ID: jobId,
      RBO_ATTEMPT_ID: attempt.id,
      RBO_ARTIFACTS_DIR: artifactsDir,
    };
    const child = spawnJobScript({
      attemptId: attempt.id,
      controlDir,
      workspacePath: materialized.workspaceRoot,
      projectPath: projectCwd,
      execution: request.execution,
      env: injectedEnv,
      logs,
    });
    for (const key of child.ignoredRboEnvKeys) {
      await emitJobEvent(ctx, logs, {
        type: 'secret_warning',
        job_id: jobId,
        attempt_id: attempt.id,
        path: key,
        reason: 'Reserved RBO_ env key ignored; injected system value wins',
      });
    }
    await emitJobEvent(ctx, logs, {
      type: 'process_started',
      job_id: jobId,
      attempt_id: attempt.id,
      workspace: workspaceRoot,
      pid: child.pid,
    });

    activeCancels.set(attempt.id, async () => {
      cancelled = true;
      cancelSignal.cancelled = true;
      await child.kill(request.execution.cancel_grace_seconds);
    });

    transitionJobState(ctx.db, jobId, 'running');
    transitionAttemptState(ctx.db, attempt.id, 'running');

    if (isCancelRequested(jobId)) {
      cancelled = true;
      cancelSignal.cancelled = true;
      await child.kill(request.execution.cancel_grace_seconds);
    }

    const result = await waitForCompletion({
      child,
      execution: request.execution,
      logs,
      signal: cancelSignal,
    });

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

    transitionJobState(ctx.db, jobId, 'collecting_artifacts');
    const collection = await collectArtifactFiles({
      projectPath: materialized.projectPath,
      rules: request.artifacts ?? [],
      tempDir: join(artifactsDir, '.collect-tmp'),
    });
    for (const skip of collection.skipped) {
      await emitJobEvent(ctx, logs, {
        type: 'artifact_skipped',
        job_id: jobId,
        attempt_id: attempt.id,
        path: skip.path,
        reason: skip.reason,
      });
    }
    let artifacts: Array<{ id: string; logical_name: string; size_bytes: number; sha256: string }> =
      [];
    if (collection.limitExceeded) {
      await emitJobEvent(ctx, logs, {
        type: 'artifact_limit_exceeded',
        job_id: jobId,
        attempt_id: attempt.id,
        reason: collection.limitExceeded.reason,
        limit: collection.limitExceeded.limit,
        actual: collection.limitExceeded.actual,
      });
    } else {
      artifacts = await persistCollectedArtifacts({
        db: ctx.db,
        jobId,
        attemptId: attempt.id,
        artifactsDir,
        files: collection.files,
      });
      for (const artifact of artifacts) {
        await emitJobEvent(ctx, logs, {
          type: 'artifact_collected',
          job_id: jobId,
          attempt_id: attempt.id,
          artifact_id: artifact.id,
          path: artifact.logical_name,
          sha256: artifact.sha256,
        });
      }
    }
    await rm(join(artifactsDir, '.collect-tmp'), { recursive: true, force: true }).catch(
      () => undefined,
    );

    const exitCode = result.type === 'exit' ? result.exitCode : null;
    const outcome = cancelled
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
    transitionAttemptState(ctx.db, attempt.id, 'completed', {
      outcome,
      finished_at: nowIso(),
    });
    transitionJobState(ctx.db, jobId, 'cleaning');
    transitionJobState(ctx.db, jobId, 'completed', {
      outcome,
      finished_at: nowIso(),
      exit_code: exitCode,
      failure_category:
        outcome === 'failed'
          ? logFailure
            ? 'process_exit'
            : 'process_exit'
          : outcome === 'timed_out'
            ? 'timeout'
            : cancelled
              ? 'cancelled'
              : null,
      failure_message:
        outcome === 'failed'
          ? logFailure
            ? 'Completion failure_pattern matched in logs'
            : `Script exited with code ${exitCode}`
          : outcome === 'timed_out'
            ? 'Execution timed out'
            : cancelled
              ? 'Job cancelled'
              : null,
      result_json: JSON.stringify({ artifacts, exit_code: exitCode, outcome }),
    });
    await emitJobEvent(ctx, logs, {
      type: 'state_transition',
      job_id: jobId,
      attempt_id: attempt.id,
      from_state: 'running',
      to_state: 'completed',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const category =
      error instanceof RboError ? error.category : cancelled ? 'cancelled' : 'internal';
    const outcome = cancelled || category === 'cancelled' ? 'cancelled' : 'failed';
    transitionAttemptState(ctx.db, attempt.id, 'completed', {
      outcome,
      finished_at: nowIso(),
    });
    // Avoid double-writing if cancel already terminalized the job.
    const latest = getJob(ctx.db, jobId);
    if (latest && !isTerminalJobState(latest.state)) {
      transitionJobState(ctx.db, jobId, 'cleaning');
      transitionJobState(ctx.db, jobId, 'completed', {
        outcome,
        finished_at: nowIso(),
        failure_category: category === 'cancelled' ? 'cancelled' : category,
        failure_message: message,
      });
    }
    await emitJobEvent(ctx, logs, {
      type: 'error',
      job_id: jobId,
      attempt_id: attempt.id,
      category: category === 'cancelled' ? 'cancelled' : category,
      message,
    }).catch(() => undefined);
    if (!cancelled && category !== 'cancelled') {
      throw error;
    }
  } finally {
    activeCancels.delete(attempt.id);
    pendingCancels.delete(jobId);
    releaseAdmission();
    if (materializedProjectPath) {
      let projectCwd = materializedProjectPath;
      try {
        projectCwd = await resolveContainedCwd(materializedProjectPath, request.source.cwd);
      } catch {
        // fall back to project root for cleanup
      }
      const cleanup = await runCleanupScript({
        attemptId: attempt.id,
        controlDir,
        workspacePath: materializedWorkspacePath,
        projectPath: projectCwd,
        execution: request.execution,
        env: {
          RBO_JOB_ID: jobId,
          RBO_ATTEMPT_ID: attempt.id,
          RBO_ARTIFACTS_DIR: artifactsDir,
        },
        logs,
      }).catch(() => ({ exitCode: null, timedOut: false }));
      if (cleanup.exitCode !== 0 || cleanup.timedOut) {
        await emitJobEvent(ctx, logs, {
          type: 'cleanup_error',
          job_id: jobId,
          attempt_id: attempt.id,
          exit_code: cleanup.exitCode,
          timed_out: cleanup.timedOut,
          message: cleanup.timedOut
            ? 'Cleanup script timed out'
            : `Cleanup script exited with code ${cleanup.exitCode}`,
        }).catch(() => undefined);
      }
    }
    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(controlDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function captureAndPersistSnapshot(
  ctx: LocalRunnerContext,
  jobId: string,
  request: JobRequest,
): Promise<{
  snapshotId: string;
  contentId: string;
  secretWarnings: Array<{ path: string; pattern: string }>;
}> {
  const storageDir = join(ctx.dataDir, 'snapshots', jobId);
  const sourcePolicy = {
    include_untracked: request.source_policy?.include_untracked ?? true,
    include_ignored: request.source_policy?.include_ignored ?? [],
    secret_policy: request.source_policy?.secret_policy ?? 'block',
  } as const;

  const captured = await captureFullSnapshot({
    projectRoot: request.source.project_root,
    allowedProjectRoots: ctx.allowedProjectRoots,
    cwd: request.source.cwd,
    sourcePolicy,
    additionalRoots: request.source.additional_roots,
    contentStorageDir: storageDir,
  });

  const manifestPath = join(storageDir, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(captured.manifest, null, 2));
  await writeFile(
    join(storageDir, 'secret-warnings.json'),
    JSON.stringify(captured.secretWarnings),
  );

  persistSnapshot(ctx.db, {
    snapshotId: captured.instance.snapshot_id,
    contentId: captured.manifest.content_id,
    repoId: captured.manifest.repo?.canonical_id ?? 'local',
    baseCommit: captured.manifest.repo?.base_commit ?? null,
    dirty: true,
    manifestPath,
    payloadPath: captured.archivePath,
    sizeBytes: captured.manifest.payload.size,
    sha256: captured.manifest.payload.sha256,
  });

  const current = getJob(ctx.db, jobId);
  if (current) {
    transitionJobState(ctx.db, jobId, current.state, {
      snapshot_id: captured.instance.snapshot_id,
    });
  }

  return {
    snapshotId: captured.instance.snapshot_id,
    contentId: captured.manifest.content_id,
    secretWarnings: captured.secretWarnings,
  };
}
