import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { AgentCapabilityReport } from '@rbo/protocol';
import {
  certificateFingerprint,
  createLogger,
  generateDeviceKeyPair,
  generateId,
  signNonce,
} from '@rbo/shared';
import WebSocket from 'ws';

const logger = createLogger('agent.connection');

// Agent-side pairing and authentication (§8.1):
//  1. verify pinned Controller TLS fingerprint before sending anything;
//  2. no credential yet → pairing_request, wait for operator approval;
//  3. credential stored → hello + nonce challenge signed with the device key.

export interface AgentConnectionOptions {
  controllerUrl: string;
  expectedFingerprint: string;
  stateDir: string;
  displayName: string;
  capabilities: AgentCapabilityReport;
}

export interface ConnectResult {
  status:
    | 'pairing_pending'
    | 'pairing_approved'
    | 'authenticated'
    | 'rejected'
    | 'incompatible_protocol';
  agentId?: string;
}

interface StoredState {
  devicePublicKeyPem: string;
  devicePrivateKeyPem: string;
  credential?: string;
  agentId?: string;
}

export class AgentConnection {
  private readonly options: AgentConnectionOptions;
  private socket: WebSocket | null = null;

  constructor(options: AgentConnectionOptions) {
    this.options = options;
  }

  private statePath(): string {
    return join(this.options.stateDir, 'agent-state.json');
  }

  private loadState(): StoredState {
    if (existsSync(this.statePath())) {
      return JSON.parse(readFileSync(this.statePath(), 'utf8')) as StoredState;
    }
    const pair = generateDeviceKeyPair();
    const state: StoredState = {
      devicePublicKeyPem: pair.publicKeyPem,
      devicePrivateKeyPem: pair.privateKeyPem,
    };
    this.saveState(state);
    return state;
  }

  private saveState(state: StoredState): void {
    mkdirSync(this.options.stateDir, { recursive: true });
    // OS-protected state directory (§8.1): private key never leaves this file.
    writeFileSync(this.statePath(), JSON.stringify(state), { mode: 0o600 });
  }

  hasStoredCredential(): boolean {
    const state = this.loadState();
    return typeof state.credential === 'string' && state.credential.length > 0;
  }

  connectOnce(): Promise<ConnectResult> {
    const state = this.loadState();

    return new Promise<ConnectResult>((resolvePromise, rejectPromise) => {
      const socket = new WebSocket(this.options.controllerUrl, {
        rejectUnauthorized: false, // trust is the pinned fingerprint, not a CA
      });
      this.socket = socket;

      const finish = (result: ConnectResult) => {
        resolvePromise(result);
      };
      const fail = (error: Error) => {
        socket.terminate();
        rejectPromise(error);
      };

      socket.on('upgrade', (response) => {
        const socketWithTls = response.socket as unknown as {
          getPeerCertificate?: () => { raw?: Buffer };
        };
        const cert = socketWithTls.getPeerCertificate?.();
        if (!cert?.raw) {
          fail(new Error('Controller did not present a TLS certificate'));
          return;
        }
        const actual = certificateFingerprint(cert.raw);
        if (actual !== this.options.expectedFingerprint) {
          // §8.1 step 3: fingerprint checked before any pairing traffic.
          fail(
            new Error(
              `Controller certificate fingerprint mismatch: expected ${this.options.expectedFingerprint}, got ${actual}`,
            ),
          );
        }
      });

      socket.on('open', () => {
        this.send(socket, 'hello', {
          min_version: 1,
          max_version: 1,
          credential: state.credential ?? null,
        });
      });

      socket.on('message', (raw) => {
        let message: { type: string; payload?: Record<string, unknown> };
        try {
          message = JSON.parse(String(raw)) as typeof message;
        } catch {
          fail(new Error('invalid message from controller'));
          return;
        }

        if (message.type === 'pairing_challenge') {
          const nonce = String(message.payload?.nonce ?? '');
          this.send(socket, 'challenge_response', {
            signature: signNonce(state.devicePrivateKeyPem, nonce),
          });
          return;
        }

        if (message.type === 'hello_ack') {
          const status = String(message.payload?.status ?? 'rejected');

          if (status === 'unauthenticated') {
            this.send(socket, 'pairing_request', {
              device_public_key: state.devicePublicKeyPem,
              display_name: this.options.displayName,
              hostname: hostname(),
            });
            return;
          }

          if (status === 'pairing_pending') {
            finish({ status: 'pairing_pending' });
            return;
          }

          if (status === 'pairing_approved') {
            const credential = String(message.payload?.credential ?? '');
            const agentId = String(message.payload?.agent_id ?? '');
            this.saveState({ ...state, credential, agentId });
            // Re-hello on the same socket with the fresh credential.
            state.credential = credential;
            state.agentId = agentId;
            this.send(socket, 'hello', {
              min_version: 1,
              max_version: 1,
              credential,
            });
            return;
          }

          if (status === 'authenticated') {
            const agentId = String(message.payload?.agent_id ?? state.agentId ?? '');
            this.saveState({ ...state, agentId });
            this.send(socket, 'capabilities', {
              ...this.options.capabilities,
              agent_id: agentId,
            });
            this.send(socket, 'heartbeat', { state: 'idle', active_jobs: [] });
            finish({ status: 'authenticated', agentId });
            return;
          }

          if (status === 'incompatible_protocol') {
            finish({ status: 'incompatible_protocol' });
            return;
          }

          finish({ status: 'rejected' });
        }
      });

      socket.on('error', (error) => {
        fail(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private send(socket: WebSocket, type: string, payload: Record<string, unknown>): void {
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

  close(): void {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    logger.debug('connection closed');
  }
}
