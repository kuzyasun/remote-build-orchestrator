import {
  type DiscoverOptions,
  type DiscoveredController,
  agentUrlHasRoutableIp,
  controllerAgentUrl,
  discoverControllers,
  isRoutableIpAddress,
} from '@rbo/discovery';

/** How often a running agent re-browses mDNS for the pinned controller. */
export const CONTROLLER_MDNS_REFRESH_INTERVAL_MS = 60_000;

/**
 * New agent-plane URL when mDNS shows the pinned controller at a different routable address.
 * A hostname-only advertisement is ignored so a live IP is not replaced by `name.local`.
 * An address that is still present in the same advertisement is kept, so a multi-homed
 * controller does not flap between interfaces when the responder IP changes.
 * Other controllers (different fingerprint) are ignored. The stored credential stays valid.
 */
export function relocatedControllerUrl(
  currentUrl: string,
  fingerprint: string,
  controllers: DiscoveredController[],
): string | undefined {
  const want = fingerprint.trim().toLowerCase();
  if (!want) {
    return undefined;
  }
  const match = controllers.find(
    (controller) => controller.fingerprint.trim().toLowerCase() === want,
  );
  if (!match) {
    return undefined;
  }

  const current = parseAgentPlaneUrl(currentUrl);
  const advertised = routableAdvertisedHosts(match);
  if (current && advertised.has(current.host)) {
    if (current.port === match.port) {
      return undefined;
    }
    const sameHost = agentPlaneUrl(current.host, match.port);
    return sameHost === currentUrl.trim() ? undefined : sameHost;
  }

  const next = controllerAgentUrl(match);
  if (!agentUrlHasRoutableIp(next) || next === currentUrl.trim()) {
    return undefined;
  }
  return next;
}

function routableAdvertisedHosts(controller: DiscoveredController): Set<string> {
  const values = [...controller.addresses];
  if (controller.responderAddress) {
    values.push(controller.responderAddress);
  }
  const hosts = new Set<string>();
  for (const value of values) {
    const normalized = value.replace(/^::ffff:/i, '');
    if (isRoutableIpAddress(normalized)) {
      hosts.add(normalized.toLowerCase());
    }
  }
  return hosts;
}

function parseAgentPlaneUrl(url: string): { host: string; port: number } | undefined {
  try {
    const parsed = new URL(url.trim());
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'wss:' ? 443 : 80;
    if (!Number.isInteger(port) || port <= 0) {
      return undefined;
    }
    return {
      host: parsed.hostname.replace(/^::ffff:/i, '').toLowerCase(),
      port,
    };
  } catch {
    return undefined;
  }
}

function agentPlaneUrl(host: string, port: number): string {
  const hostPart = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `wss://${hostPart}:${port}/agent`;
}

export async function discoverRelocatedControllerUrl(options: {
  currentUrl: string;
  fingerprint: string;
  signal?: AbortSignal;
  discover?: (options?: DiscoverOptions) => Promise<DiscoveredController[]>;
}): Promise<string | undefined> {
  const discover = options.discover ?? discoverControllers;
  let controllers: DiscoveredController[];
  try {
    controllers = await discover({ signal: options.signal });
  } catch {
    return undefined;
  }
  return relocatedControllerUrl(options.currentUrl, options.fingerprint, controllers);
}
