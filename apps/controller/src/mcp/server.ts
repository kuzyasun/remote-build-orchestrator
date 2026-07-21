import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MCP_TOOL_DEFS } from '@rbo/protocol';
import { RBO_CONTROLLER_VERSION } from '@rbo/shared';
import type { ToolContext } from './handlers.js';
import { handleToolCall } from './handlers.js';

export function buildMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({
    name: 'rbo-controller',
    version: RBO_CONTROLLER_VERSION,
  });

  for (const def of MCP_TOOL_DEFS) {
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: def.inputShape },
      async (args: Record<string, unknown>, extra) => {
        const toolCtx: ToolContext =
          def.name === 'job_run'
            ? {
                ...ctx,
                jobRunOptions: {
                  onProgress: async (update) => {
                    const progressToken = extra._meta?.progressToken;
                    if (progressToken === undefined) {
                      return;
                    }
                    await extra.sendNotification({
                      method: 'notifications/progress',
                      params: {
                        progressToken,
                        progress: update.progress,
                        message: update.message,
                      },
                    });
                  },
                },
              }
            : ctx;
        const result = await handleToolCall(toolCtx, def.name, args);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      },
    );
  }

  return server;
}
