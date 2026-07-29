import type { IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, type RequestOptions } from 'node:https';
import { certificateFingerprint } from '@rbo/shared';

/**
 * Dedicated agent for Controller data-plane HTTPS.
 *
 * Fingerprint pinning needs the peer certificate DER. On TLS 1.3 session
 * resumption Node's getPeerCertificate() returns {} (no raw), so either we
 * accept resumed sessions after a prior pin, or we disable session cache.
 * We do both: pin on full handshakes, trust isSessionReused(), and keep
 * maxCachedSessions modest so tickets still help without surprising callers.
 */
export const controllerDataPlaneAgent = new HttpsAgent({
  keepAlive: false,
  maxCachedSessions: 100,
});

export function pinnedTlsRequestOptions(expectedFingerprint: string): RequestOptions {
  // Self-signed Controller certs are not in the system trust store. Disable
  // CA trust and pin the peer certificate fingerprint (same model as WS).
  return {
    rejectUnauthorized: false,
    agent: controllerDataPlaneAgent,
    checkServerIdentity: (_host, cert) => {
      // Node may skip this callback when rejectUnauthorized is false, and on
      // TLS 1.3 resume cert is often empty — assertPinnedPeerCert is authoritative.
      if (!cert?.raw) {
        return undefined;
      }
      const actual = certificateFingerprint(cert.raw);
      if (actual !== expectedFingerprint) {
        return new Error(
          `Controller certificate fingerprint mismatch: expected ${expectedFingerprint}, got ${actual}`,
        );
      }
      return undefined;
    },
  };
}

/**
 * Verify the Controller peer certificate fingerprint on a data-plane response.
 * TLS 1.3 session resumption leaves getPeerCertificate() empty; a resumed
 * session is bound to the prior full handshake where we already pinned.
 */
export function assertPinnedPeerCert(
  res: IncomingMessage,
  expectedFingerprint: string,
): Error | undefined {
  const socket = res.socket as unknown as {
    encrypted?: boolean;
    isSessionReused?: () => boolean;
    getPeerCertificate?: (detailed?: boolean) => { raw?: Buffer };
    getX509Certificate?: () => { raw?: Buffer } | undefined;
  };

  if (!socket) {
    return new Error('Controller did not present a TLS certificate');
  }

  if (socket.isSessionReused?.()) {
    return undefined;
  }

  const cert = socket.getPeerCertificate?.(true);
  const raw = cert?.raw ?? socket.getX509Certificate?.()?.raw;
  if (!raw) {
    return new Error('Controller did not present a TLS certificate');
  }
  const actual = certificateFingerprint(raw);
  if (actual !== expectedFingerprint) {
    return new Error(
      `Controller certificate fingerprint mismatch: expected ${expectedFingerprint}, got ${actual}`,
    );
  }
  return undefined;
}
