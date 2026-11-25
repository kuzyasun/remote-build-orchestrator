import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { AgentJobExecutor } from '../src/executor/index.js';
import {
  type AttemptMetadata,
  readAttemptMetadata,
  writeAttemptMetadata,
} from '../src/recovery/attempt-metadata.js';
import { AgentRecoveryCoordinator } from '../src/recovery/coordinator.js';

const collectSpy = vi.fn(async () => ({ files: [] }));

vi.mock('@rbo/executor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@rbo/executor')>();
  return {
    ...actual,
    collectArtifactFiles: (...args: unknown[]) => collectSpy(...args),
    openAttemptSpool: vi.fn(async () => ({
      dir: '/dev/null',
      logs: {
        logDir: '/dev/null',
        stdoutPath: '/dev/null',
        stderrPath: '/dev/null',
        eventsPath: '/dev/null',
        chunksPath: '/dev/null',
      },
      chunksPath: '/dev/null',
      ackPath: '/dev/null',
      nextSequence: 1,
      streamOffsets: { stdout: 0, stderr: 0 },
    })),
    readAck: vi.fn(async () => 0),
    writeAck: vi.fn(async () => undefined),
    iterUnacked: vi.fn(async function* () {}),
  };
});

function mockSocket(): WebSocket & { sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];
  return {
    readyState: 1,
    OPEN: 1,
    sent,
    send(raw: string) {
      sent.push(JSON.parse(raw) as Record<string, unknown>);
    },
  } as unknown as WebSocket & { sent: Array<Record<string, unknown>> };
}

describe('Artifact upload resume (completed_awaiting_upload)', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'rbo-artifact-resume-'));
    collectSpy.mockClear();
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it.each([
    { expectedTransfer: 'stored', attempts: 2, reconnect: true },
    { expectedTransfer: 'failed', attempts: 3, reconnect: false },
  ])(
    'on adopt retires staged files after a $expectedTransfer transfer',
    async ({ expectedTransfer, attempts, reconnect }) => {
      const content = Buffer.from('artifact-bytes');
      const sha256 = createHash('sha256').update(content).digest('hex');
      const stagingPath = join(stateDir, 'artifacts', 'att_1', 'out.txt');
      await mkdir(join(stagingPath, '..'), { recursive: true });
      await writeFile(stagingPath, content);

      const meta: AttemptMetadata = {
        attempt_id: 'att_1',
        job_id: 'job_1',
        lease_id: 'lease_1',
        lease_epoch: 1,
        process_identity: 'pid:42',
        status: 'completed_awaiting_upload',
        workspace_path: join(stateDir, 'workspaces', 'att_1'),
        spool_dir: join(stateDir, 'logs', 'att_1'),
        risk_level: 'normal',
        updated_at: new Date().toISOString(),
        last_exit: { exit_code: 0, outcome: 'succeeded' },
        cleanup_result: { exit_code: 0, timed_out: false },
        artifact_manifest: [
          {
            logical_name: 'out.txt',
            path: stagingPath,
            size_bytes: content.length,
            sha256,
          },
        ],
        artifact_collection: {
          rules: [{ matched_count: 1, collected_count: 1, skipped_count: 0, skip_reasons: [] }],
        },
      };
      const socket = mockSocket();
      const executor = new AgentJobExecutor(reconnect ? mockSocket() : socket, {
        stateDir,
        controllerFingerprint: 'sha256:test',
        gitAllowlist: { schemes: ['https'], hosts: ['github.com'] },
        repoCache: { max_size_gb: 1, min_free_disk_gb: 1, retention_days: 1 },
      });
      if (reconnect) {
        executor.handleLeaseOffer({
          attempt_id: meta.attempt_id,
          lease_id: meta.lease_id,
          lease_epoch: meta.lease_epoch,
          job_id: meta.job_id,
          job_request: {
            client_request_id: 'req_1',
            source: { project_root: stateDir, cwd: '.' },
            execution: { script: 'echo artifact' },
          },
          snapshot_metadata: {
            snapshot_id: 'snp_1',
            content_id: 'cid',
            size_bytes: 1,
            sha256: 'unused',
          },
          lease_ttl_seconds: 300,
        });
        executor.attachSocket(socket);
      }
      writeAttemptMetadata(stateDir, meta);

      // Grant arrives after manifest — resolve upload without network
      const uploadSpy = vi
        .spyOn(
          executor as unknown as {
            uploadArtifactFile: (...a: unknown[]) => Promise<void>;
          },
          'uploadArtifactFile',
        )
        .mockImplementationOnce(async () => {
          await expect(access(stagingPath)).resolves.toBeUndefined();
          expect(socket.sent.some((f) => f.type === 'cleanup_complete')).toBe(false);
          throw new Error('Temporary upload failure');
        })
        .mockImplementation(async () => {
          await expect(access(stagingPath)).resolves.toBeUndefined();
          expect(socket.sent.some((f) => f.type === 'cleanup_complete')).toBe(false);
          if (expectedTransfer === 'failed') throw new Error('Repeated upload failure');
        });

      const recovery = new AgentRecoveryCoordinator({
        stateDir,
        hooks: {
          terminateAttempt: async () => undefined,
          resendJobExit: (m) => executor.resendJobExitIfCompleted(m),
          authorizeArtifactUpload: (id, session) => executor.authorizeArtifactUpload(id, session),
          resumeArtifactUpload: (m) => executor.resumeArtifactUpload(m),
        },
      });
      recovery.attachSocket(socket);
      (executor as unknown as { config: { recovery: AgentRecoveryCoordinator } }).config.recovery =
        recovery;

      // Simulate grant handler wired like connection client
      const origSend = socket.send.bind(socket);
      socket.send = (raw: string) => {
        origSend(raw);
        const frame = JSON.parse(raw) as { type: string; payload: Record<string, unknown> };
        if (frame.type === 'artifact_manifest') {
          queueMicrotask(() => {
            executor.handleArtifactUploadGrant({
              attempt_id: 'att_1',
              lease_id: 'lease_1',
              lease_epoch: 1,
              artifacts: [
                {
                  logical_name: 'out.txt',
                  path: stagingPath,
                  size_bytes: content.length,
                  sha256,
                  upload_url: 'https://example.invalid/upload',
                  upload_token: 'tok',
                },
              ],
            });
          });
        }
      };

      const decision = {
        attempt_id: 'att_1',
        lease_id: 'lease_1',
        lease_epoch: 1,
        action: 'adopt' as const,
        resume_from_sequence: 0,
      };
      const pendingProcessExits = vi.fn();
      await recovery.reportAll(pendingProcessExits);
      expect(pendingProcessExits).toHaveBeenCalledWith([meta.attempt_id]);
      expect(socket.sent[0]).toMatchObject({
        type: 'recovery_report',
        payload: {
          status: 'completed_awaiting_upload',
          artifact_upload_pending: true,
          process_exit: meta.last_exit,
        },
      });
      if (reconnect) {
        await executor.resumeArtifactUpload(meta);
        expect(socket.sent.map((frame) => frame.type)).toEqual(['recovery_report']);
        const live = (
          executor as unknown as {
            attempts: Map<string, { runInProgress: boolean }>;
          }
        ).attempts.get(meta.attempt_id);
        if (!live) throw new Error('Missing live attempt fixture');
        live.runInProgress = true;
        writeAttemptMetadata(stateDir, {
          ...meta,
          artifact_manifest: undefined,
          artifact_collection: undefined,
          cleanup_result: undefined,
        });
        await recovery.handleReconcileDecision(decision);
        expect(socket.sent.map((frame) => frame.type)).toEqual(['recovery_report', 'job_exit']);
        writeAttemptMetadata(stateDir, meta);
        live.runInProgress = false;
        await executor.resumeArtifactUpload(meta);
      } else {
        await recovery.handleReconcileDecision(decision);
      }
      expect(socket.sent.map((frame) => frame.type).slice(0, 3)).toEqual([
        'recovery_report',
        'job_exit',
        'artifact_manifest',
      ]);

      expect(collectSpy).not.toHaveBeenCalled();
      const manifestFrame = socket.sent.find((f) => f.type === 'artifact_manifest');
      expect(manifestFrame?.payload).toMatchObject({
        attempt_id: 'att_1',
        artifacts: [{ logical_name: 'out.txt', sha256, size_bytes: content.length }],
        collection: { rules: [{ matched_count: 1, collected_count: 1 }] },
      });
      expect(uploadSpy).toHaveBeenCalledTimes(attempts);
      expect(socket.sent.find((f) => f.type === 'cleanup_complete')?.payload).toMatchObject({
        exit_code: 0,
        timed_out: false,
      });
      expect(readAttemptMetadata(stateDir, 'att_1')).toMatchObject({
        artifact_transfer: expectedTransfer,
        last_exit: { exit_code: 0, outcome: 'succeeded' },
      });
      expect(readAttemptMetadata(stateDir, 'att_1')?.artifact_manifest).toBeUndefined();
      await expect(access(stagingPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await recovery.handleReconcileDecision(decision);
      expect(uploadSpy).toHaveBeenCalledTimes(attempts);
      expect(socket.sent.filter((f) => f.type === 'cleanup_complete')).toHaveLength(2);
    },
  );

  it.each([
    { staging: 'pending', hasEntries: false },
    { staging: undefined, hasEntries: false },
    { staging: 'pending', hasEntries: true },
  ] as const)(
    'reports interrupted disk-only staging (marker=$staging, entries=$hasEntries)',
    async ({ staging, hasEntries }) => {
      const socket = mockSocket();
      const executor = new AgentJobExecutor(socket, {
        stateDir,
        controllerFingerprint: 'sha256:test',
        gitAllowlist: { schemes: ['https'], hosts: ['github.com'] },
        repoCache: { max_size_gb: 1, min_free_disk_gb: 1, retention_days: 1 },
      });
      const exit = {
        exit_code: 7,
        outcome: 'failed' as const,
        failure_category: 'process_exit' as const,
      };
      const entry = {
        logical_name: 'already-staged.txt',
        path: join(stateDir, 'artifacts', 'att_interrupted', 'already-staged.txt'),
        size_bytes: 3,
        sha256: createHash('sha256').update('abc').digest('hex'),
      };
      if (hasEntries) {
        await mkdir(join(entry.path, '..'), { recursive: true });
        await writeFile(entry.path, 'abc');
      }
      writeAttemptMetadata(stateDir, {
        attempt_id: 'att_interrupted',
        job_id: 'job_interrupted',
        lease_id: 'lease_interrupted',
        lease_epoch: 1,
        process_identity: 'pid:42',
        status: 'completed_awaiting_upload',
        workspace_path: join(stateDir, 'workspaces', 'att_interrupted'),
        spool_dir: join(stateDir, 'logs', 'att_interrupted'),
        risk_level: 'normal',
        updated_at: new Date().toISOString(),
        artifact_staging: staging,
        ...(hasEntries ? { artifact_manifest: [entry] } : {}),
        last_exit: exit,
      });
      const recovery = new AgentRecoveryCoordinator({
        stateDir,
        hooks: {
          terminateAttempt: async () => undefined,
          resumeArtifactUpload: (meta) => executor.resumeArtifactUpload(meta),
        },
      });
      recovery.attachSocket(socket);
      const send = socket.send.bind(socket);
      socket.send = (raw: string) => {
        send(raw);
        if (JSON.parse(raw).type === 'artifact_manifest') {
          queueMicrotask(() =>
            executor.handleArtifactUploadGrant({
              attempt_id: 'att_interrupted',
              lease_id: 'lease_interrupted',
              lease_epoch: 1,
              artifacts: [], // Controller already has the artifact.
            }),
          );
        }
      };
      await recovery.reportAll();
      const decision = {
        action: 'adopt' as const,
        attempt_id: 'att_interrupted',
        lease_id: 'lease_interrupted',
        lease_epoch: 1,
      };
      await recovery.handleReconcileDecision(decision);
      await recovery.handleReconcileDecision(decision);

      expect(socket.sent.find((frame) => frame.type === 'recovery_report')?.payload).toMatchObject({
        process_exit: exit,
      });
      const manifests = socket.sent.filter((frame) => frame.type === 'artifact_manifest');
      expect(manifests.map((manifest) => manifest.payload)).toEqual(
        hasEntries
          ? [
              {
                artifacts: [entry],
                attempt_id: 'att_interrupted',
                lease_id: 'lease_interrupted',
                lease_epoch: 1,
              },
            ]
          : [],
      );
      const cleanup = socket.sent.filter((frame) => frame.type === 'cleanup_complete');
      expect(cleanup).toHaveLength(2);
      for (const frame of cleanup) {
        expect(frame.payload).toMatchObject({
          exit_code: null,
          timed_out: false,
          artifact_staging_interrupted: true,
          cleanup_interrupted: true,
        });
      }
      expect(readAttemptMetadata(stateDir, 'att_interrupted')).toMatchObject({
        last_exit: exit,
        artifact_staging: 'interrupted',
        artifact_transfer: hasEntries ? 'stored' : 'failed',
      });
      expect(collectSpy).not.toHaveBeenCalled();
    },
  );

  it.each([
    { staging: undefined, cleanupCompleted: true },
    { staging: 'complete', cleanupCompleted: true },
    { staging: 'complete', cleanupCompleted: false },
  ] as const)(
    'recognizes completed empty staging (marker=$staging, cleanup=$cleanupCompleted)',
    async ({ staging, cleanupCompleted }) => {
      const socket = mockSocket();
      const executor = new AgentJobExecutor(socket, {
        stateDir,
        controllerFingerprint: 'sha256:test',
        gitAllowlist: { schemes: ['https'], hosts: ['github.com'] },
        repoCache: { max_size_gb: 1, min_free_disk_gb: 1, retention_days: 1 },
      });
      const originalSend = socket.send.bind(socket);
      socket.send = (raw: string) => {
        originalSend(raw);
        const frame = JSON.parse(raw) as { type: string };
        if (frame.type === 'artifact_manifest') {
          queueMicrotask(() => {
            executor.handleArtifactUploadGrant({
              attempt_id: 'att_empty',
              lease_id: 'lease_empty',
              lease_epoch: 1,
              artifacts: [],
            });
          });
        }
      };
      const meta: AttemptMetadata = {
        attempt_id: 'att_empty',
        job_id: 'job_empty',
        lease_id: 'lease_empty',
        lease_epoch: 1,
        process_identity: 'pid:42',
        status: 'completed_awaiting_upload',
        workspace_path: null,
        spool_dir: join(stateDir, 'logs', 'att_empty'),
        risk_level: 'normal',
        updated_at: new Date().toISOString(),
        artifact_staging: staging,
        artifact_manifest: [],
        ...(cleanupCompleted ? { cleanup_result: { exit_code: 0, timed_out: false } } : {}),
        artifact_collection: {
          rules: [{ matched_count: 0, collected_count: 0, skipped_count: 0, skip_reasons: [] }],
        },
      };
      await executor.resumeArtifactUpload(meta);
      const frame = socket.sent.find((entry) => entry.type === 'artifact_manifest');
      expect(frame?.payload).toMatchObject({
        artifacts: [],
        collection: { rules: [{ matched_count: 0, collected_count: 0 }] },
      });
      const cleanup = socket.sent.find((entry) => entry.type === 'cleanup_complete');
      expect(cleanup?.payload).not.toHaveProperty('artifact_staging_interrupted');
      if (cleanupCompleted) {
        expect(cleanup?.payload).not.toHaveProperty('cleanup_interrupted');
      } else {
        expect(cleanup?.payload).toHaveProperty('cleanup_interrupted', true);
      }
      expect(readAttemptMetadata(stateDir, meta.attempt_id)).toMatchObject({
        artifact_staging: 'complete',
        artifact_transfer: 'stored',
      });
      expect(collectSpy).not.toHaveBeenCalled();
    },
  );

  it('ignores an artifact_upload_grant with a stale/mismatched lease_epoch, then accepts the correct one', async () => {
    const content = Buffer.from('artifact-bytes-2');
    const sha256 = createHash('sha256').update(content).digest('hex');
    const stagingPath = join(stateDir, 'artifacts', 'att_2', 'out.txt');
    await mkdir(join(stagingPath, '..'), { recursive: true });
    await writeFile(stagingPath, content);

    const socket = mockSocket();
    const executor = new AgentJobExecutor(socket, {
      stateDir,
      controllerFingerprint: 'sha256:test',
      gitAllowlist: { schemes: ['https'], hosts: ['github.com'] },
      repoCache: { max_size_gb: 1, min_free_disk_gb: 1, retention_days: 1 },
    });

    // Seed an active attempt slot so requestArtifactUploadTokens can attach pending state.
    (
      executor as unknown as {
        attempts: Map<string, { pendingArtifactUpload: unknown | null }>;
      }
    ).attempts.set('att_2', { pendingArtifactUpload: null });

    const requestPromise = (
      executor as unknown as {
        requestArtifactUploadTokens: (
          attemptId: string,
          leaseId: string,
          leaseEpoch: number,
          artifacts: unknown[],
        ) => Promise<unknown>;
      }
    ).requestArtifactUploadTokens('att_2', 'lease_2', 2, [
      { logical_name: 'out.txt', path: stagingPath, size_bytes: content.length, sha256 },
    ]);

    const grantArgs = {
      attempt_id: 'att_2',
      artifacts: [
        {
          logical_name: 'out.txt',
          path: stagingPath,
          size_bytes: content.length,
          sha256,
          upload_url: 'https://example.invalid/upload',
          upload_token: 'tok',
        },
      ],
    };

    // Stale epoch (1, not the outstanding request's 2) and a wrong lease_id — both must be ignored.
    // If either were wrongly accepted, the promise would resolve with ITS lease tuple instead of
    // staying pending for the correct one.
    executor.handleArtifactUploadGrant({ ...grantArgs, lease_id: 'lease_2', lease_epoch: 1 });
    executor.handleArtifactUploadGrant({ ...grantArgs, lease_id: 'lease_stale', lease_epoch: 2 });
    expect(
      (
        executor as unknown as {
          attempts: Map<string, { pendingArtifactUpload: unknown }>;
        }
      ).attempts.get('att_2')?.pendingArtifactUpload,
    ).not.toBeNull();

    // The correct grant, matching the outstanding request's own lease tuple, resolves it.
    executor.handleArtifactUploadGrant({ ...grantArgs, lease_id: 'lease_2', lease_epoch: 2 });
    const grant = (await requestPromise) as { lease_id: string; lease_epoch: number };
    expect(grant.lease_id).toBe('lease_2');
    expect(grant.lease_epoch).toBe(2);
  });
});
