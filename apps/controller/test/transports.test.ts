import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MCP_TOOL_DEFS } from '@rbo/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStdioProxyServer } from '../../mcp-stdio/src/proxy.js';
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

async function connectHttpClient(): Promise<Client> {
  const client = new Client({ name: 'test-http-client', version: '0.0.1' });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${running.port}/mcp`),
  );
  await client.connect(transport);
  return client;
}

async function connectStdioStyleClient(): Promise<Client> {
  // The stdio adapter's MCP server logic, wired over an in-memory pair —
  // identical code path to `rbo mcp-stdio` minus the OS pipe.
  const proxy = createStdioProxyServer({
    controllerUrl: `http://127.0.0.1:${running.port}`,
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
