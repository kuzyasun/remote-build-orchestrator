import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { appendIndexedLogChunk, ensureAttemptLogs } from '@rbo/executor';
import { MCP_TOOL_DEFS } from '@rbo/protocol';
import { ensureControllerIdentity } from '@rbo/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStdioProxyServer } from '../../mcp-stdio/src/proxy.js';
import { attemptLogDir } from '../src/execution/runner.js';
import { startControllerServer } from '../src/http/server.js';
import type { RunningControllerServer } from '../src/http/server.js';
import { migrateToLatest, openDatabase } from '../src/storage/database.js';

let running: RunningControllerServer;

beforeAll(async () => {
  const db = openDatabase(':memory:');
  migrateToLatest(db);
  running = await startControllerServer({
    // These fixtures use local repos with no allowlisted remote, so overlay
    // capture is impossible; opt in to the full-snapshot path explicitly.
    allowFullSnapshotFallback: true,
    host: '127.0.0.1',
    port: 0,
    db,
  });
});

afterAll(async () => {
  await running.close();
});

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  const first = content[0];
  if (!first || first.type !== 'text') {
    throw new Error('expected text content');
  }
  return first.text;
}

async function connectHttpClient(server = running): Promise<Client> {
  const client = new Client({ name: 'test-http-client', version: '0.0.1' });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${server.port}/mcp`),
  );
  await client.connect(transport);
  return client;
}

async function connectStdioStyleClient(server = running): Promise<Client> {
  // The stdio adapter's MCP server logic, wired over an in-memory pair —
  // identical code path to `rbo mcp-stdio` minus the OS pipe.
  const proxy = createStdioProxyServer({
    controllerUrl: `http://127.0.0.1:${server.port}`,
    clientId: 'test-stdio-client',
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await proxy.connect(serverTransport);
  const client = new Client({ name: 'test-stdio-client', version: '0.0.1' });
  await client.connect(clientTransport);
  return client;
}

describe('MCP transports', () => {
  it('exposes the same MCP tools over Streamable HTTP', async () => {
    const client = await connectHttpClient();
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(MCP_TOOL_DEFS.map((d) => d.name).sort());
    await client.close();
  });

  it('returns an empty agent list over HTTP (exit criteria)', async () => {
    const client = await connectHttpClient();
    const result = await client.callTool({ name: 'agents_list', arguments: {} });
    expect(JSON.parse(textOf(result))).toEqual({ agents: [] });
    await client.close();
  });

  it('the same request over stdio and HTTP gives a schema-equivalent result', async () => {
    const httpClient = await connectHttpClient();
    const stdioClient = await connectStdioStyleClient();

    for (const call of [
      { name: 'agents_list', arguments: {} },
      { name: 'job_get', arguments: { job_id: 'job_01J1234567890ABCDEFGHJKMNP' } },
      { name: 'job_wait', arguments: { job_id: 'job_01J1234567890ABCDEFGHJKMNP' } },
      {
        name: 'artifact_materialize',
        arguments: { artifact_id: 'art_1', destination_path: 'C:/develop/out.bin' },
      },
    ]) {
      const viaHttp = JSON.parse(textOf(await httpClient.callTool(call)));
      const viaStdio = JSON.parse(textOf(await stdioClient.callTool(call)));
      expect(viaStdio).toEqual(viaHttp);
    }

    await httpClient.close();
    await stdioClient.close();
  });

  it('agent_probe returns the real probe payload shape', async () => {
    const client = await connectHttpClient();
    const result = JSON.parse(
      textOf(await client.callTool({ name: 'agent_probe', arguments: { agent_id: 'agt_x' } })),
    );
    expect(result.error?.category).toBe('agent_lost');
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.details?.not_implemented).toBeUndefined();
    await client.close();
  });

  it('rejects malformed tool input before it reaches the service layer', async () => {
    const client = await connectHttpClient();
    // The SDK validates against the shared Zod schema and reports isError
    // without ever invoking the tool handler.
    const badJobGet = await client.callTool({ name: 'job_get', arguments: { job_id: 123 } });
    expect(badJobGet.isError).toBe(true);
    expect(textOf(badJobGet)).toMatch(/Expected string/);

    const badAgentsList = await client.callTool({
      name: 'agents_list',
      arguments: { include_offline: 'yes' },
    });
    expect(badAgentsList.isError).toBe(true);
    await client.close();
  });

  it('validates input on the internal API used by the stdio adapter', async () => {
    const res = await fetch(`http://127.0.0.1:${running.port}/internal/v1/tools/job_get`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-rbo-client-id': 'test' },
      body: JSON.stringify({ job_id: 42 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { category: string } };
    expect(body.error.category).toBe('validation');
  });

  it('rejects unknown tools on the internal API', async () => {
    const res = await fetch(`http://127.0.0.1:${running.port}/internal/v1/tools/nope`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });
});

describe('job_logs transport parity with persistent cursor identity', () => {
  let fixtureDir: string;
  let fixtureServer: RunningControllerServer;

  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), 'rbo-job-logs-transport-'));
    const db = openDatabase(':memory:');
    migrateToLatest(db);
    const identity = await ensureControllerIdentity(fixtureDir);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO jobs (id, client_id, client_request_id, state, created_at, updated_at, request_json)
      VALUES ('job_transport_logs', 'fixture', 'transport-logs', 'running', ?, ?, '{}')`).run(
      now,
      now,
    );
    db.prepare(`INSERT INTO job_attempts (id, job_id, ordinal, lease_id, lease_epoch, state)
      VALUES ('att_transport_logs', 'job_transport_logs', 1, 'lease-transport-logs', 1, 'running')`).run();
    const logs = await ensureAttemptLogs(attemptLogDir(fixtureDir, 'att_transport_logs'));
    await appendIndexedLogChunk(logs, 'stdout', 'transport-parity', 1);
    fixtureServer = await startControllerServer({
      host: '127.0.0.1',
      port: 0,
      db,
      identity,
      dataDir: fixtureDir,
    });
  });

  afterAll(async () => {
    await fixtureServer.close();
    await rm(fixtureDir, { recursive: true, force: true });
  });

  it('returns byte-for-byte equal successful job_logs JSON through HTTP and stdio', async () => {
    const httpClient = await connectHttpClient(fixtureServer);
    const stdioClient = await connectStdioStyleClient(fixtureServer);
    const arguments_ = {
      job_id: 'job_transport_logs',
      attempt_id: 'att_transport_logs',
      mode: 'logs' as const,
      max_bytes: 64,
    };
    const viaHttp = JSON.parse(
      textOf(await httpClient.callTool({ name: 'job_logs', arguments: arguments_ })),
    );
    const viaStdio = JSON.parse(
      textOf(await stdioClient.callTool({ name: 'job_logs', arguments: arguments_ })),
    );
    expect(viaHttp).toEqual(viaStdio);
    expect(viaHttp).toMatchObject({
      job_id: 'job_transport_logs',
      attempt_id: 'att_transport_logs',
      mode: 'logs',
      chunks: [{ text: 'transport-parity' }],
    });
    await httpClient.close();
    await stdioClient.close();
  });
});

describe('Loopback enforcement (§7.1)', () => {
  it('refuses to bind the MCP endpoint to a non-loopback interface', async () => {
    const db = openDatabase(':memory:');
    migrateToLatest(db);
    await expect(
      startControllerServer({
        // These fixtures use local repos with no allowlisted remote, so overlay
        // capture is impossible; opt in to the full-snapshot path explicitly.
        allowFullSnapshotFallback: true,
        host: '0.0.0.0',
        port: 0,
        db,
      }),
    ).rejects.toThrow(/loopback/i);
  });
});
