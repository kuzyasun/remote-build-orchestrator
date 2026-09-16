import { Bonjour, type Service } from 'bonjour-service';
import { suppressMdnsErrors } from './advertiser.js';
import { RBO_MDNS_BROWSE_TIMEOUT_MS, RBO_MDNS_SERVICE_TYPE } from './constants.js';

/** A controller discovered via mDNS/DNS-SD on the local network. */
export interface DiscoveredController {
  /** mDNS instance name (e.g. `'rbo-controller'`). */
  name: string;
  /** Resolved hostname from SRV record. */
  host: string;
  /** Resolved IPv4/IPv6 addresses from A/AAAA records. */
  addresses: string[];
  /** Agent-plane port from SRV record (typically 7411). */
  port: number;
  /** Controller ID from TXT record. */
  controllerId: string;
  /** TLS certificate fingerprint from TXT record (`sha256:<hex>`). */
  fingerprint: string;
  /** Protocol version from TXT record. */
  version: string;
}

export interface DiscoverOptions {
  /** How long to wait for mDNS responses (ms). Default: 3000. */
  timeoutMs?: number;
  /** Optional cancellation signal. */
  signal?: AbortSignal;
}

/**
 * Extracts a string value from a DNS-SD TXT record dictionary with case-insensitive key lookup (RFC 6763 §6.4).
 */
export function txtValue(txt: Record<string, unknown> | undefined, key: string): string {
  if (!txt) return '';
  const lowerKey = key.toLowerCase();
  for (const [k, v] of Object.entries(txt)) {
    if (k.toLowerCase() === lowerKey) {
      if (typeof v === 'string') return v;
      if (Buffer.isBuffer(v)) return v.toString('utf8');
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    }
  }
  return '';
}

/**
 * Validates and converts a raw Bonjour service into a DiscoveredController.
 * Returns null if required fields or port are invalid.
 */
export function serviceToController(service: Service): DiscoveredController | null {
  const txt = (service.txt ?? {}) as Record<string, unknown>;
  const controllerId = txtValue(txt, 'controller_id').trim();
  const fingerprint = txtValue(txt, 'fingerprint').trim();
  const version = txtValue(txt, 'version').trim();

  // Skip services missing required TXT fields.
  if (!controllerId || !fingerprint) {
    return null;
  }

  if (typeof service.port !== 'number' || service.port <= 0 || service.port > 65535) {
    return null;
  }

  const addresses = [...(service.addresses ?? [])];
  const refererAddr = (service as unknown as { referer?: { address?: string } }).referer?.address;
  if (refererAddr && !addresses.includes(refererAddr)) {
    addresses.push(refererAddr);
  }

  return {
    name: service.name,
    host: service.host,
    addresses,
    port: service.port,
    controllerId,
    fingerprint,
    version,
  };
}

/**
 * Browse the local network for RBO controllers via mDNS/DNS-SD (§7.2).
 *
 * Returns after `timeoutMs` (or upon signal abort) with all controllers discovered.
 * Listens to 'up', 'txt-update', and 'srv-update' events to handle multi-packet
 * mDNS responses, and deduplicates by `controllerId`.
 */
export async function discoverControllers(
  options?: DiscoverOptions,
): Promise<DiscoveredController[]> {
  const timeoutMs = options?.timeoutMs ?? RBO_MDNS_BROWSE_TIMEOUT_MS;
  const signal = options?.signal;

  if (signal?.aborted) {
    return [];
  }

  const bonjour = new Bonjour(undefined, () => {
    // Suppress unhandled mDNS UDP socket errors during browse.
  });
  suppressMdnsErrors(bonjour);

  return new Promise<DiscoveredController[]>((resolve) => {
    const seen = new Map<string, DiscoveredController>();

    const processService = (service: Service | null | undefined) => {
      if (!service) return;
      const controller = serviceToController(service);
      if (controller) {
        seen.set(controller.controllerId, controller);
      }
    };

    interface BonjourBrowser {
      on(event: string, listener: (service: Service, ...rest: unknown[]) => void): this;
      stop?(): void;
      services?: Service[];
    }

    let browser: BonjourBrowser | null = null;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let signalAbortListener: (() => void) | null = null;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signalAbortListener) signal?.removeEventListener('abort', signalAbortListener);

      // Collect all services from browser cache before closing
      if (browser && Array.isArray(browser.services)) {
        for (const s of browser.services) {
          processService(s);
        }
      }

      try {
        browser?.stop?.();
      } catch {
        // Ignore stop errors.
      }
      try {
        bonjour.destroy();
      } catch {
        // Ignore destroy errors.
      }

      const results = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
      resolve(results);
    };

    if (signal) {
      signalAbortListener = () => cleanup();
      signal.addEventListener('abort', signalAbortListener, { once: true });
    }

    try {
      const b = bonjour.find({ type: RBO_MDNS_SERVICE_TYPE }, processService);
      browser = b as unknown as BonjourBrowser;
      browser.on('txt-update', (service: Service) => processService(service));
      browser.on('srv-update', (service: Service) => processService(service));
    } catch {
      // Return empty immediately if multicast interface fails to bind.
      cleanup();
      return;
    }

    timer = setTimeout(cleanup, timeoutMs);
  });
}
