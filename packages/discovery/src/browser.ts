import { Bonjour, type Service } from 'bonjour-service';
import { suppressMdnsErrors } from './advertiser.js';
import {
  RBO_MDNS_BROWSE_TIMEOUT_MS,
  RBO_MDNS_SERVICE_TYPE,
  RBO_MDNS_TXT_VERSION,
} from './constants.js';

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
  /** Resolved IP address of the UDP responder that delivered the advertisement. */
  responderAddress?: string;
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
  const rawControllerId = txtValue(txt, 'controller_id');
  const rawFingerprint = txtValue(txt, 'fingerprint');
  const rawVersion = txtValue(txt, 'version');
  const controllerId = rawControllerId.trim();
  const fingerprint = rawFingerprint.trim();
  const version = rawVersion.trim();

  // Control characters regex (including ESC, newlines, tabs, and C1 controls)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional mDNS control character rejection
  const hasControlChars = (s: string) => /[\x00-\x1f\x7f-\x9f]/.test(s);

  // Skip services missing required TXT fields, with incompatible protocol version,
  // or containing control characters in identity/fingerprint/name/host fields.
  if (
    !controllerId ||
    !fingerprint ||
    version !== RBO_MDNS_TXT_VERSION ||
    hasControlChars(rawControllerId) ||
    hasControlChars(rawFingerprint) ||
    hasControlChars(service.name ?? '') ||
    hasControlChars(service.host ?? '')
  ) {
    return null;
  }

  if (typeof service.port !== 'number' || service.port <= 0 || service.port > 65535) {
    return null;
  }

  const rawAddresses = Array.isArray(service.addresses) ? service.addresses : [];
  const addresses = rawAddresses.filter(
    (a): a is string => typeof a === 'string' && a.length > 0 && !hasControlChars(a),
  );
  const refererRaw = (service as unknown as { referer?: { address?: string } }).referer?.address;
  const refererAddr =
    typeof refererRaw === 'string' && !hasControlChars(refererRaw) ? refererRaw : undefined;
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
    responderAddress: refererAddr,
  };
}

import { discoverControllersViaDnsSd } from './dnssd.js';

/**
 * Internal browse helper using bonjour-service.
 */
function discoverViaBonjour(
  options: DiscoverOptions | undefined,
  timeoutMs: number,
  onController: (ctrl: DiscoveredController) => void,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const signal = options?.signal;
    if (signal?.aborted) {
      resolve();
      return;
    }

    const bonjour = new Bonjour(undefined, () => {
      // Suppress unhandled mDNS UDP socket errors during browse.
    });
    suppressMdnsErrors(bonjour);

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
          const ctrl = serviceToController(s);
          if (ctrl) onController(ctrl);
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
      resolve();
    };

    if (signal) {
      signalAbortListener = () => cleanup();
      signal.addEventListener('abort', signalAbortListener, { once: true });
    }

    try {
      const b = bonjour.find({ type: RBO_MDNS_SERVICE_TYPE }, (s) => {
        const ctrl = serviceToController(s);
        if (ctrl) onController(ctrl);
      });
      browser = b as unknown as BonjourBrowser;
      browser.on('txt-update', (service: Service) => {
        const ctrl = serviceToController(service);
        if (ctrl) onController(ctrl);
      });
      browser.on('srv-update', (service: Service) => {
        const ctrl = serviceToController(service);
        if (ctrl) onController(ctrl);
      });
    } catch {
      // Return immediately if multicast interface fails to bind.
      cleanup();
      return;
    }

    timer = setTimeout(cleanup, timeoutMs);
  });
}

/**
 * Browse the local network for RBO controllers via mDNS/DNS-SD (§7.2).
 *
 * Returns after `timeoutMs` (or upon signal abort) with all controllers discovered.
 * Runs `bonjour-service` across platforms, and on macOS (`darwin`) concurrently runs
 * native `/usr/bin/dns-sd` via IPC with `mDNSResponder`, avoiding UDP 5353 port
 * binding conflicts. Deduplicates controllers by `controllerId`.
 */
export async function discoverControllers(
  options?: DiscoverOptions,
): Promise<DiscoveredController[]> {
  const timeoutMs = options?.timeoutMs ?? RBO_MDNS_BROWSE_TIMEOUT_MS;
  const signal = options?.signal;

  if (signal?.aborted) {
    return [];
  }

  const seen = new Map<string, DiscoveredController>();
  const onController = (ctrl: DiscoveredController) => {
    if (ctrl && !seen.has(ctrl.controllerId)) {
      seen.set(ctrl.controllerId, ctrl);
    }
  };

  const tasks: Promise<unknown>[] = [discoverViaBonjour(options, timeoutMs, onController)];

  if (process.platform === 'darwin') {
    tasks.push(
      discoverControllersViaDnsSd(options, onController).catch(() => {
        // Suppress native discovery errors; bonjour-service runs in parallel
      }),
    );
  }

  await Promise.all(tasks);

  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}
