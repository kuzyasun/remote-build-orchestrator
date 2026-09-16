import { type DiscoveredController, discoverControllers } from '@rbo/discovery';
import { selectBestAddress } from './agent.js';

export interface DiscoverOptions {
  json?: boolean;
}

export function formatTable(controllers: DiscoveredController[]): string {
  if (controllers.length === 0) {
    return '';
  }

  const formattedRows = controllers.map((c) => {
    const addr = selectBestAddress(c.addresses, c.host);
    const hostPart = addr.includes(':') && !addr.startsWith('[') ? `[${addr}]` : addr;
    return {
      name: c.name,
      address: hostPart,
      port: String(c.port),
      id: c.controllerId,
      fingerprint: c.fingerprint,
    };
  });

  const maxName = Math.max(10, ...formattedRows.map((r) => r.name.length));
  const maxAddr = Math.max(16, ...formattedRows.map((r) => r.address.length));
  const maxPort = 6;
  const maxId = Math.max(14, ...formattedRows.map((r) => r.id.length));

  const header = `  ${'Name'.padEnd(maxName)} ${'Address'.padEnd(maxAddr)} ${'Port'.padEnd(maxPort)} ${'Controller ID'.padEnd(maxId)} Fingerprint`;
  const lines: string[] = [header];

  for (const r of formattedRows) {
    lines.push(
      `  ${r.name.padEnd(maxName)} ${r.address.padEnd(maxAddr)} ${r.port.padEnd(maxPort)} ${r.id.padEnd(maxId)} ${r.fingerprint}`,
    );
  }

  return lines.join('\n');
}

/**
 * Scan the local network for RBO controllers via mDNS/DNS-SD.
 * Prints a formatted table or JSON output of discovered controllers.
 */
export async function runDiscover(options: DiscoverOptions = {}): Promise<DiscoveredController[]> {
  if (!options.json) {
    console.error('Scanning for RBO controllers on local network...\n');
  }
  const controllers = await discoverControllers();

  if (options.json) {
    console.log(JSON.stringify(controllers, null, 2));
    return controllers;
  }

  if (controllers.length === 0) {
    console.error('No RBO controllers found on local network.');
    return controllers;
  }

  console.error(`Found ${controllers.length} controller(s):`);
  console.log(formatTable(controllers));
  return controllers;
}
