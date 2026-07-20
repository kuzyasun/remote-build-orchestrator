import { randomBytes } from 'node:crypto';
import { createServer as createHttpsServer } from 'node:https';
import type { Server as HttpsServer } from 'node:https';
import { AgentCapabilityReportSchema, negotiateProtocolVersion } from '@rbo/protocol';
import { createLogger, generateId, verifyNonceSignature } from '@rbo/shared';
import type { ControllerIdentity } from '@rbo/shared';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { updateAgentCapabilities } from '../agents/registry.js';
import { markAgentSeen, verifyAgentCredential } from '../security/credentials.js';
import { claimApprovedPairing, createPairingRequest } from '../security/pairing.js';
import type { ControllerDatabase } from '../storage/database.js';

const logger = createLogger('controller.agent-plane');

export interface AgentPlaneOptions {
  port: number;
  db: ControllerDatabase;
  identity: ControllerIdentity;
}

export interface ConnectedAgent {
  agentId: string;
  socket: WebSocket;
  protocolVersion: number;
  lastHeartbeatAt: number;
}

export interface RunningAgentPlane {
  port: number;
  server: HttpsServer;
  connectedAgents: Map<string, ConnectedAgent>;
  close(): Promise<void>;
}

interface WireMessage {
  protocol?: number;
  type: string;
  message_id?: string;
  payload?: Record<string, unknown>;
}

function send(socket: WebSocket, type: string, payload: Record<string, unknown>): void {
  socket.send(
    JSON.stringify({
      protocol: 1,
      type,
      message_id: generateId('msg'),
      sent_at: new Date().toISOString(),
      attempt_id: null,
      lease_id: null,
      lease_epoch: null,
      payload,
    }),
  );
}

export async function startAgentPlaneServer(
  options: AgentPlaneOptions,
): Promise<RunningAgentPlane> {
  const { db, identity } = options;
  const httpsServer = createHttpsServer({
    cert: identity.tlsCertPem,
    key: identity.tlsKeyPem,
  });
  const wss = new WebSocketServer({ server: httpsServer, path: '/agent' });
  const connectedAgents = new Map<string, ConnectedAgent>();

  wss.on('connection', (socket) => {
    // Per-connection auth state machine:
    // hello → (pairing_request | challenge/response) → authenticated session.
    let authenticated: ConnectedAgent | null = null;
    let pendingNonce: string | null = null;
    let pendingCredential: string | null = null;

    socket.on('message', (raw) => {
      let message: WireMessage;
      try {
        message = JSON.parse(String(raw)) as WireMessage;
      } catch {
        socket.close(1002, 'invalid JSON');
        return;
      }

      try {
        switch (message.type) {
          case 'hello': {
            const negotiated = negotiateProtocolVersion({
              min_version: Number(message.payload?.min_version ?? 1),
              max_version: Number(message.payload?.max_version ?? 1),
            });
            if (negotiated === null) {
              // Incompatible agents stay connected for diagnostics only (§35 Phase 2).
              send(socket, 'hello_ack', {
                status: 'incompatible_protocol',
                controller_fingerprint: identity.fingerprint,
              });
              return;
            }
            const credential = message.payload?.credential;
            if (typeof credential === 'string' && credential.length > 0) {
              pendingCredential = credential;
              pendingNonce = randomBytes(32).toString('base64url');
              send(socket, 'pairing_challenge', { nonce: pendingNonce, purpose: 'auth' });
            } else {
              send(socket, 'hello_ack', {
                status: 'unauthenticated',
                controller_fingerprint: identity.fingerprint,
              });
            }
            return;
          }

          case 'pairing_request': {
            const publicKey = String(message.payload?.device_public_key ?? '');
            const displayName = String(message.payload?.display_name ?? 'unnamed-agent');
            const hostname = message.payload?.hostname ? String(message.payload.hostname) : null;
            if (!publicKey.includes('PUBLIC KEY')) {
              send(socket, 'hello_ack', { status: 'rejected', reason: 'invalid device key' });
              return;
            }
            // If the operator already approved this device, deliver the credential.
            const claim = claimApprovedPairing(db, identity, publicKey);
            if (claim) {
              send(socket, 'hello_ack', {
                status: 'pairing_approved',
                agent_id: claim.agentId,
                credential: claim.credential,
              });
              return;
            }
            const request = createPairingRequest(db, {
              devicePublicKeyPem: publicKey,
              displayName,
              hostname,
            });
            if (request.state === 'rejected' || request.state === 'expired') {
              send(socket, 'hello_ack', { status: 'rejected', reason: request.state });
              return;
            }
            send(socket, 'hello_ack', {
              status: 'pairing_pending',
              pairing_request_id: request.id,
              one_time_code: request.one_time_code,
            });
            return;
          }

          case 'challenge_response': {
            if (!pendingNonce || !pendingCredential) {
              send(socket, 'hello_ack', { status: 'rejected', reason: 'no pending challenge' });
              return;
            }
            const verified = verifyAgentCredential(db, identity, pendingCredential);
            const signature = String(message.payload?.signature ?? '');
            if (
              !verified ||
              !verifyNonceSignature(verified.devicePublicKeyPem, pendingNonce, signature)
            ) {
              send(socket, 'hello_ack', { status: 'rejected', reason: 'authentication failed' });
              pendingNonce = null;
              pendingCredential = null;
              return;
            }
            pendingNonce = null;
            pendingCredential = null;
            authenticated = {
              agentId: verified.agentId,
              socket,
              protocolVersion: 1,
              lastHeartbeatAt: Date.now(),
            };
            connectedAgents.set(verified.agentId, authenticated);
            markAgentSeen(db, verified.agentId, 'idle');
            send(socket, 'hello_ack', { status: 'authenticated', agent_id: verified.agentId });
            return;
          }

          case 'capabilities': {
            if (!authenticated) {
              return; // capability reports from unauthenticated sockets are dropped
            }
            const parsed = AgentCapabilityReportSchema.safeParse(message.payload);
            if (parsed.success) {
              updateAgentCapabilities(db, authenticated.agentId, parsed.data);
            }
            return;
          }

          case 'heartbeat': {
            if (!authenticated) {
              return;
            }
            authenticated.lastHeartbeatAt = Date.now();
            const state = String(message.payload?.state ?? 'idle');
            markAgentSeen(db, authenticated.agentId, state);
            return;
          }

          default:
            logger.warn('unhandled agent message', { type: message.type });
        }
      } catch (error) {
        logger.error('agent message handling failed', {
          type: message.type,
          error: String(error),
        });
      }
    });

    socket.on('close', () => {
      if (authenticated) {
        connectedAgents.delete(authenticated.agentId);
        markAgentSeen(db, authenticated.agentId, 'offline');
      }
    });
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    httpsServer.once('error', rejectPromise);
    httpsServer.listen(options.port, () => {
      httpsServer.removeListener('error', rejectPromise);
      resolvePromise();
    });
  });

  const address = httpsServer.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;
  logger.info('agent plane listening', { port });

  return {
    port,
    server: httpsServer,
    connectedAgents,
    close: () =>
      new Promise<void>((resolvePromise) => {
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close(() => {
          httpsServer.close(() => resolvePromise());
        });
      }),
  };
}
