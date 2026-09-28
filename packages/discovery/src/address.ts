/**
 * Host/address helpers for mDNS discovery.
 * A bare computer name such as `KPC` is not an IP and does not resolve via
 * getaddrinfo; macOS mDNS answers `KPC.local`.
 */

export function isIpv4Address(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4) {
    return false;
  }
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return false;
    }
    const n = Number(part);
    return n >= 0 && n <= 255;
  });
}

export function isIpv6Address(value: string): boolean {
  if (!value.includes(':')) {
    return false;
  }
  return /^[0-9a-fA-F:]+$/.test(value);
}

export function isIpAddress(value: string): boolean {
  const normalized = value.replace(/^::ffff:/i, '');
  return isIpv4Address(normalized) || isIpv6Address(value) || isIpv4Address(value);
}

/** Unqualified mDNS names become `name.local`. IP addresses and dotted names stay as-is. */
export function normalizeMdnsHost(host: string): string {
  const trimmed = host.trim().replace(/\.+$/, '');
  if (!trimmed) {
    return trimmed;
  }
  if (isIpAddress(trimmed)) {
    return trimmed;
  }
  if (!trimmed.includes('.')) {
    return `${trimmed}.local`;
  }
  return trimmed;
}

/**
 * Names to try with getaddrinfo / `dns-sd -G`.
 * Bare hostnames are also looked up as `name.local`.
 */
export function hostLookupCandidates(host: string): string[] {
  const trimmed = host.trim().replace(/\.+$/, '');
  if (!trimmed) {
    return [];
  }
  if (isIpAddress(trimmed)) {
    return [trimmed];
  }
  if (!trimmed.includes('.')) {
    return [trimmed, `${trimmed}.local`];
  }
  return [trimmed];
}

/** RFC1918 and link-local IPv4. These addresses move when DHCP renews. */
export function isPrivateLanAddress(value: string): boolean {
  const normalized = value.replace(/^::ffff:/i, '');
  if (!isIpv4Address(normalized)) {
    return false;
  }
  return (
    normalized.startsWith('10.') ||
    normalized.startsWith('192.168.') ||
    normalized.startsWith('169.254.') ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(normalized)
  );
}

export function isRoutableIpAddress(value: string): boolean {
  const normalized = value.replace(/^::ffff:/i, '');
  if (!isIpAddress(normalized)) {
    return false;
  }
  if (
    normalized === '0.0.0.0' ||
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('127.') ||
    normalized.startsWith('169.254.') ||
    normalized.toLowerCase().startsWith('fe80:')
  ) {
    return false;
  }
  return true;
}

/**
 * Select the best routable IP address from discovered addresses.
 * Prioritizes the responder address that actually delivered the advertisement packet
 * (when it is a routable IP), then private LAN IPv4 (192.168.x.x, 10.x.x.x, 172.16-31.x.x),
 * avoids APIPA (169.254.x.x) and loopback, and handles IPv6 cleanly.
 * Hostnames are not treated as addresses. A bare fallback name becomes `name.local`.
 */
export function selectBestAddress(
  addresses: string[],
  fallbackHost: string,
  responderAddress?: string,
): string {
  const normalizedResponder = responderAddress?.replace(/^::ffff:/i, '');

  if (normalizedResponder && isRoutableIpAddress(normalizedResponder)) {
    return normalizedResponder;
  }

  const routable = (addresses ?? []).filter((address) => isRoutableIpAddress(address));

  const lan192 = routable.find((a) => a.startsWith('192.168.'));
  if (lan192) return lan192;

  const lan10 = routable.find((a) => a.startsWith('10.'));
  if (lan10) return lan10;

  const lan172 = routable.filter((a) => /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(a));
  const nonDocker172 = lan172.find((a) => a !== '172.17.0.1');
  if (nonDocker172) return nonDocker172;
  if (lan172.length > 0) return lan172[0];

  const anyIpv4 = routable.find((a) => !a.includes(':'));
  if (anyIpv4) return anyIpv4;
  if (routable[0]) return routable[0];

  return normalizeMdnsHost(fallbackHost);
}
