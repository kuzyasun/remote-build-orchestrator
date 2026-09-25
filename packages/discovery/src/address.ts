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
