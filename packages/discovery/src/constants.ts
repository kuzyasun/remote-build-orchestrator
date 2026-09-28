/**
 * mDNS/DNS-SD service type for RBO controller discovery (§7.2).
 *
 * Registers as `_rbo-controller._tcp.local` on the local network.
 */
export const RBO_MDNS_SERVICE_TYPE = 'rbo-controller';

/** Default browse timeout in milliseconds. */
export const RBO_MDNS_BROWSE_TIMEOUT_MS = 3_000;

/** TXT record protocol version. */
export const RBO_MDNS_TXT_VERSION = '1';

/** Default mDNS display name for the controller. */
export const RBO_MDNS_DEFAULT_DISPLAY_NAME = 'rbo-controller';
