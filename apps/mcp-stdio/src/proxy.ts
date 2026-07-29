import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MCP_TOOL_DEFS } from '@rbo/protocol';
import { RBO_STDIO_ADAPTER_VERSION } from '@rbo/shared';

export interface StdioProxyOptions {
  controllerUrl: string;
  clientId: string;
}

export const STDIO_JOB_RUN_HEARTBEAT_MS = 5_000;

/** Keep MCP clients with resetTimeoutOnProgress alive during long internal job_run fetches. */
export function startProgressHeartbeat(input: {
  progressToken: string | number | undefined;
  sendNotification: (notification: {
    method: 'notifications/progress';
    params: { progressToken: string | number; progress: number; message: string };
  }) => Promise<void>;
  intervalMs?: number;
  messagePrefix?: string;
}): { stop: () => void } {
  const { progressToken, sendNotification } = input;
  if (progressToken === undefined) {
    return { stop: () => undefined };
  }
  let progress = 0;
  const prefix = input.messagePrefix ?? 'job_run';
  const timer = setInterval(() => {
    progress += 1;
    void sendNotification({
      method: 'notifications/progress',
      params: {
        progressToken,
        progress,
        message: `${prefix} waiting (heartbeat ${progress})`,
      },
    }).catch(() => undefined);
  }, input.intervalMs ?? STDIO_JOB_RUN_HEARTBEAT_MS);
  // Do not keep the process alive solely for heartbeats.
  timer.unref?.();
  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}

// Thin stdio adapter (§4.3): same shared tool registry and Zod schemas as the
// Controller's Streamable HTTP endpoint; every call is proxied to the loopback
// internal API. No database, no scheduler logic.
export function createStdioProxyServer(options: StdioProxyOptions): McpServer {
  const server = new McpServer({
    name: 'rbo-mcp-stdio',
    version: RBO_STDIO_ADAPTER_VERSION,
  });

  const baseUrl = options.controllerUrl.replace(/\/+$/, '');

  for (const def of MCP_TOOL_DEFS) {
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: def.inputShape },
      async (args: Record<string, unknown>, extra) => {
        const heartbeat =
          def.name === 'job_run'
            ? startProgressHeartbeat({
                progressToken: extra._meta?.progressToken as string | number | undefined,
                sendNotification: (notification) => extra.sendNotification(notification),
              })
            : { stop: () => undefined };

        try {
          const response = await fetch(`${baseUrl}/internal/v1/tools/${def.name}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-rbo-client-id': options.clientId,
              'x-rbo-client-transport': 'stdio',
            },
            body: JSON.stringify(args ?? {}),
            signal: extra.signal,
          });
          const text = await response.text();
          return {
            content: [{ type: 'text' as const, text }],
            isError: !response.ok,
          };
        } finally {
          heartbeat.stop();
        }
      },
    );
  }

  return server;
}
