import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
import {
  type GitUrlAllowlist,
  RboError,
  createLogger,
  formatUnknownError,
  resolveContainedCwd,
} from '@rbo/shared';
import {
  type GitSourceRequirements,
  type SnapshotCaptureLimits,
  captureFullSnapshot,
  captureGitOverlaySnapshot,
  gitFindRoot,
  gitListRemoteFetchUrls,
  gitRevParseHead,
  materializeFullSnapshot,
  resolveAllowlistedRemoteUrl,
  resolveSourceCwdForCapture,
} from '@rbo/snapshot';

function snapshotPayloadMode(manifest: unknown): 'full' | 'git_overlay' {
  if (
    manifest &&
    typeof manifest === 'object' &&
    'payload' in manifest &&
    manifest.payload &&
    typeof manifest.payload === 'object' &&
    'mode' in manifest.payload &&
    manifest.payload.mode === 'git_overlay'
  ) {
    return 'git_overlay';
  }
  return 'full';
}
import {
  createAttempt,
  createJobEvent,
  getJob,
  getLatestAttempt,
  isTerminalJobState,
  recordEvent,
  transitionAttemptState,
  transitionJobState,
} from '../jobs/lifecycle.js';
import { persistAndPublishLogChunk } from '../logs/stream.js';
import type { ControllerDatabase } from '../storage/database.js';
import { nowIso } from '../storage/database.js';
import { persistCollectedArtifacts } from './artifacts.js';

const logger = createLogger('controller.execution.runner');

export interface LocalRunnerContext {
  db: ControllerDatabase;
  dataDir: string;
  allowedProjectRoots: string[];
  allowedArtifactDestinations: string[];
  maxConcurrentJobs?: number;
  gitAllowlist?: GitUrlAllowlist;
  /** When true, prefer git_overlay capture for remote-eligible jobs. */
  remoteCapable?: boolean;
  /**
   * Opt in to uploading the whole working tree when git-overlay capture is not
   * possible (§10.4). Default false so a misconfigured allowlist fails loudly
   * instead of silently transferring the entire repository.
   */
  allowFullSnapshotFallback?: boolean;
  /** Controller metadata-admission limits for temporary snapshot capture (§4.3). */
  snapshotCaptureLimits?: SnapshotCaptureLimits;
}

const activeCancels = new Map<string, () => Promise<void>>();
/** Jobs cancelled before an attempt cancel-handle exists (queued / materializing). */
const pendingCancels = new Set<string>();

/** In-process admission semaphore — closes the COUNT→async-setup race. */
let admissionActive = 0;
const admissionWaiters: Array<() => void> = [];

/** Currently-running local-fallback jobs on this Controller's own host (host-aware fallback). */
export function getLocalRunningJobsCount(): number {
  return admissionActive;
}

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

export function attemptTransferDir(dataDir: string, attemptId: string): string {
  return join(dataDir, 'transfers', attemptId);
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
    // Local runner only unpacks full archives. git_overlay needs a base worktree
    // (remote Agent prepare path). Fail closed with RboError — do not let ZodError
    // escape to console.error (Node 24.11+ util.inspect crash).
    if (snapshotPayloadMode(manifest) === 'git_overlay') {
      throw new RboError(
        'materialization',
        'Local fallback cannot materialize git_overlay snapshots; a remote agent is required',
        true,
      );
    }
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

    const generationSuffix = snapshotRow.manifest_path.match(/\.g\d+$/)?.[0] ?? '';
    const warningsPath = join(
      dirname(snapshotRow.manifest_path),
      `secret-warnings.json${generationSuffix}`,
    );
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
      RBO_ARTIFACT_DIR: artifactsDir,
    };
    let nextLogSequence = 1;
    let logWriteChain: Promise<void> = Promise.resolve();
    const enqueueLocalLog = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
      const sequence = nextLogSequence;
      nextLogSequence += 1;
      logWriteChain = logWriteChain
        .catch(() => undefined)
        .then(() =>
          persistAndPublishLogChunk({
            dataDir: ctx.dataDir,
            attemptId: attempt.id,
            stream,
            chunk,
            sequence,
          }).then(() => undefined),
        );
    };
    const child = spawnJobScript({
      attemptId: attempt.id,
      controlDir,
      workspacePath: materialized.workspaceRoot,
      projectPath: projectCwd,
      execution: request.execution,
      env: injectedEnv,
      logs,
      attachLogs: false,
      onLogChunk: enqueueLocalLog,
    });
    for (const key of child.ignoredRboEnvKeys ?? []) {
      await emitJobEvent(ctx, logs, {
        type: 'env_override_ignored',
        job_id: jobId,
        attempt_id: attempt.id,
        name: key,
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

    // Drain durable log writes before artifact collection / terminal state.
    await logWriteChain.catch(() => undefined);

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
      // Re-throw as RboError so outer dispatch catch never sees exotic ZodError
      // objects that can crash Node 24.11+ console.error / util.inspect.
      throw error instanceof RboError ? error : new RboError('internal', message, false);
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
          RBO_ARTIFACT_DIR: artifactsDir,
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

/**
 * Capture-only boundary for S-03 publication. The historical function name is
 * retained until the submission integration is migrated; this function never
 * persists a snapshot or mutates a job.
 */
export async function captureAndPersistSnapshot(
  ctx: LocalRunnerContext,
  jobId: string,
  request: JobRequest,
  fencingGeneration: number,
): Promise<{
  snapshotId: string;
  contentId: string;
  secretWarnings: Array<{ path: string; pattern: string }>;
  gitSourceRequirements: GitSourceRequirements;
  /** Job request with nested `project_root` mapped onto an effective `source.cwd`. */
  request: JobRequest;
  manifestPath: string;
  archivePath: string;
  sizeBytes: number;
  sha256: string;
  repoId: string;
  baseCommit: string | null;
  /** Remove the private archive candidate when the publication owner aborts. */
  cleanupCandidate: () => Promise<void>;
  /** Private metadata candidates correlated with archivePath for S-03 publication. */
  secretWarningsPath: string;
  gitSourceRequirementsPath: string;
}> {
  const storageDir = join(ctx.dataDir, 'snapshots', jobId);
  const sourcePolicy = {
    include_untracked: request.source_policy?.include_untracked ?? true,
    include_ignored: request.source_policy?.include_ignored ?? [],
    secret_policy: request.source_policy?.secret_policy ?? 'block',
  } as const;

  const resolvedCwd = await resolveSourceCwdForCapture(
    request.source.project_root,
    request.source.cwd,
  );
  const normalizedRequest: JobRequest =
    resolvedCwd === request.source.cwd
      ? request
      : {
          ...request,
          source: {
            ...request.source,
            cwd: resolvedCwd,
          },
        };

  const useOverlay = await resolveUseGitOverlay(ctx, normalizedRequest.source.project_root);

  const overlayRemoteUrl =
    useOverlay && ctx.gitAllowlist
      ? await resolveAllowlistedRemoteUrl(
          await gitFindRoot(normalizedRequest.source.project_root),
          ctx.gitAllowlist,
        )
      : null;

  const captured = useOverlay
    ? await captureGitOverlaySnapshot({
        projectRoot: normalizedRequest.source.project_root,
        allowedProjectRoots: ctx.allowedProjectRoots,
        cwd: normalizedRequest.source.cwd,
        sourcePolicy,
        additionalRoots: normalizedRequest.source.additional_roots,
        contentStorageDir: storageDir,
        fencingGeneration,
        limits: ctx.snapshotCaptureLimits,
        ...(overlayRemoteUrl ? { repoUrl: overlayRemoteUrl } : {}),
      })
    : await captureFullSnapshot({
        projectRoot: normalizedRequest.source.project_root,
        allowedProjectRoots: ctx.allowedProjectRoots,
        cwd: normalizedRequest.source.cwd,
        sourcePolicy,
        additionalRoots: normalizedRequest.source.additional_roots,
        contentStorageDir: storageDir,
        fencingGeneration,
        limits: ctx.snapshotCaptureLimits,
      });

  const candidateMatch = captured.archivePath.match(
    new RegExp(`\\.g${fencingGeneration}\\.candidate-([^\\\\/]+)$`),
  );
  if (!candidateMatch) {
    await rm(storageDir, { recursive: true, force: true }).catch(() => undefined);
    throw new RboError('internal', 'Snapshot capture did not return a private archive candidate');
  }
  const candidateSuffix = `.g${fencingGeneration}.candidate-${candidateMatch[1]}`;
  const manifestPath = join(storageDir, `manifest.json${candidateSuffix}`);
  const secretWarningsPath = join(storageDir, `secret-warnings.json${candidateSuffix}`);
  const gitSourceRequirementsPath = join(
    storageDir,
    `git-source-requirements.json${candidateSuffix}`,
  );
  try {
    await writeFile(manifestPath, JSON.stringify(captured.manifest, null, 2));
    await writeFile(secretWarningsPath, JSON.stringify(captured.secretWarnings));
    await writeFile(gitSourceRequirementsPath, JSON.stringify(captured.gitSourceRequirements));
  } catch (error) {
    // The snapshot package owns cleanup while capture is running. Once it has
    // returned, this runner owns the private candidate until S-03 publishes it.
    await rm(storageDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  return {
    snapshotId: captured.instance.snapshot_id,
    contentId: captured.manifest.content_id,
    secretWarnings: captured.secretWarnings,
    gitSourceRequirements: captured.gitSourceRequirements,
    request: normalizedRequest,
    manifestPath,
    archivePath: captured.archivePath,
    sizeBytes: captured.manifest.payload.size,
    sha256: captured.manifest.payload.sha256,
    repoId: captured.manifest.repo?.canonical_id ?? 'local',
    baseCommit: captured.manifest.repo?.base_commit ?? null,
    cleanupCandidate: async () => {
      await Promise.all(
        [captured.archivePath, manifestPath, secretWarningsPath, gitSourceRequirementsPath].map(
          (path) => rm(path, { force: true }),
        ),
      );
    },
    secretWarningsPath,
    gitSourceRequirementsPath,
  };
}

export function mergeGitSourceToolRequirements(
  request: JobRequest,
  gitSourceRequirements: GitSourceRequirements,
): JobRequest {
  const tools = { ...(request.requirements?.tools ?? {}) };
  if (gitSourceRequirements.submodules) {
    tools.git = tools.git ?? '>=0';
  }
  if (gitSourceRequirements.lfs) {
    tools['git-lfs'] = tools['git-lfs'] ?? '>=0';
  }
  if (Object.keys(tools).length === 0) {
    return request;
  }
  return {
    ...request,
    requirements: {
      ...request.requirements,
      tools,
    },
  };
}

export async function readGitSourceRequirements(
  dataDir: string,
  jobId: string,
): Promise<GitSourceRequirements> {
  try {
    const snapshotDir = join(dataDir, 'snapshots', jobId);
    let sidecar = 'git-source-requirements.json';
    const generated = (await readdir(snapshotDir))
      .filter((name) => /^git-source-requirements\.json\.g\d+$/.test(name))
      .sort((a, b) => Number(a.match(/\.g(\d+)$/)?.[1]) - Number(b.match(/\.g(\d+)$/)?.[1]));
    if (generated.length > 0) {
      sidecar = generated[generated.length - 1] as string;
    }
    const raw = await readFile(join(snapshotDir, sidecar), 'utf8');
    const parsed = JSON.parse(raw) as Partial<GitSourceRequirements>;
    return {
      submodules: parsed.submodules === true,
      lfs: parsed.lfs === true,
    };
  } catch {
    return { submodules: false, lfs: false };
  }
}

/**
 * Why a job could not use git-overlay capture, in operator-actionable terms.
 *
 * Overlay sends only the dirty diff and lets the Agent materialize the rest from
 * the remote, so losing it silently means uploading the entire working tree
 * instead — on a repo with large tracked binaries that is the difference between
 * a few KB and hundreds of MB. Every reason below therefore has to reach the
 * operator (see resolveUseGitOverlay), never get swallowed.
 */
export type OverlayIneligibility =
  | { reason: 'no_connected_agent' }
  | { reason: 'no_git_allowlist' }
  | { reason: 'not_a_git_repo'; detail: string }
  | { reason: 'no_head_commit' }
  | { reason: 'remote_not_allowlisted'; remotes: string[]; allowedHosts: readonly string[] };

export function describeOverlayIneligibility(cause: OverlayIneligibility): string {
  switch (cause.reason) {
    case 'no_connected_agent':
      return 'no Agent is connected, so there is nothing to materialize the repository remotely';
    case 'no_git_allowlist':
      return 'the Controller has no git_allowlist configured';
    case 'not_a_git_repo':
      return `the project root is not inside a git repository (${cause.detail})`;
    case 'no_head_commit':
      return 'the repository has no HEAD commit yet';
    case 'remote_not_allowlisted':
      return cause.remotes.length === 0
        ? 'the repository has no fetch remote configured'
        : `no fetch remote is allowed by git_allowlist. Remotes: ${cause.remotes.join(', ')}; allowed hosts: ${cause.allowedHosts.join(', ') || '(none)'}. Note an SSH host alias from ~/.ssh/config (e.g. "git@github-myorg:org/repo.git") is a DIFFERENT host than github.com and must be listed explicitly`;
  }
}

/**
 * Decide overlay vs full-snapshot capture, and never fall back silently.
 *
 * Full-snapshot fallback is opt-in (`allow_full_snapshot_fallback`, default
 * false): a misconfigured allowlist used to degrade quietly into uploading the
 * whole working tree, which looks like a hang rather than a config error.
 */
async function resolveUseGitOverlay(
  ctx: LocalRunnerContext,
  projectRoot: string,
): Promise<boolean> {
  let cause: OverlayIneligibility | null;
  if (ctx.remoteCapable !== true) {
    cause = { reason: 'no_connected_agent' };
  } else if (!ctx.gitAllowlist) {
    cause = { reason: 'no_git_allowlist' };
  } else {
    cause = await assessGitOverlayEligibility(projectRoot, ctx.gitAllowlist);
  }
  if (!cause) {
    return true;
  }

  const explanation = describeOverlayIneligibility(cause);
  if (ctx.allowFullSnapshotFallback === true) {
    logger.warn('git overlay capture unavailable; falling back to full snapshot', {
      projectRoot,
      reason: cause.reason,
      explanation,
      hint: 'A full snapshot uploads the entire working tree. Fix the cause above to use overlay capture instead.',
    });
    return false;
  }
  throw RboError.validation(
    `Cannot capture this job with git overlay: ${explanation}. A full-snapshot fallback would upload the entire working tree, so it is disabled by default — fix the cause, or set "allow_full_snapshot_fallback": true in controller.json (or RBO_ALLOW_FULL_SNAPSHOT_FALLBACK=true) to opt in.`,
    { reason: cause.reason, project_root: projectRoot },
  );
}

async function assessGitOverlayEligibility(
  projectRoot: string,
  allowlist: GitUrlAllowlist,
): Promise<OverlayIneligibility | null> {
  let repoRoot: string;
  try {
    repoRoot = await gitFindRoot(projectRoot);
  } catch (error) {
    return { reason: 'not_a_git_repo', detail: formatUnknownError(error) };
  }
  const [remoteUrl, head] = await Promise.all([
    resolveAllowlistedRemoteUrl(repoRoot, allowlist).catch(() => null),
    gitRevParseHead(repoRoot).catch(() => null),
  ]);
  if (!head) {
    return { reason: 'no_head_commit' };
  }
  if (!remoteUrl) {
    const remotes = await gitListRemoteFetchUrls(repoRoot)
      .then((list) => list.map((r) => r.url))
      .catch(() => []);
    return { reason: 'remote_not_allowlisted', remotes, allowedHosts: allowlist.hosts };
  }
  return null;
}
