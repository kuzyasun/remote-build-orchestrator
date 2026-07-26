import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpToolName } from '@rbo/protocol';
import { getMcpToolDef } from '@rbo/protocol';
import { RboError, createLogger } from '@rbo/shared';
import type { ControllerIdentity } from '@rbo/shared';
import { handleJobLogsStreamRequest } from '../logs/stream.js';
import type { ClientIdentity, ToolContext } from '../mcp/handlers.js';
import { handleToolCall } from '../mcp/handlers.js';
import { buildMcpServer } from '../mcp/server.js';
import type { ControllerDatabase } from '../storage/database.js';
import type { ConnectedAgent } from '../websocket/server.js';
import type { AdminContext } from './admin.js';
import { handleAdminRequest } from './admin.js';

const logger = createLogger('controller.http');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function assertLoopbackHost(host: string): void {
  if (!LOOPBACK_HOSTS.has(host)) {
    // §7.1: port 7410 MUST bind only on the loopback interface.
    throw RboError.validation(
      `MCP endpoint must bind to a loopback interface, got '${host}' (§7.1)`,
    );
  }
}

export interface ControllerServerOptions {
  host: string;
  port: number;
  db: ControllerDatabase;
  identity?: ControllerIdentity;
  connectedAgents?: Map<string, ConnectedAgent>;
  agentPlanePort?: number;
  controllerPublicHost?: string;
  dataPlaneBaseUrl?: string;
  dataDir?: string;
  allowedProjectRoots?: string[];
  allowedArtifactDestinations?: string[];
  maxConcurrentJobs?: number;
  gitAllowlist?: import('@rbo/shared').GitUrlAllowlist;
  allowLocalFallback?: boolean;
  /** Opt in to full working-tree snapshot when overlay capture is impossible. Default false. */
  allowFullSnapshotFallback?: boolean;
  /** Host-aware local fallback (docs/dev/host-aware-local-fallback-plan.md). */
  getHostCpuBusyFraction?: () => number;
  maxHostCpuBusyFraction?: number;
}

export interface RunningControllerServer {
  server: Server;
  host: string;
  port: number;
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function identityFromHeaders(
  req: IncomingMessage,
  transport: ClientIdentity['transport'],
  fallbackClientId: string,
): ClientIdentity {
  const headerId = req.headers['x-rbo-client-id'];
  const sessionId = req.headers['x-rbo-session-id'];
  return {
    client_id: typeof headerId === 'string' && headerId.length > 0 ? headerId : fallbackClientId,
    transport,
    session_id: typeof sessionId === 'string' ? sessionId : null,
  };
}

function buildToolContext(
  options: ControllerServerOptions,
  clientIdentity: ToolContext['identity'],
): ToolContext {
  return {
    db: options.db,
    identity: clientIdentity,
    dataDir: options.dataDir ?? process.env.RBO_DATA_DIR ?? '',
    controllerIdentity: options.identity,
    allowedProjectRoots: options.allowedProjectRoots,
    allowedArtifactDestinations: options.allowedArtifactDestinations,
    maxConcurrentJobs: options.maxConcurrentJobs ?? 1,
    connectedAgents: options.connectedAgents,
    agentPlanePort: options.agentPlanePort,
    controllerPublicHost: options.controllerPublicHost,
    dataPlaneBaseUrl: options.dataPlaneBaseUrl,
    gitAllowlist: options.gitAllowlist,
    allowLocalFallback: options.allowLocalFallback,
    allowFullSnapshotFallback: options.allowFullSnapshotFallback,
    getHostCpuBusyFraction: options.getHostCpuBusyFraction,
    maxHostCpuBusyFraction: options.maxHostCpuBusyFraction,
  };
}

async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: ControllerServerOptions,
): Promise<void> {
  // Stateless mode: one server/transport pair per request keeps the loopback
  // endpoint simple; job state lives in SQLite, not in MCP sessions.
  const identity = identityFromHeaders(req, 'http', 'mcp-http');
  const mcpServer = buildMcpServer(buildToolContext(options, identity));
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close();
    void mcpServer.close();
  });
  await mcpServer.connect(transport);

  let parsedBody: unknown;
  if (req.method === 'POST') {
    const raw = await readBody(req);
    try {
      parsedBody = raw.length > 0 ? JSON.parse(raw) : undefined;
    } catch {
      sendJson(res, 400, {
        jsonrpc: '2.0',
        error: { code: -32700, message: 'Parse error' },
        id: null,
      });
      return;
    }
  }
  await transport.handleRequest(req, res, parsedBody);
}

async function handleInternalToolRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: ControllerServerOptions,
  toolName: string,
): Promise<void> {
  const def = getMcpToolDef(toolName);
  if (!def) {
    sendJson(res, 404, {
      error: { category: 'validation', message: `Unknown tool '${toolName}'`, retryable: false },
    });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, {
      error: { category: 'validation', message: 'POST required', retryable: false },
    });
    return;
  }

  let args: unknown;
  try {
    const raw = await readBody(req);
    args = raw.length > 0 ? JSON.parse(raw) : {};
  } catch {
    sendJson(res, 400, {
      error: { category: 'validation', message: 'Invalid JSON body', retryable: false },
    });
    return;
  }

  const identity = identityFromHeaders(req, 'stdio', 'mcp-stdio');
  try {
    const result = await handleToolCall(
      buildToolContext(options, identity),
      def.name as McpToolName,
      args,
    );
    sendJson(res, 200, result);
  } catch (error) {
    if (error instanceof RboError) {
      sendJson(res, error.category === 'validation' ? 400 : 500, { error: error.toJSON() });
      return;
    }
    logger.error('internal tool call failed', { tool: toolName, error: String(error) });
    sendJson(res, 500, {
      error: { category: 'internal', message: 'Internal error', retryable: false },
    });
  }
}

async function handleAdminHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AdminContext,
  action: string,
): Promise<void> {
  if (req.method !== 'POST') {
    sendJson(res, 405, {
      error: { category: 'validation', message: 'POST required', retryable: false },
    });
    return;
  }
  let args: Record<string, unknown>;
  try {
    const raw = await readBody(req);
    args = raw.length > 0 ? JSON.parse(raw) : {};
  } catch {
    sendJson(res, 400, {
      error: { category: 'validation', message: 'Invalid JSON body', retryable: false },
    });
    return;
  }

  try {
    const { status, body } = await handleAdminRequest(ctx, action, args);
    sendJson(res, status, body);
  } catch (error) {
    if (error instanceof RboError) {
      sendJson(res, error.category === 'validation' ? 400 : 500, { error: error.toJSON() });
      return;
    }
    throw error;
  }
}

export async function startControllerServer(
  options: ControllerServerOptions,
): Promise<RunningControllerServer> {
  assertLoopbackHost(options.host);

  const adminCtx: AdminContext = {
    db: options.db,
    identity: options.identity,
    connectedAgents: options.connectedAgents,
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    const run = async () => {
      if (url.pathname === '/mcp') {
        await handleMcpRequest(req, res, options);
        return;
      }
      if (url.pathname.startsWith('/internal/v1/tools/')) {
        const toolName = url.pathname.slice('/internal/v1/tools/'.length);
        await handleInternalToolRequest(req, res, options, toolName);
        return;
      }
      if (url.pathname.startsWith('/internal/v1/admin/')) {
        const action = url.pathname.slice('/internal/v1/admin/'.length);
        await handleAdminHttpRequest(req, res, adminCtx, action);
        return;
      }
      if (url.pathname === '/internal/v1/health') {
        sendJson(res, 200, { ok: true });
        return;
      }

      const logStreamMatch = url.pathname.match(/^\/internal\/v1\/jobs\/([^/]+)\/logs\/stream$/);
      if (logStreamMatch) {
        const jobId = decodeURIComponent(logStreamMatch[1] ?? '');
        await handleJobLogsStreamRequest({
          req,
          res,
          db: options.db,
          dataDir: options.dataDir ?? process.env.RBO_DATA_DIR ?? '',
          jobId,
          url,
        });
        return;
      }

      sendJson(res, 404, {
        error: { category: 'validation', message: 'Not found', retryable: false },
      });
    };

    run().catch((error) => {
      logger.error('request failed', { path: url.pathname, error: String(error) });
      if (!res.headersSent) {
        if (error instanceof RboError) {
          sendJson(res, error.category === 'validation' ? 400 : 500, { error: error.toJSON() });
        } else {
          sendJson(res, 500, {
            error: { category: 'internal', message: 'Internal error', retryable: false },
          });
        }
      } else {
        res.end();
      }
    });
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(options.port, options.host, () => {
      server.removeListener('error', rejectPromise);
      resolvePromise();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;
  logger.info('controller server listening', { host: options.host, port });

  return {
    server,
    host: options.host,
    port,
    close: () =>
      new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
      }),
  };
}
