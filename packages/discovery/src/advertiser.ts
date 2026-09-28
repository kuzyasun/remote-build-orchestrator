import os from 'node:os';
import { Bonjour } from 'bonjour-service';
import {
  RBO_MDNS_DEFAULT_DISPLAY_NAME,
  RBO_MDNS_SERVICE_TYPE,
  RBO_MDNS_TXT_VERSION,
} from './constants.js';

/** How often a live advertiser checks whether the LAN address moved. */
export const MDNS_INTERFACE_WATCH_MS = 5_000;

const MDNS_REBIND_BASE_MS = 500;
const MDNS_REBIND_MAX_MS = 30_000;

const MDNS_INTERFACE_LOST_CODES = new Set(['EADDRNOTAVAIL', 'ENETDOWN', 'ENETUNREACH', 'ENODEV']);

export interface MdnsBindInfo {
  /** Bound interface address, or undefined when no LAN interface is available. */
  interface: string | undefined;
  /** True when this socket replaces one that lost its previous address. */
  recovered: boolean;
}

export interface AdvertiserOptions {
  /** Agent-plane port (typically 7411). */
  port: number;
  /** Controller ID (e.g. `controller_01J...`). */
  controllerId: string;
  /** TLS certificate fingerprint (`sha256:<hex>`). */
  fingerprint: string;
  /** mDNS instance display name. Default: `'rbo-controller'`. */
  displayName?: string;
  /**
   * Optional specific network interface IP to advertise over (e.g. Wi-Fi IP).
   * A value that is not currently assigned is ignored; the advertiser follows
   * the current physical LAN address instead.
   */
  interface?: string;
  /** Fired after each successful publish, including rebinds. */
  onBind?: (info: MdnsBindInfo) => void;
  /** Fired when the multicast socket reports that its interface is gone. */
  onInterfaceLost?: (error: unknown) => void;
}

type InterfaceMap = NodeJS.Dict<os.NetworkInterfaceInfo[]>;

/**
 * Pick the best routable LAN interface IP address for multicast advertisement.
 * Prefers physical LAN (192.168.x.x, 10.x.x.x, 172.16-31.x.x), avoids virtual
 * adapters (WSL, Hyper-V, Docker, vEthernet, bridge), and avoids loopback.
 */
export function getPreferredMdnsInterface(
  interfaces: InterfaceMap | undefined = os.networkInterfaces(),
): string | undefined {
  const candidates: { name: string; address: string; isVirtual: boolean; isLan: boolean }[] = [];

  for (const [name, list] of Object.entries(interfaces ?? {})) {
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

/** True when `host` is currently assigned on a local interface. */
export function isAssignedLocalAddress(
  host: string,
  interfaces: InterfaceMap | undefined = os.networkInterfaces(),
): boolean {
  const normalized = host.replace(/^::ffff:/i, '').toLowerCase();
  if (!normalized) return false;
  for (const list of Object.values(interfaces ?? {})) {
    for (const iface of list ?? []) {
      if (iface.address.replace(/^::ffff:/i, '').toLowerCase() === normalized) {
        return true;
      }
    }
  }
  return false;
}

function isLoopbackAddress(host: string): boolean {
  const normalized = host.replace(/^::ffff:/i, '').toLowerCase();
  return normalized === '::1' || normalized.startsWith('127.');
}

/**
 * Interface address passed to bonjour-service.
 * An explicit address is used only while it is assigned. Otherwise the current
 * physical LAN address is selected, so a stale DHCP pin cannot kill the socket.
 */
export function resolveMdnsBindAddress(
  requested: string | undefined,
  interfaces: InterfaceMap | undefined = os.networkInterfaces(),
): string | undefined {
  if (requested && !isLoopbackAddress(requested) && isAssignedLocalAddress(requested, interfaces)) {
    return requested;
  }
  return getPreferredMdnsInterface(interfaces);
}

/** Socket errors that mean the bound address disappeared (DHCP, interface down). */
export function isMdnsInterfaceLostError(err: unknown): boolean {
  if (!err || typeof err !== 'object' || !('code' in err)) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && MDNS_INTERFACE_LOST_CODES.has(code);
}

/**
 * Attaches handlers to the underlying multicast-dns EventEmitter so uncaught
 * socket errors (EADDRINUSE, EACCES, interface shifts) do not crash the process.
 * `onError` is invoked for every suppressed error and warning.
 */
export function suppressMdnsErrors(bonjour: Bonjour, onError?: (err: unknown) => void): void {
  // bonjour-service encapsulates its internal server.mdns instance (a multicast-dns
  // EventEmitter) without exposing public TypeScript definitions for it. The cast
  // below is intentional and necessary to hook directly into the UDP socket's error
  // emitter, preventing unhandled error events from terminating the Node.js process.
  const mdnsEmitter = (
    bonjour as unknown as {
      server?: {
        mdns?: { on?: (event: string, cb: (err: unknown) => void) => void };
      };
    }
  )?.server?.mdns;
  if (typeof mdnsEmitter?.on !== 'function') return;
  const handler = (err: unknown) => {
    onError?.(err);
  };
  // addMembership(EADDRNOTAVAIL) is emitted as `warning`, not `error`.
  mdnsEmitter.on('error', handler);
  mdnsEmitter.on('warning', handler);
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
 *
 * The multicast socket follows the current physical LAN address. When that
 * address disappears, the advertiser tears the socket down and binds again.
 */
export class ControllerAdvertiser {
  private bonjour: Bonjour | null = null;
  private stopPromise: Promise<void> | null = null;
  private options: AdvertiserOptions | null = null;
  private displayName = '';
  private boundInterface: string | undefined;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private rebindTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set for the whole teardown+publish, so a second trigger cannot publish twice. */
  private rebindInFlight: Promise<void> | null = null;
  private rebindAttempts = 0;
  private generation = 0;
  private closed = false;

  /**
   * Start advertising the controller service. Idempotent — calling `start()`
   * again after a previous `start()` without `stop()` is a no-op.
   */
  start(options: AdvertiserOptions): void {
    if (this.options) {
      return;
    }

    this.displayName = validateMdnsDisplayName(
      options.displayName ?? RBO_MDNS_DEFAULT_DISPLAY_NAME,
      'displayName',
    );
    this.closed = false;
    this.rebindAttempts = 0;
    this.options = options;
    this.publish(false);
    this.ensureWatch();
  }

  /**
   * Stop advertising and tear down mDNS resources.
   * Sends a goodbye packet (TTL=0) so clients clear their caches.
   */
  async stop(): Promise<void> {
    this.closed = true;
    this.options = null;
    this.clearTimers();
    await this.teardown();
  }

  private publish(recovered: boolean): void {
    const options = this.options;
    if (!options || this.closed) return;

    const generation = ++this.generation;
    const iface = resolveMdnsBindAddress(options.interface);
    this.boundInterface = iface;

    const bonjour = new Bonjour(
      (iface ? { interface: iface } : undefined) as unknown as undefined,
      () => {
        // Response errors are also delivered through suppressMdnsErrors.
      },
    );
    this.bonjour = bonjour;
    suppressMdnsErrors(bonjour, (err) => {
      if (generation !== this.generation || this.closed) return;
      if (!isMdnsInterfaceLostError(err)) return;
      if (this.rebindTimer || this.rebindInFlight) return;
      options.onInterfaceLost?.(err);
      this.scheduleRebind();
    });

    bonjour.publish({
      name: this.displayName,
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
    options.onBind?.({ interface: iface, recovered });
  }

  private ensureWatch(): void {
    if (this.watchTimer || this.closed) return;
    this.watchTimer = setInterval(() => {
      if (this.closed || !this.options || this.rebindTimer || this.rebindInFlight) return;
      const next = resolveMdnsBindAddress(this.options.interface);
      if (next === this.boundInterface) {
        this.rebindAttempts = 0;
        return;
      }
      this.rebindAttempts = 0;
      this.scheduleRebind();
    }, MDNS_INTERFACE_WATCH_MS);
    this.watchTimer.unref?.();
  }

  private scheduleRebind(): void {
    if (this.closed || this.rebindTimer || this.rebindInFlight) return;
    const delay = Math.min(
      MDNS_REBIND_MAX_MS,
      MDNS_REBIND_BASE_MS * 2 ** Math.min(this.rebindAttempts, 6),
    );
    this.rebindAttempts += 1;
    this.rebindTimer = setTimeout(() => {
      this.rebindTimer = null;
      this.beginRebind();
    }, delay);
    this.rebindTimer.unref?.();
  }

  /**
   * One rebind at a time. The in-flight flag is set before teardown starts, so a
   * socket warning or interface watch during unpublish cannot start a second publish.
   */
  private beginRebind(): void {
    if (this.closed || !this.options || this.rebindInFlight) return;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.rebindInFlight = gate;
    void this.rebind().finally(() => {
      this.rebindInFlight = null;
      release();
    });
  }

  private async rebind(): Promise<void> {
    if (this.closed || !this.options) return;
    await this.teardown();
    if (this.closed || !this.options) return;
    this.publish(true);
  }

  private clearTimers(): void {
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
    if (this.rebindTimer) {
      clearTimeout(this.rebindTimer);
      this.rebindTimer = null;
    }
  }

  private teardown(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    const instance = this.bonjour;
    this.generation += 1;
    this.bonjour = null;
    if (!instance) {
      return Promise.resolve();
    }

    this.stopPromise = new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          this.stopPromise = null;
          resolve();
        }
      };

      // Hard 2-second timeout guarantees stop resolves even if unpublishAll or destroy hangs.
      // destroy() drops the UDP socket so a following publish does not leave the old one open.
      const hardTimer = setTimeout(() => {
        try {
          instance.destroy();
        } catch {
          // The socket may already be closed.
        }
        finish();
      }, 2_000);
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
