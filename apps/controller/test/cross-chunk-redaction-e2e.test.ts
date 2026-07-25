/**
 * Phase 4 §1.8 — cross-chunk secret redaction e2e: Agent log_chunk → Controller spool.
 */
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { AgentJobExecutor } from '../../agent/src/executor/index.js';
import { handleRemoteLogChunk } from '../src/execution/remote-execution.js';
import { attemptLogDir } from '../src/execution/runner.js';
import { createJob, transitionJobState } from '../src/jobs/lifecycle.js';
import { migrateToLatest, nowIso, openDatabase } from '../src/storage/database.js';
import type { ConnectedAgent } from '../src/websocket/server.js';

const SECRET = 'SUPERSECRETKEY';

let waitResolve:
  | ((value: { exitCode: number | null; signal: NodeJS.Signals | null }) => void)
  | null = null;

vi.mock('@rbo/executor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@rbo/executor')>();
  return {
    ...actual,
    spawnJobScript: vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        pid: number;
        waitForExit: () => Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
        kill: (grace?: number) => Promise<void>;
        ignoredRboEnvKeys: string[];
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.pid = 4242;
      child.ignoredRboEnvKeys = [];
      child.waitForExit = () =>
        new Promise((resolve) => {
          waitResolve = resolve;
        });
      child.kill = async () => {
        waitResolve?.({ exitCode: null, signal: 'SIGTERM' });
        waitResolve = null;
      };

      queueMicrotask(() => {
        child.stdout.write('stdout prefix SUPERSEC');
        child.stdout.write('RETKEY suffix\n');
        waitResolve?.({ exitCode: 0, signal: null });
        waitResolve = null;
      });

      return child;
    }),
    waitForCompletion: vi.fn(
      async ({ child }: { child: { waitForExit: () => Promise<unknown> } }) => {
        const result = await child.waitForExit();
        return {
          type: 'exit' as const,
          exitCode: (result as { exitCode: number | null }).exitCode,
        };
      },
    ),
    writeJobScript: vi.fn(async () => 'script'),
    collectArtifactFiles: vi.fn(async () => ({ files: [] })),
    runCleanupScript: vi.fn(async () => ({ exitCode: 0, timedOut: false })),
  };
});

function mockSocket(executorHolder: { current: AgentJobExecutor | null }): WebSocket & {
  sent: Array<Record<string, unknown>>;
} {
  const sent: Array<Record<string, unknown>> = [];
  return {
    readyState: 1,
    OPEN: 1,
    sent,
    send(raw: string) {
      const frame = JSON.parse(raw) as Record<string, unknown>;
      sent.push(frame);
      if (frame.type === 'artifact_manifest' && executorHolder.current) {
        const payload = frame.payload as {
          attempt_id: string;
          lease_id: string;
          lease_epoch: number;
        };
        queueMicrotask(() => {
          executorHolder.current?.handleArtifactUploadGrant({
            attempt_id: payload.attempt_id,
            lease_id: payload.lease_id,
            lease_epoch: payload.lease_epoch,
            artifacts: [],
          });
        });
      }
    },
  } as unknown as WebSocket & { sent: Array<Record<string, unknown>> };
}

describe('Cross-chunk secret redaction e2e (§1.8)', () => {
  let agentStateDir: string;
  let controllerDataDir: string;

  beforeEach(async () => {
    process.env.RBO_E2E_SECRET = SECRET;
    agentStateDir = await mkdtemp(join(tmpdir(), 'rbo-redact-agent-'));
    controllerDataDir = await mkdtemp(join(tmpdir(), 'rbo-redact-ctl-'));
    waitResolve = null;
  });

  afterEach(async () => {
    process.env.RBO_E2E_SECRET = undefined;
    await rm(agentStateDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(controllerDataDir, { recursive: true, force: true }).catch(() => undefined);
    vi.clearAllMocks();
  });

  it('redacts secrets split across consecutive log_chunk payloads before Controller spool storage', async () => {
    const holder: { current: AgentJobExecutor | null } = { current: null };
    const socket = mockSocket(holder);
    const executor = new AgentJobExecutor(socket, {
      stateDir: agentStateDir,
      controllerFingerprint: 'sha256:test',
      gitAllowlist: { schemes: ['https'], hosts: ['github.com'] },
      repoCache: { max_size_gb: 1, min_free_disk_gb: 1, retention_days: 1 },
      secretMap: { 'vault/api-key': 'RBO_E2E_SECRET' },
    });
    holder.current = executor;

    const projectPath = join(agentStateDir, 'project');
    await mkdir(projectPath, { recursive: true });
    await writeFile(join(projectPath, 'main.txt'), 'x');

    executor.handleLeaseOffer({
      attempt_id: 'att_redact',
      lease_id: 'lease_redact',
      lease_epoch: 1,
      job_id: 'job_redact',
      job_request: {
        client_request_id: 'req_redact',
        source: { project_root: projectPath, cwd: '.' },
        execution: {
          shell: 'bash',
          script: 'echo leak',
          secret_refs: { API_KEY: 'vault/api-key' },
        },
      },
      snapshot_metadata: {
        snapshot_id: 'snp_redact',
        content_id: 'cid_redact',
        size_bytes: 1,
        sha256: 'ab',
      },
      lease_ttl_seconds: 300,
    });

    const attempt = (
      executor as unknown as {
        attempts: Map<string, { prepare: unknown; materializedProjectPath: string | null }>;
      }
    ).attempts.get('att_redact');
    if (!attempt) {
      throw new Error('expected att_redact runtime');
    }
    attempt.prepare = {
      source_mode: 'full',
      attempt_id: 'att_redact',
      lease_id: 'lease_redact',
      lease_epoch: 1,
      download_url: 'https://example.invalid/snapshot',
      data_token: 'tok',
      expected_size_bytes: 1,
      expected_sha256: 'ab',
    };
    attempt.materializedProjectPath = projectPath;

    await executor.handleRunJob({
      attempt_id: 'att_redact',
      lease_id: 'lease_redact',
      lease_epoch: 1,
    });

    const logChunks = socket.sent
      .filter((f) => f.type === 'log_chunk')
      .map((f) => f.payload as { sequence: number; bytes: string; stream: string });

    expect(logChunks.length).toBeGreaterThanOrEqual(2);
    const combinedWire = logChunks.map((c) => c.bytes).join('');
    expect(combinedWire).not.toContain(SECRET);
    expect(combinedWire).not.toContain('SUPERSEC');
    expect(combinedWire).not.toContain('RETKEY');
    expect(combinedWire).toContain('[REDACTED]');

    const db = openDatabase(':memory:');
    migrateToLatest(db);
    db.prepare(
      `INSERT INTO agents (id, display_name, hostname, state, capabilities_json, paired_at)
       VALUES ('agt_redact', 'agt_redact', 'localhost', 'idle', '{}', ?)`,
    ).run(nowIso());
    const job = createJob(db, {
      clientId: 'client',
      clientRequestId: 'req_redact_ctl',
      initialState: 'queued',
      request: {
        client_request_id: 'req_redact_ctl',
        source: { project_root: '/tmp', cwd: '.' },
        execution: { script: 'echo hi' },
      },
    });
    transitionJobState(db, job.id, 'running');
    db.prepare(
      `INSERT INTO job_attempts (id, job_id, ordinal, agent_id, lease_id, lease_epoch, lease_deadline, state)
       VALUES ('att_redact', ?, 1, 'agt_redact', 'lease_redact', 1, ?, 'running')`,
    ).run(job.id, new Date(Date.now() + 60_000).toISOString());

    const mockWs = {
      readyState: 1,
      OPEN: 1,
      send() {},
    } as unknown as WebSocket;
    const connectedAgents = new Map<string, ConnectedAgent>([
      [
        'agt_redact',
        {
          agentId: 'agt_redact',
          socket: mockWs,
          protocolVersion: 1,
          lastHeartbeatAt: Date.now(),
        },
      ],
    ]);

    const remoteOpts = {
      db,
      identity: {
        controllerId: 'ctl',
        fingerprint: 'sha256:abc',
        tlsCertPem: '',
        tlsKeyPem: '',
        signingPublicKeyPem: '',
        signingPrivateKeyPem: '',
      },
      dataDir: controllerDataDir,
      connectedAgents,
      serverPort: 0,
    };

    for (const chunk of logChunks.sort((a, b) => a.sequence - b.sequence)) {
      await handleRemoteLogChunk(remoteOpts, 'agt_redact', {
        attempt_id: 'att_redact',
        lease_id: 'lease_redact',
        lease_epoch: 1,
        stream: chunk.stream as 'stdout' | 'stderr',
        sequence: chunk.sequence,
        bytes: chunk.bytes,
      });
    }

    const stored = await readFile(
      join(attemptLogDir(controllerDataDir, 'att_redact'), 'stdout.log'),
      'utf8',
    );
    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain('SUPERSEC');
    expect(stored).not.toContain('RETKEY');
    expect(stored).toContain('[REDACTED]');
    db.close();
  });
});
