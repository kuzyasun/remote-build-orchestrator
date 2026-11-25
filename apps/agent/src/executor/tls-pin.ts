import type { RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import { connect } from 'node:tls';
import { certificateFingerprint } from '@rbo/shared';

const TLS_HANDSHAKE_TIMEOUT_MS = 30_000;

export function pinnedTlsRequestOptions(
  expectedFingerprint: string,
  signal?: AbortSignal,
): RequestOptions {
  return {
    // With no Agent, this hook creates a fresh TLS connection for every request.
    // Only its callback can hand the socket to HTTP and release the queued request.
    createConnection(options, callback) {
      const host = options.host ?? undefined;
      const socket = connect({
        host,
        port: Number(options.port ?? 443),
        servername: host && !isIP(host) ? host : undefined,
        rejectUnauthorized: false, // the configured fingerprint is the trust anchor
      });
      const timeout = setTimeout(
        () => rejectConnection(new Error('Controller TLS handshake timed out')),
        TLS_HANDSHAKE_TIMEOUT_MS,
      );
      timeout.unref();
      const onClose = () =>
        rejectConnection(new Error('Controller closed the connection during TLS handshake'));
      const onAbort = () =>
        rejectConnection(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error('Controller TLS handshake cancelled'),
        );
      const cleanup = () => {
        clearTimeout(timeout);
        socket.off('error', rejectConnection);
        socket.off('close', onClose);
        signal?.removeEventListener('abort', onAbort);
      };
      function rejectConnection(error: Error): void {
        cleanup();
        socket.destroy();
        callback(error, socket);
      }
      socket.once('error', rejectConnection);
      socket.once('close', onClose);
      socket.once('secureConnect', () => {
        const raw = socket.getPeerCertificate().raw;
        if (!raw || socket.isSessionReused()) {
          rejectConnection(new Error('Controller did not present a TLS certificate'));
          return;
        }
        const actual = certificateFingerprint(raw);
        if (actual !== expectedFingerprint) {
          rejectConnection(
            new Error(
              `Controller certificate fingerprint mismatch: expected ${expectedFingerprint}, got ${actual}`,
            ),
          );
          return;
        }
        cleanup();
        callback(null, socket);
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      return undefined;
    },
  };
}
