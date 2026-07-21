import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ensureControllerIdentity } from '@rbo/shared';
import {
  longRunningCancelJobRequest,
  renderSmokeEvidence,
  runPhase8SmokeWorkflow,
  textOf,
} from '@rbo/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStdioProxyServer } from '../../mcp-stdio/src/proxy.js';
import { startControllerServer } from '../src/http/server.js';
import type { RunningControllerServer } from '../src/http/server.js';
import { migrateToLatest, openDatabase } from '../src/storage/database.js';
import type { ControllerDatabase } from '../src/storage/database.js';

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true });
}

let running: RunningControllerServer;
let dataDir: string;
let db: ControllerDatabase;
let fixtureDir: string;
let artifactDestRoot: string;
let cleanupFixture: () => Promise<void>;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'rbo-phase8-ctrl-'));
  artifactDestRoot = await mkdtemp(join(tmpdir(), 'rbo-phase8-art-'));
  db = openDatabase(':memory:');
  migrateToLatest(db);
  const identity = await ensureControllerIdentity(dataDir);

  const dir = await mkdtemp(join(tmpdir(), 'rbo-phase8-fix-'));
  await runGit(dir, ['init']);
  await runGit(dir, ['config', 'user.email', 'phase8@example.com']);
  await runGit(dir, ['config', 'user.name', 'Phase8']);
  await writeFile(join(dir, 'tracked.txt'), 'tracked');
  await runGit(dir, ['add', 'tracked.txt']);
  await runGit(dir, ['commit', '-m', 'init']);
  fixtureDir = dir;
  cleanupFixture = async () => {
    await rm(dir, { recursive: true, force: true });
  };

  running = await startControllerServer({
    host: '127.0.0.1',
    port: 0,
    db,
    identity,
    dataDir,
    allowedProjectRoots: [fixtureDir],
    allowedArtifactDestinations: [artifactDestRoot],
    maxConcurrentJobs: 2,
  });
});

afterAll(async () => {
  await running.close();
  await new Promise((r) => setTimeout(r, 500));
  await cleanupFixture();
  await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await rm(artifactDestRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}, 180_000);

async function connectHttpClient(clientId: string): Promise<Client> {
  const client = new Client({ name: 'phase8-http', version: '0.0.1' });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${running.port}/mcp`),
    { requestInit: { headers: { 'x-rbo-client-id': clientId } } },
  );
  await client.connect(transport);
  return client;
}

async function writeEvidence(
  transport: string,
  result: Parameters<typeof renderSmokeEvidence>[1],
): Promise<void> {
  const evidenceDir = join(process.cwd(), 'docs', 'compatibility', 'evidence');
  await mkdir(evidenceDir, { recursive: true });
  const path = join(evidenceDir, `test-mcp-client-${transport === 'stdio' ? 'stdio' : 'http'}.md`);
  await writeFile(path, renderSmokeEvidence(transport, result), 'utf8');
}

async function connectStdioClient(clientId: string): Promise<Client> {
  const proxy = createStdioProxyServer({
    controllerUrl: `http://127.0.0.1:${running.port}`,
    clientId,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await proxy.connect(serverTransport);
  const client = new Client({ name: 'phase8-stdio', version: '0.0.1' });
  await client.connect(clientTransport);
  return client;
}

describe('MCP smoke workflow harness', () => {
  it('runs submit→wait→logs→artifacts→materialize over Streamable HTTP', async () => {
    const client = await connectHttpClient('phase8-http-smoke');
    const dest = join(artifactDestRoot, 'http-out.txt');
    const result = await runPhase8SmokeWorkflow(client, fixtureDir, {
      waitSeconds: 60,
      artifactDestPath: dest,
    });
    expect(result.jobId).toMatch(/^job_/);
    expect(result.artifactIds.length).toBeGreaterThan(0);
    expect(result.logBytes).toBeGreaterThanOrEqual(0);
    expect((await readFile(dest, 'utf8')).trim()).toBe('phase8-artifact');
    await writeEvidence('streamable_http', result);
    await client.close();
  }, 120_000);

  it('runs the same smoke workflow over stdio proxy', async () => {
    const client = await connectStdioClient('phase8-stdio-smoke');
    const dest = join(artifactDestRoot, 'stdio-out.txt');
    const result = await runPhase8SmokeWorkflow(client, fixtureDir, {
      waitSeconds: 60,
      artifactDestPath: dest,
    });
    expect(result.jobId).toMatch(/^job_/);
    expect(result.artifactIds.length).toBeGreaterThan(0);
    expect((await readFile(dest, 'utf8')).trim()).toBe('phase8-artifact');
    await writeEvidence('stdio', result);
    await client.close();
  }, 120_000);

  it('cancels a long-running job over HTTP', async () => {
    const client = await connectHttpClient('phase8-http-cancel');
    const request = longRunningCancelJobRequest(fixtureDir);
    const submit = JSON.parse(
      textOf(await client.callTool({ name: 'job_submit', arguments: request })),
    );
    expect(submit.job_id).toBeTruthy();
    const cancel = JSON.parse(
      textOf(
        await client.callTool({
          name: 'job_cancel',
          arguments: { job_id: submit.job_id, reason: 'phase8-smoke' },
        }),
      ),
    );
    expect(cancel.cancel_requested).toBe(true);
    const waited = JSON.parse(
      textOf(
        await client.callTool({
          name: 'job_wait',
          arguments: { job_id: submit.job_id, wait_seconds: 60 },
        }),
      ),
    );
    expect(waited.job.state).toBe('completed');
    expect(waited.job.outcome).toBe('cancelled');
    await client.close();
  }, 120_000);

  it('rejects malformed job_submit input on both transports via shared Zod', async () => {
    const http = await connectHttpClient('phase8-http-bad');
    const stdio = await connectStdioClient('phase8-stdio-bad');
    const badArgs = {
      client_request_id: 'bad',
      name: 'x',
      source: { project_root: 123, cwd: '.' },
      execution: { shell: 'powershell', script: 'echo hi' },
      risk_level: 'safe',
    };

    const viaHttp = await http.callTool({ name: 'job_submit', arguments: badArgs });
    const viaStdio = await stdio.callTool({ name: 'job_submit', arguments: badArgs });
    expect(viaHttp.isError).toBe(true);
    expect(viaStdio.isError).toBe(true);
    expect(textOf(viaHttp)).toMatch(/Expected string|invalid_type/i);
    expect(textOf(viaStdio)).toMatch(/Expected string|invalid_type/i);

    await http.close();
    await stdio.close();
  });

  it("persisted evidence files carry this run's real transcript, not a template, and no secrets", async () => {
    // The two workflow tests above already wrote these files from their own real transcripts
    // (see writeEvidence / renderSmokeEvidence) — this only audits what actually landed on disk.
    const evidenceDir = join(process.cwd(), 'docs', 'compatibility', 'evidence');
    const stdioPath = join(evidenceDir, 'test-mcp-client-stdio.md');
    const httpPath = join(evidenceDir, 'test-mcp-client-http.md');
    await access(stdioPath);
    await access(httpPath);
    const stdioBody = await readFile(stdioPath, 'utf8');
    const httpBody = await readFile(httpPath, 'utf8');
    for (const body of [stdioBody, httpBody]) {
      expect(body).toMatch(/job_id: job_/);
      expect(body).toMatch(/## Raw call transcript/);
      expect(body).toMatch(/job_submit/);
      expect(body).toMatch(/artifact_materialize/);
    }
    expect(stdioBody).toMatch(/transport: stdio/);
    expect(httpBody).toMatch(/transport: streamable_http/);
    const combined = stdioBody + httpBody;
    expect(combined).not.toMatch(/BEGIN (OPENSSH |RSA )?PRIVATE KEY/);
    expect(combined).not.toMatch(/[A-Za-z]:\\Users\\/);
  });
});
