import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { AgentJobExecutor } from '../src/executor/index.js';
import { type AttemptMetadata, writeAttemptMetadata } from '../src/recovery/attempt-metadata.js';
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

  it('on adopt re-sends artifact_manifest from persisted staging; never re-collects workspace', async () => {
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
      artifact_manifest: [
        {
          logical_name: 'out.txt',
          path: stagingPath,
          size_bytes: content.length,
          sha256,
        },
      ],
    };
    writeAttemptMetadata(stateDir, meta);

    const socket = mockSocket();
    const executor = new AgentJobExecutor(socket, {
      stateDir,
      controllerFingerprint: 'sha256:test',
      gitAllowlist: { schemes: ['https'], hosts: ['github.com'] },
      repoCache: { max_size_gb: 1, min_free_disk_gb: 1, retention_days: 1 },
    });

    // Grant arrives after manifest — resolve upload without network
    const uploadSpy = vi
      .spyOn(
        executor as unknown as {
          uploadArtifactFile: (...a: unknown[]) => Promise<void>;
        },
        'uploadArtifactFile',
      )
      .mockResolvedValue(undefined);

    const recovery = new AgentRecoveryCoordinator({
      stateDir,
      hooks: {
        terminateAttempt: async () => undefined,
        resendJobExit: (m) => executor.resendJobExitIfCompleted(m),
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

    await recovery.handleReconcileDecision({
      attempt_id: 'att_1',
      lease_id: 'lease_1',
      lease_epoch: 1,
      action: 'adopt',
      resume_from_sequence: 0,
    });

    // Allow microtasks for grant + upload
    await new Promise((r) => setTimeout(r, 20));

    expect(collectSpy).not.toHaveBeenCalled();
    const manifestFrame = socket.sent.find((f) => f.type === 'artifact_manifest');
    expect(manifestFrame?.payload).toMatchObject({
      attempt_id: 'att_1',
      artifacts: [{ logical_name: 'out.txt', sha256, size_bytes: content.length }],
    });
    expect(uploadSpy).toHaveBeenCalled();
  });
});
