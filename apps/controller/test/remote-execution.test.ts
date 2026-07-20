import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ensureControllerIdentity } from '@rbo/shared';
import { createGitFixtureRepo } from '@rbo/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentConnection } from '../../../apps/agent/src/connection/client.js';
import { handleDataPlaneRequest, registerArtifactExpectations } from '../src/http/data-plane.js';
import { startControllerServer } from '../src/http/server.ts';
import { handleToolCall } from '../src/mcp/handlers.js';
import { issueDataToken } from '../src/security/data-tokens.js';
import { approvePairingRequest } from '../src/security/pairing.js';
import type { ControllerDatabase } from '../src/storage/database.js';
import { migrateToLatest, openDatabase } from '../src/storage/database.js';
import { startAgentPlaneServer } from '../src/websocket/server.ts';
describe('Phase 4 Remote Execution End-to-End', () => {
  let tempDir: string;
  let db: ReturnType<typeof openDatabase>;
  let identity: ReturnType<typeof ensureControllerIdentity>;
  let agentPlane: Awaited<ReturnType<typeof startAgentPlaneServer>>;
  let controllerServer: Awaited<ReturnType<typeof startControllerServer>>;

  beforeEach(async () => {
    tempDir = join(
      process.cwd(),
      'tmp',
      `test-phase4-remote-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(tempDir, { recursive: true });
    db = openDatabase(join(tempDir, 'controller.db'));
    migrateToLatest(db);
    identity = await ensureControllerIdentity(tempDir);

    agentPlane = await startAgentPlaneServer({
      port: 0,
      db,
      identity,
      dataDir: tempDir,
    });

    controllerServer = await startControllerServer({
      host: '127.0.0.1',
      port: 0,
      db,
      identity,
      connectedAgents: agentPlane.connectedAgents,
      agentPlanePort: agentPlane.port,
      dataDir: tempDir,
      allowedProjectRoots: [tempDir],
      maxConcurrentJobs: 1,
    });
  });

  afterEach(async () => {
    await controllerServer.close();
    await agentPlane.close();
    db.close();
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('executes a full snapshot job remotely on an authenticated agent', async () => {
    const fixture = await createGitFixtureRepo({
      committed: [{ path: 'src/index.js', content: 'console.log("hello remote agent");' }],
    });

    const agentStateDir = join(tempDir, 'agent-state');

    // 1. Connect agent for pairing
    const conn1 = new AgentConnection({
      controllerUrl: `wss://127.0.0.1:${agentPlane.port}/agent`,
      expectedFingerprint: identity.fingerprint,
      stateDir: agentStateDir,
      displayName: 'test-remote-agent',
      gitAllowlist: { schemes: ['https', 'ssh'], hosts: ['github.com'] },
      capabilities: {
        agent_id: '',
        display_name: 'test-remote-agent',
        hostname: 'localhost',
        os: {
          family: (process.platform === 'win32'
            ? 'windows'
            : process.platform === 'darwin'
              ? 'macos'
              : 'linux') as 'windows' | 'macos' | 'linux',
          version: '10.0',
          arch: process.arch,
        },
        resources: {
          cpu_logical: 4,
          memory_total_mb: 8192,
          memory_free_mb: 4096,
          disk_free_mb: 10000,
        },
        execution: {
          max_jobs: 1,
          shells: ['powershell', 'bash'],
          supports_tty: false,
          supports_process_tree_kill: true,
        },
        tools: {},
        toolchain_profiles: [],
        labels: {},
        secret_refs: [],
      },
    });

    const p1 = await conn1.connectOnce();
    expect(p1.status).toBe('pairing_pending');
    conn1.close();

    // 2. Approve pairing on controller
    const pendingReq = db
      .prepare("SELECT id FROM pairing_requests WHERE state = 'pending'")
      .get() as { id: string };
    approvePairingRequest(db, identity, pendingReq.id);

    // 3. Connect agent with credentials
    const conn2 = new AgentConnection({
      controllerUrl: `wss://127.0.0.1:${agentPlane.port}/agent`,
      expectedFingerprint: identity.fingerprint,
      stateDir: agentStateDir,
      displayName: 'test-remote-agent',
      gitAllowlist: { schemes: ['https', 'ssh'], hosts: ['github.com'] },
      capabilities: {
        agent_id: '',
        display_name: 'test-remote-agent',
        hostname: 'localhost',
        os: {
          family: (process.platform === 'win32'
            ? 'windows'
            : process.platform === 'darwin'
              ? 'macos'
              : 'linux') as 'windows' | 'macos' | 'linux',
          version: '10.0',
          arch: process.arch,
        },
        resources: {
          cpu_logical: 4,
          memory_total_mb: 8192,
          memory_free_mb: 4096,
          disk_free_mb: 10000,
        },
        execution: {
          max_jobs: 1,
          shells: ['powershell', 'bash'],
          supports_tty: false,
          supports_process_tree_kill: true,
        },
        tools: {},
        toolchain_profiles: [],
        labels: {},
        secret_refs: [],
      },
    });

    const p2 = await conn2.connectOnce();
    expect(p2.status).toBe('authenticated');

    // 4. Submit remote job via MCP
    const ctx = {
      db,
      identity: { client_id: 'test_client', transport: 'internal' as const, session_id: null },
      dataDir: tempDir,
      controllerIdentity: identity,
      allowedProjectRoots: [fixture.root],
      connectedAgents: agentPlane.connectedAgents,
      agentPlanePort: agentPlane.port,
    };

    const submitRes = await handleToolCall(ctx, 'job_submit', {
      client_request_id: 'req_remote_1',
      source: { project_root: fixture.root, cwd: '.' },
      execution: {
        shell: process.platform === 'win32' ? 'powershell' : 'bash',
        script: 'node src/index.js',
      },
      queue_policy: 'wait',
    });

    expect(submitRes.job_id).toBeDefined();
    const jobId = String(submitRes.job_id);

    // 5. Wait for remote job completion
    const waitRes = await handleToolCall(ctx, 'job_wait', {
      job_id: jobId,
      timeout_ms: 10000,
    });

    const jobData = waitRes.job as Record<string, unknown>;
    expect(jobData.state).toBe('completed');
    expect(jobData.outcome).toBe('succeeded');

    conn2.close();
  });

  it('supports nested artifact relative paths in handleDataPlaneRequest URL regex', async () => {
    const token = issueDataToken(identity, {
      agent_id: 'ag-1',
      job_id: 'job-1',
      attempt_id: 'att-123',
      lease_id: 'lease-1',
      lease_epoch: 1,
      op: 'artifact_upload',
      artifact_id: 'sub/dir/output.txt',
    });

    let status = 0;
    let body = '';

    const req = {
      url: `/data/v1/attempts/att-123/artifacts/sub/dir/output.txt?token=${token}`,
      method: 'PUT',
      headers: { host: 'localhost' },
    } as unknown as IncomingMessage;

    const res = {
      writeHead: (s: number) => {
        status = s;
      },
      end: (b?: string) => {
        body = b ?? '';
      },
    } as unknown as ServerResponse;

    const mockDb = {
      prepare: () => ({
        get: () => ({
          id: 'att-123',
          job_id: 'job-1',
          agent_id: 'ag-1',
          lease_id: 'lease-1',
          lease_epoch: 1,
          lease_deadline: null,
          state: 'collecting_artifacts',
        }),
      }),
    } as unknown as ControllerDatabase;

    const handled = await handleDataPlaneRequest(req, res, {
      db: mockDb,
      identity,
      dataDir: tempDir,
    });

    expect(handled).toBe(true);
    const json = JSON.parse(body);
    expect(json.error?.message).toBe('Artifact was not declared in artifact_manifest');
  });

  it('oversized artifact upload returns 413 without hanging the request handler', async () => {
    const attemptId = 'att-oversize';
    const logicalName = 'big.bin';
    const declaredSize = 8;
    const body = Buffer.alloc(64, 0x61);
    const now = new Date().toISOString();
    const deadline = new Date(Date.now() + 60_000).toISOString();

    db.prepare(
      `INSERT INTO agents (id, display_name, hostname, state, capabilities_json, paired_at)
       VALUES ('ag-1', 'ag-1', 'localhost', 'idle', '{}', ?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO jobs (id, client_id, client_request_id, state, created_at, updated_at, request_json)
       VALUES ('job-1', 'c', 'r', 'collecting_artifacts', ?, ?, '{}')`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO job_attempts (id, job_id, ordinal, agent_id, lease_id, lease_epoch, lease_deadline, state)
       VALUES (?, 'job-1', 1, 'ag-1', 'lease-1', 1, ?, 'collecting_artifacts')`,
    ).run(attemptId, deadline);

    registerArtifactExpectations(attemptId, [
      {
        logical_name: logicalName,
        size_bytes: declaredSize,
        sha256: createHash('sha256').update(body.subarray(0, declaredSize)).digest('hex'),
      },
    ]);

    const token = issueDataToken(identity, {
      agent_id: 'ag-1',
      job_id: 'job-1',
      attempt_id: attemptId,
      lease_id: 'lease-1',
      lease_epoch: 1,
      op: 'artifact_upload',
      artifact_id: logicalName,
    });

    let status = 0;
    let responseBody = '';
    const req = Readable.from([body]) as IncomingMessage;
    req.url = `/data/v1/attempts/${attemptId}/artifacts/${logicalName}`;
    req.method = 'PUT';
    req.headers = {
      host: 'localhost',
      authorization: `Bearer ${token}`,
      'content-length': String(body.length),
    };

    const res = {
      headersSent: false,
      writeHead(s: number) {
        status = s;
        this.headersSent = true;
      },
      end(b?: string) {
        responseBody = b ?? '';
      },
    } as unknown as ServerResponse & { headersSent: boolean };

    // Bug evidence: 413 is written, but the handler never resolves (writeStream.destroy
    // does not emit 'finish'/'error'), so this race rejects with a hang timeout.
    await expect(
      Promise.race([
        handleDataPlaneRequest(req, res, { db, identity, dataDir: tempDir }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(`data-plane upload handler hung (status=${status} body=${responseBody})`),
              ),
            2000,
          ),
        ),
      ]),
    ).resolves.toBe(true);

    expect(status).toBe(413);
    expect(JSON.parse(responseBody).error?.category).toBe('artifact_upload');
  });
});
