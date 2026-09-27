import { isRoutableIpAddress, selectBestAddress } from './address.js';
import type { DiscoveredController } from './browser.js';

/** Agent-plane WebSocket URL for a controller found via mDNS. */
export function controllerAgentUrl(controller: DiscoveredController): string {
  const rawAddr = selectBestAddress(
    controller.addresses,
    controller.host,
    controller.responderAddress,
  );
  const hostPart = rawAddr.includes(':') && !rawAddr.startsWith('[') ? `[${rawAddr}]` : rawAddr;
  return `wss://${hostPart}:${controller.port}/agent`;
}

/** True when the URL host is a unicast address the agent can dial directly. */
export function agentUrlHasRoutableIp(url: string): boolean {
  try {
    return isRoutableIpAddress(new URL(url).hostname);
  } catch {
    return false;
  }
}
