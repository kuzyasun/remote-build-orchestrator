import { type ChildProcess, spawn } from 'node:child_process';
import dns from 'node:dns';
import type { DiscoverOptions, DiscoveredController } from './browser.js';
import { RBO_MDNS_SERVICE_TYPE, RBO_MDNS_TXT_VERSION } from './constants.js';

/**
 * Result of resolving a DNS-SD service instance.
 */
export interface DnsSdResolvedService {
  host: string;
  port: number;
  txt: Record<string, string>;
}

/**
 * Control characters regex (RFC 6763 / safety).
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control character rejection
const CONTROL_CHARS_REGEX = /[\x00-\x1f\x7f-\x9f]/;

/**
 * Parse a single line from `dns-sd -B <type>` output.
 * Output format from Apple's dns-sd.c:
 * Timestamp     A/R Flags if Domain  Service Type          Instance Name
 * 23:18:17.580  Add     2 15 local.  _rbo-controller._tcp. rbo-controller
 */
export function parseDnsSdBrowseLine(
  line: string,
): { instanceName: string; serviceType: string; domain: string } | null {
  const trimmed = line.trim();
  if (
    !trimmed ||
    trimmed.startsWith('DATE:') ||
    trimmed.startsWith('Browsing') ||
    trimmed.includes('...STARTING...') ||
    trimmed.startsWith('Timestamp')
  ) {
    return null;
  }

  // Look for Add records: ignore Rmv or other operations
  const match = trimmed.match(/\bAdd\s+\S+\s+\S+\s+(\S+)\s+(\S+)\s+(.+)$/);
  if (!match) {
    return null;
  }

  const domain = match[1];
  const serviceType = match[2];
  const instanceName = match[3].trim();

  if (!instanceName || CONTROL_CHARS_REGEX.test(instanceName)) {
    return null;
  }

  return { instanceName, serviceType, domain };
}

/**
 * Parse the output of `dns-sd -L <instance> <type> <domain>`.
 * Output format from Apple's dns-sd.c resolve_reply / ShowTXTRecord:
 * Lookup rbo-controller._rbo-controller._tcp.local.
 * DATE: ...
 * 23:18:17.580  rbo-controller._rbo-controller._tcp.local. can be reached at My-PC.local.:7411 (interface 15)
 *  version=1 tls=1 pairing=required controller_id=controller_01... fingerprint=sha256:...
 */
export function parseDnsSdResolveOutput(output: string): DnsSdResolvedService | null {
  const lines = output.split(/\r?\n/);
  let host: string | null = null;
  let port: number | null = null;
  const txt: Record<string, string> = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const reachMatch = trimmed.match(/can be reached at\s+([^:\s]+):(\d+)/i);
    if (reachMatch) {
      host = reachMatch[1].replace(/\.+$/, '');
      const parsedPort = Number.parseInt(reachMatch[2], 10);
      if (!Number.isNaN(parsedPort) && parsedPort > 0 && parsedPort <= 65535) {
        port = parsedPort;
      }
      continue;
    }

    if (
      trimmed.startsWith('DATE:') ||
      trimmed.startsWith('Lookup') ||
      trimmed.includes('...STARTING...') ||
      trimmed.startsWith('Timestamp')
    ) {
      continue;
    }

    // Parse TXT records: ShowTXTRecord prints tokens separated by spaces or newlines: key=val
    const tokens = trimmed.split(/\s+/);
    for (const token of tokens) {
      const eqIdx = token.indexOf('=');
      if (eqIdx > 0) {
        const key = token.slice(0, eqIdx).toLowerCase();
        const val = token.slice(eqIdx + 1);
        txt[key] = val;
      }
    }
  }

  if (!host || !port) {
    return null;
  }

  return { host, port, txt };
}

/**
 * Parse an IP address from `dns-sd -G v4 <hostname>` output line.
 * Format:
 * Timestamp     A/R Flags if Hostname          Address          TTL
 * 23:18:17.580  Add     2 15 My-PC.local.      192.168.0.102    120
 */
export function parseDnsSdGetAddrInfoLine(line: string): string | null {
  const trimmed = line.trim();
  const match = trimmed.match(/\bAdd\s+\S+\s+\S+\s+\S+\s+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/);
  return match ? match[1] : null;
}

/**
 * Validates resolved DNS-SD metadata and creates a DiscoveredController.
 */
export function createDiscoveredControllerFromDnsSd(
  name: string,
  resolved: DnsSdResolvedService,
  addresses: string[],
): DiscoveredController | null {
  const { host, port, txt } = resolved;
  const controllerId = (txt.controller_id ?? '').trim();
  const fingerprint = (txt.fingerprint ?? '').trim();
  const version = (txt.version ?? '').trim();

  if (
    !controllerId ||
    !fingerprint ||
    version !== RBO_MDNS_TXT_VERSION ||
    CONTROL_CHARS_REGEX.test(controllerId) ||
    CONTROL_CHARS_REGEX.test(fingerprint) ||
    CONTROL_CHARS_REGEX.test(name) ||
    CONTROL_CHARS_REGEX.test(host)
  ) {
    return null;
  }

  return {
    name,
    host,
    addresses,
    port,
    controllerId,
    fingerprint,
    version,
    responderAddress: addresses[0],
  };
}

/**
 * Resolve IP addresses for a hostname using libc getaddrinfo (which queries mDNSResponder
 * on macOS for `.local` hostnames) and falls back to `dns-sd -G v4`.
 */
export async function resolveHostAddresses(host: string, timeoutMs = 2_000): Promise<string[]> {
  const addresses: string[] = [];

  // 1. Try standard Node.js dns.lookup (uses macOS libc getaddrinfo for .local)
  try {
    const lookupPromise = dns.promises.lookup(host, { all: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<dns.LookupAddress[]>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      timer.unref?.();
    });

    const entries = await Promise.race([lookupPromise, timeoutPromise]);
    if (timer) clearTimeout(timer);

    for (const entry of entries) {
      if (entry.address && !addresses.includes(entry.address)) {
        addresses.push(entry.address);
      }
    }
  } catch {
    // Ignore and proceed to dns-sd -G fallback
  }

  if (addresses.length > 0) {
    return addresses;
  }

  // 2. Fallback: run dns-sd -G v4 <host>
  try {
    const ip = await resolveHostViaDnsSdGetAddrInfo(host, timeoutMs);
    if (ip && !addresses.includes(ip)) {
      addresses.push(ip);
    }
  } catch {
    // Ignore
  }

  return addresses;
}

/**
 * Run `dns-sd -G v4 <hostname>` to resolve IPv4 address via mDNSResponder IPC.
 */
export function resolveHostViaDnsSdGetAddrInfo(
  host: string,
  timeoutMs = 2_000,
): Promise<string | null> {
  return new Promise((resolve) => {
    let proc: ChildProcess | null = null;
    let settled = false;

    const cleanup = (ip: string | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (proc) {
        try {
          proc.kill('SIGTERM');
        } catch {
          // Ignore kill errors
        }
      }
      resolve(ip);
    };

    const timer = setTimeout(() => cleanup(null), timeoutMs);
    timer.unref?.();

    try {
      proc = spawn('/usr/bin/dns-sd', ['-G', 'v4', host], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });

      proc.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        const lines = text.split(/\r?\n/);
        for (const line of lines) {
          const ip = parseDnsSdGetAddrInfoLine(line);
          if (ip) {
            cleanup(ip);
            return;
          }
        }
      });

      proc.on('error', () => cleanup(null));
      proc.on('close', () => cleanup(null));
    } catch {
      cleanup(null);
    }
  });
}

/**
 * Run `dns-sd -L <instance> <type> <domain>` to resolve port and TXT records.
 */
export function resolveServiceViaDnsSd(
  instanceName: string,
  serviceType: string,
  domain: string,
  timeoutMs = 2_500,
): Promise<DnsSdResolvedService | null> {
  return new Promise((resolve) => {
    let proc: ChildProcess | null = null;
    let accumulated = '';
    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (proc) {
        try {
          proc.kill('SIGTERM');
        } catch {
          // Ignore
        }
      }
      const parsed = parseDnsSdResolveOutput(accumulated);
      resolve(parsed);
    };

    const timer = setTimeout(cleanup, timeoutMs);
    timer.unref?.();

    try {
      proc = spawn('/usr/bin/dns-sd', ['-L', instanceName, serviceType, domain], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });

      proc.stdout?.on('data', (chunk: Buffer) => {
        accumulated += chunk.toString('utf8');
        // If we already have "can be reached at" AND controller_id in accumulated output, resolve early
        if (
          accumulated.includes('can be reached at') &&
          accumulated.toLowerCase().includes('controller_id=')
        ) {
          cleanup();
        }
      });

      proc.on('error', () => cleanup());
      proc.on('close', () => cleanup());
    } catch {
      cleanup();
    }
  });
}

/**
 * Browse for RBO controllers using macOS native `/usr/bin/dns-sd` utility.
 * Talks directly to `mDNSResponder` via IPC, bypassing all UDP 5353 port binding conflicts.
 */
export async function discoverControllersViaDnsSd(
  options?: DiscoverOptions,
  onController?: (controller: DiscoveredController) => void,
): Promise<DiscoveredController[]> {
  const timeoutMs = options?.timeoutMs ?? 3_000;
  const signal = options?.signal;

  if (signal?.aborted) {
    return [];
  }

  return new Promise<DiscoveredController[]>((resolve) => {
    const discovered = new Map<string, DiscoveredController>();
    const resolving = new Set<string>();
    let browseProc: ChildProcess | null = null;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let signalListener: (() => void) | null = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal && signalListener) {
        signal.removeEventListener('abort', signalListener);
      }
      if (browseProc) {
        try {
          browseProc.kill('SIGTERM');
        } catch {
          // Ignore
        }
      }
      resolve([...discovered.values()]);
    };

    if (signal) {
      signalListener = () => finish();
      signal.addEventListener('abort', signalListener, { once: true });
    }

    timer = setTimeout(finish, timeoutMs);
    timer.unref?.();

    try {
      browseProc = spawn('/usr/bin/dns-sd', ['-B', `_${RBO_MDNS_SERVICE_TYPE}._tcp`], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });

      let browseBuffer = '';

      browseProc.stdout?.on('data', (chunk: Buffer) => {
        browseBuffer += chunk.toString('utf8');
        const lines = browseBuffer.split(/\r?\n/);
        browseBuffer = lines.pop() ?? '';

        for (const line of lines) {
          const parsed = parseDnsSdBrowseLine(line);
          if (!parsed) continue;

          const key = `${parsed.instanceName}|${parsed.serviceType}|${parsed.domain}`;
          if (resolving.has(key)) continue;
          resolving.add(key);

          // Resolve this instance asynchronously
          resolveServiceViaDnsSd(
            parsed.instanceName,
            parsed.serviceType,
            parsed.domain,
            Math.min(timeoutMs, 2_500),
          )
            .then(async (resolved) => {
              if (!resolved) return;
              const addresses = await resolveHostAddresses(resolved.host, 1_500);
              const ctrl = createDiscoveredControllerFromDnsSd(
                parsed.instanceName,
                resolved,
                addresses,
              );
              if (ctrl && !discovered.has(ctrl.controllerId)) {
                discovered.set(ctrl.controllerId, ctrl);
                onController?.(ctrl);
              }
            })
            .catch(() => {
              // Ignore resolution errors
            });
        }
      });

      browseProc.on('error', () => {
        finish();
      });

      browseProc.on('close', () => {
        finish();
      });
    } catch {
      finish();
    }
  });
}
