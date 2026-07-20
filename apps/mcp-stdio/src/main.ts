import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createStdioProxyServer } from './proxy.js';

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index + 1 >= process.argv.length) {
    return undefined;
  }
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const controllerUrl =
    argValue('--controller') ?? process.env.RBO_CONTROLLER_URL ?? 'http://127.0.0.1:7410';
  const clientId =
    argValue('--client-id') ?? process.env.RBO_CLIENT_ID ?? `mcp-stdio-${process.pid}`;

  const server = createStdioProxyServer({ controllerUrl, clientId });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only: stdout belongs to the MCP protocol.
  console.error(`rbo mcp-stdio connected to ${controllerUrl} as ${clientId}`);
}

main().catch((error) => {
  console.error(`rbo mcp-stdio failed: ${String(error)}`);
  process.exit(1);
});
