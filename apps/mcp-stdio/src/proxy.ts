import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MCP_TOOL_DEFS } from '@rbo/protocol';
import { RBO_STDIO_ADAPTER_VERSION } from '@rbo/shared';

export interface StdioProxyOptions {
  controllerUrl: string;
  clientId: string;
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
      async (args: Record<string, unknown>) => {
        const response = await fetch(`${baseUrl}/internal/v1/tools/${def.name}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-rbo-client-id': options.clientId,
            'x-rbo-client-transport': 'stdio',
          },
          body: JSON.stringify(args ?? {}),
        });
        const text = await response.text();
        return {
          content: [{ type: 'text' as const, text }],
          isError: !response.ok,
        };
      },
    );
  }

  return server;
}
