import { mkdir, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
/**
 * Phase 4 §1.7 — data-token negatives and /data/v1 isolation from MCP/admin surfaces.
 */
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import { ensureControllerIdentity } from '@rbo/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleDataPlaneRequest } from '../src/http/data-plane.js';
import { startControllerServer } from '../src/http/server.js';
import { issueDataToken } from '../src/security/data-tokens.js';
import { migrateToLatest, nowIso, openDatabase } from '../src/storage/database.js';
import type { ControllerDatabase } from '../src/storage/database.js';
import { startAgentPlaneServer } from '../src/websocket/server.js';

function httpsJson(
  port: number,
  path: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: init?.method ?? 'GET',
        rejectUnauthorized: false,
        headers: init?.headers,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += String(chunk);
        });
        res.on('end', () => {
          let body: Record<string, unknown> = {};
          try {
            body = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
          } catch {
            body = { raw };
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on('error', reject);
    if (init?.body) {
      req.write(init.body);
    }
    req.end();
  });
}

async function invokeDataPlane(input: {
  db: ControllerDatabase;
  identity: Awaited<ReturnType<typeof ensureControllerIdentity>>;
  dataDir: string;
  attemptId: string;
  token: string;
  pathname: string;
  method?: string;
}): Promise<{ status: number; message: string }> {
  let status = 0;
  let body = '';

  const req = {
    url: `${input.pathname}?token=${encodeURIComponent(input.token)}`,
    method: input.method ?? 'GET',
    headers: { host: 'localhost' },
  } as unknown as IncomingMessage;

  const res = {
    writeHead(s: number) {
      status = s;
    },
    end(b?: string) {
      body = b ?? '';
    },
  } as unknown as ServerResponse;

  const handled = await handleDataPlaneRequest(req, res, {
    db: input.db,
    identity: input.identity,
    dataDir: input.dataDir,
  });
  expect(handled).toBe(true);
  const json = body.length > 0 ? (JSON.parse(body) as { error?: { message?: string } }) : {};
  return { status, message: json.error?.message ?? '' };
}

function seedAttempt(
  db: ControllerDatabase,
  input: {
    attemptId: string;
    agentId: string;
    leaseId: string;
    leaseEpoch: number;
    state?: string;
  },
): void {
  const now = nowIso();
  const deadline = new Date(Date.now() + 60_000).toISOString();
  db.prepare(
    `INSERT INTO agents (id, display_name, hostname, state, capabilities_json, paired_at)
     VALUES (?, ?, 'localhost', 'idle', '{}', ?)`,
  ).run(input.agentId, input.agentId, now);
  db.prepare(
    `INSERT INTO jobs (id, client_id, client_request_id, state, created_at, updated_at, request_json)
     VALUES ('job_dp', 'client', 'req_dp', 'running', ?, ?, '{}')`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO job_attempts (id, job_id, ordinal, agent_id, lease_id, lease_epoch, lease_deadline, state)
     VALUES (?, 'job_dp', 1, ?, ?, ?, ?, ?)`,
  ).run(
    input.attemptId,
    input.agentId,
    input.leaseId,
    input.leaseEpoch,
    deadline,
    input.state ?? 'preparing_source',
  );
}

describe('Data-plane token negatives (§1.7)', () => {
  let tempDir: string;
  let db: ReturnType<typeof openDatabase>;
  let identity: Awaited<ReturnType<typeof ensureControllerIdentity>>;
  const attemptId = 'att_dp_neg';
  const agentId = 'agt_dp';
  const leaseId = 'lease_dp';
  const leaseEpoch = 3;

  beforeEach(async () => {
    tempDir = join(
      process.cwd(),
      'tmp',
      `test-data-plane-sec-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(tempDir, { recursive: true });
    db = openDatabase(join(tempDir, 'controller.db'));
    migrateToLatest(db);
    identity = await ensureControllerIdentity(tempDir);
    seedAttempt(db, { attemptId, agentId, leaseId, leaseEpoch });
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  function baseClaims() {
    return {
      agent_id: agentId,
      job_id: 'job_dp',
      attempt_id: attemptId,
      lease_id: leaseId,
      lease_epoch: leaseEpoch,
      op: 'snapshot_download' as const,
    };
  }

  it('rejects expired data tokens', async () => {
    const token = issueDataToken(identity, { ...baseClaims(), ttl_seconds: -60 });
    const res = await invokeDataPlane({
      db,
      identity,
      dataDir: tempDir,
      attemptId,
      token,
      pathname: `/data/v1/attempts/${attemptId}/snapshot`,
    });
    expect(res.status).toBe(403);
    expect(res.message).toMatch(/invalid or expired/i);
  });

  it('rejects wrong agent_id in token', async () => {
    const token = issueDataToken(identity, { ...baseClaims(), agent_id: 'agt_other' });
    const res = await invokeDataPlane({
      db,
      identity,
      dataDir: tempDir,
      attemptId,
      token,
      pathname: `/data/v1/attempts/${attemptId}/snapshot`,
    });
    expect(res.status).toBe(403);
    expect(res.message).toMatch(/lease tuple mismatch/i);
  });

  it('rejects wrong lease_id in token', async () => {
    const token = issueDataToken(identity, { ...baseClaims(), lease_id: 'lease_wrong' });
    const res = await invokeDataPlane({
      db,
      identity,
      dataDir: tempDir,
      attemptId,
      token,
      pathname: `/data/v1/attempts/${attemptId}/snapshot`,
    });
    expect(res.status).toBe(403);
    expect(res.message).toMatch(/lease tuple mismatch/i);
  });

  it('rejects wrong lease_epoch in token', async () => {
    const token = issueDataToken(identity, { ...baseClaims(), lease_epoch: leaseEpoch + 1 });
    const res = await invokeDataPlane({
      db,
      identity,
      dataDir: tempDir,
      attemptId,
      token,
      pathname: `/data/v1/attempts/${attemptId}/snapshot`,
    });
    expect(res.status).toBe(403);
    expect(res.message).toMatch(/lease tuple mismatch/i);
  });

  it('rejects wrong op claim for the requested route', async () => {
    const token = issueDataToken(identity, {
      ...baseClaims(),
      op: 'artifact_upload',
      artifact_id: 'out.bin',
    });
    const res = await invokeDataPlane({
      db,
      identity,
      dataDir: tempDir,
      attemptId,
      token,
      pathname: `/data/v1/attempts/${attemptId}/snapshot`,
    });
    expect(res.status).toBe(403);
    expect(res.message).toMatch(/snapshot download/i);
  });
});

describe('/data/v1 isolation from MCP/admin auth (§1.7)', () => {
  let tempDir: string;
  let db: ReturnType<typeof openDatabase>;
  let identity: Awaited<ReturnType<typeof ensureControllerIdentity>>;
  let agentPlane: Awaited<ReturnType<typeof startAgentPlaneServer>>;
  let controllerServer: Awaited<ReturnType<typeof startControllerServer>>;

  beforeEach(async () => {
    tempDir = join(
      process.cwd(),
      'tmp',
      `test-data-plane-iso-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
    });
  });

  afterEach(async () => {
    await controllerServer.close();
    await agentPlane.close();
    db.close();
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('agent-plane HTTPS serves /data/v1 only — MCP/admin paths return 404', async () => {
    const dataPlaneProbe = await httpsJson(agentPlane.port, '/data/v1/attempts/att_x/snapshot');
    expect(dataPlaneProbe.status).toBe(401);
    expect(dataPlaneProbe.body.error).toMatchObject({ message: 'Missing data token' });

    const mcpOnAgentPlane = await httpsJson(agentPlane.port, '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
    });
    expect(mcpOnAgentPlane.status).toBe(404);

    const adminOnAgentPlane = await httpsJson(agentPlane.port, '/internal/v1/admin/pairing/list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(adminOnAgentPlane.status).toBe(404);
  });

  it('loopback MCP server does not expose /data/v1 routes', async () => {
    const token = issueDataToken(identity, {
      agent_id: 'agt_x',
      job_id: 'job_x',
      attempt_id: 'att_x',
      lease_id: 'lease_x',
      lease_epoch: 1,
      op: 'snapshot_download',
    });

    const res = await fetch(
      `http://127.0.0.1:${controllerServer.port}/data/v1/attempts/att_x/snapshot?token=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toBe('Not found');
  });
});
