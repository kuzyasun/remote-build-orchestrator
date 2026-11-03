import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStdioProxyServer } from '../src/proxy.js';

afterEach(() => vi.unstubAllGlobals());

async function callAgentsList(controllerUrl = 'http://127.0.0.1:7410') {
  const proxy = createStdioProxyServer({ controllerUrl, clientId: 'proxy-error-test' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await proxy.connect(serverTransport);
  const client = new Client({ name: 'proxy-error-test', version: '0.0.1' });
  await client.connect(clientTransport);
  try {
    return await client.callTool({ name: 'agents_list', arguments: { include_offline: false } });
  } finally {
    await client.close();
  }
}

function contentText(result: Awaited<ReturnType<typeof callAgentsList>>, index = 0): string {
  const item = result.content[index];
  if (item?.type !== 'text') throw new Error('Expected text content');
  return item.text;
}

describe('stdio proxy errors', () => {
  it('explains that a refused connection means the Controller is not listening', async () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
      syscall: 'connect',
      address: '127.0.0.1',
      port: 7410,
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed', { cause })));

    const result = await callAgentsList('http://user:secret@127.0.0.1:7410');

    expect(result.isError).toBe(true);
    expect(contentText(result)).toContain('no HTTP response (connect ECONNREFUSED 127.0.0.1:7410)');
    expect(contentText(result)).toContain('Controller is not listening');
    expect(contentText(result)).toContain('rbo controller start --daemon');
    expect(contentText(result)).not.toContain('secret');
  });

  it('keeps other transport failures distinct from a stopped Controller', async () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed', { cause })));

    const result = await callAgentsList();

    expect(result.isError).toBe(true);
    expect(contentText(result)).toContain('ENOTFOUND');
    expect(contentText(result)).not.toContain('Controller is not listening');
  });

  it('preserves Controller error JSON and adds the HTTP status', async () => {
    const body = JSON.stringify({ error: { category: 'internal', message: 'Unavailable' } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 503 })));

    const result = await callAgentsList();

    expect(result.isError).toBe(true);
    expect(contentText(result)).toBe(body);
    expect(contentText(result, 1)).toBe('RBO Controller returned HTTP 503');
  });

  it('resolves admin token dynamically per request when token becomes available on disk', async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ agents: [] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const tempDir = await mkdtemp(join(tmpdir(), 'rbo-mcp-test-'));
    process.env.RBO_DATA_DIR = tempDir;
    try {
      const proxy = createStdioProxyServer({
        controllerUrl: 'http://127.0.0.1:7410',
        clientId: 'proxy-dynamic-token-test',
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await proxy.connect(serverTransport);
      const client = new Client({ name: 'proxy-dynamic-token-test', version: '0.0.1' });
      await client.connect(clientTransport);

      try {
        // First call: token file doesn't exist
        await client.callTool({ name: 'agents_list', arguments: { include_offline: false } });
        expect(capturedHeaders.authorization).toBeUndefined();

        // Write token file
        const secDir = join(tempDir, 'security');
        await mkdir(secDir, { recursive: true });
        await writeFile(join(secDir, 'admin-token'), 'dynamic-token-123\n');

        // Second call: picks up the token without restarting proxy
        await client.callTool({ name: 'agents_list', arguments: { include_offline: false } });
        expect(capturedHeaders.authorization).toBe('Bearer dynamic-token-123');
      } finally {
        await client.close();
      }
    } finally {
      process.env.RBO_DATA_DIR = undefined;
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
