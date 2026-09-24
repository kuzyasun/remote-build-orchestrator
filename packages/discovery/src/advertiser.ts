import os from 'node:os';
import { Bonjour } from 'bonjour-service';
import {
  RBO_MDNS_DEFAULT_DISPLAY_NAME,
  RBO_MDNS_SERVICE_TYPE,
  RBO_MDNS_TXT_VERSION,
} from './constants.js';

export interface AdvertiserOptions {
  /** Agent-plane port (typically 7411). */
  port: number;
  /** Controller ID (e.g. `controller_01J...`). */
  controllerId: string;
  /** TLS certificate fingerprint (`sha256:<hex>`). */
  fingerprint: string;
  /** mDNS instance display name. Default: `'rbo-controller'`. */
  displayName?: string;
  /** Optional specific network interface IP to advertise over (e.g. Wi-Fi IP). */
  interface?: string;
}

/**
 * Pick the best routable LAN interface IP address for multicast advertisement.
 * Prefers physical LAN (192.168.x.x, 10.x.x.x, 172.16-31.x.x), avoids virtual
 * adapters (WSL, Hyper-V, Docker, vEthernet, bridge), and avoids loopback.
 */
export function getPreferredMdnsInterface(): string | undefined {
  const ifaces = os.networkInterfaces();
  const candidates: { name: string; address: string; isVirtual: boolean; isLan: boolean }[] = [];

  for (const [name, list] of Object.entries(ifaces)) {
    if (!list) continue;
    const lowerName = name.toLowerCase();
    const isVirtual =
      lowerName.includes('vethernet') ||
      lowerName.includes('wsl') ||
      lowerName.includes('hyper-v') ||
      lowerName.includes('docker') ||
      lowerName.includes('virbr') ||
      lowerName.includes('tap') ||
      lowerName.includes('tun') ||
      lowerName.includes('vmnet');

    for (const iface of list) {
      if (iface.internal || iface.family !== 'IPv4') {
        continue;
      }
      const addr = iface.address;
      if (addr.startsWith('127.') || addr.startsWith('169.254.')) {
        continue;
      }
      candidates.push({
        name,
        address: addr,
        isVirtual,
        isLan:
          addr.startsWith('192.168.') ||
          addr.startsWith('10.') ||
          /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(addr),
      });
    }
  }

  // 1. Physical LAN adapter (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
  const physicalLan = candidates.find((c) => !c.isVirtual && c.isLan);
  if (physicalLan) return physicalLan.address;

  // 2. Any non-virtual physical adapter
  const physicalOther = candidates.find((c) => !c.isVirtual);
  if (physicalOther) return physicalOther.address;

  // 3. Fallback to any candidate
  return candidates[0]?.address;
}

/**
 * Attaches an 'error' handler to the underlying multicast-dns EventEmitter
 * to prevent uncaught socket errors (EADDRINUSE, EACCES, interface shifts)
 * from crashing the Node.js process.
 */
export function suppressMdnsErrors(bonjour: Bonjour): void {
  // bonjour-service encapsulates its internal server.mdns instance (a multicast-dns
  // EventEmitter) without exposing public TypeScript definitions for it. The cast
  // below is intentional and necessary to hook directly into the UDP socket's error
  // emitter, preventing unhandled error events from terminating the Node.js process.
  const mdnsEmitter = (
    bonjour as unknown as {
      server?: { mdns?: { on?: (event: string, cb: (err: unknown) => void) => void } };
    }
  )?.server?.mdns;
  if (typeof mdnsEmitter?.on === 'function') {
    mdnsEmitter.on('error', () => {
      // Suppress unhandled UDP socket errors so they do not crash the process.
    });
  }
}

/**
 * Validate a DNS-SD service instance name (RFC 6763 §4.1.1).
 *
 * Rules:
 * - Must be non-empty after trim.
 * - Must be at most 63 bytes in UTF-8 (DNS label limit).
 * - Must not contain control characters (0x00-0x1F, 0x7F-0x9F).
 */
export function validateMdnsDisplayName(name: string, label = 'mDNS display name'): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) {
    throw new Error(`Invalid ${label}: cannot be empty`);
  }
  const byteLength = Buffer.byteLength(trimmed, 'utf8');
  if (byteLength > 63) {
    throw new Error(
      `Invalid ${label}: exceeds 63 bytes (RFC 6763 §4.1.1, got ${byteLength} bytes): ${JSON.stringify(trimmed)}`,
    );
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control character rejection
  if (/[\x00-\x1f\x7f-\x9f]/.test(trimmed)) {
    throw new Error(
      `Invalid ${label}: cannot contain control characters: ${JSON.stringify(trimmed)}`,
    );
  }
  return trimmed;
}

/**
 * Advertises the Controller on the local network via mDNS/DNS-SD (§7.2).
 *
 * Publishes a `_rbo-controller._tcp` service with TXT records containing
 * the controller ID, TLS fingerprint, and protocol version. mDNS is used
 * solely for discovery — authentication remains mandatory.
 */
export class ControllerAdvertiser {
  private bonjour: Bonjour | null = null;
  private stopPromise: Promise<void> | null = null;

  /**
   * Start advertising the controller service. Idempotent — calling `start()`
   * again after a previous `start()` without `stop()` is a no-op.
   */
  start(options: AdvertiserOptions): void {
    if (this.bonjour) {
      return;
    }

    const name = validateMdnsDisplayName(
      options.displayName ?? RBO_MDNS_DEFAULT_DISPLAY_NAME,
      'displayName',
    );

    const iface = options.interface || getPreferredMdnsInterface();

    this.bonjour = new Bonjour(
      (iface ? { interface: iface } : undefined) as unknown as undefined,
      () => {
        // Suppress unhandled mDNS UDP socket query errors.
      },
    );
    suppressMdnsErrors(this.bonjour);

    this.bonjour.publish({
      name,
      type: RBO_MDNS_SERVICE_TYPE,
      port: options.port,
      probe: false,
      txt: {
        version: RBO_MDNS_TXT_VERSION,
        tls: '1',
        pairing: 'required',
        controller_id: options.controllerId,
        fingerprint: options.fingerprint,
      },
    });
  }

  /**
   * Stop advertising and tear down mDNS resources.
   * Sends a goodbye packet (TTL=0) so clients clear their caches.
   */
  async stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    const instance = this.bonjour;
    if (!instance) {
      return;
    }

    this.stopPromise = new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          this.bonjour = null;
          this.stopPromise = null;
          resolve();
        }
      };

      // Hard 2-second timeout guarantees stop resolves even if unpublishAll or destroy hangs
      const hardTimer = setTimeout(finish, 2_000);
      if (typeof hardTimer === 'object' && 'unref' in hardTimer) {
        hardTimer.unref();
      }

      try {
        instance.unpublishAll(() => {
          try {
            instance.destroy(() => {
              clearTimeout(hardTimer);
              finish();
            });
          } catch {
            clearTimeout(hardTimer);
            finish();
          }
        });
      } catch {
        try {
          instance.destroy(() => {
            clearTimeout(hardTimer);
            finish();
          });
        } catch {
          clearTimeout(hardTimer);
          finish();
        }
      }
    });

    return this.stopPromise;
  }
}
