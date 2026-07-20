import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { AgentCapabilityReport } from '@rbo/protocol';
import {
  ArtifactUploadGrantPayloadSchema,
  CancelJobPayloadSchema,
  LeaseOfferPayloadSchema,
  PrepareSourcePayloadSchema,
  RunJobPayloadSchema,
} from '@rbo/protocol';
import {
  certificateFingerprint,
  createLogger,
  generateDeviceKeyPair,
  generateId,
  signNonce,
} from '@rbo/shared';
import WebSocket from 'ws';
import { AgentJobExecutor } from '../executor/index.js';

const logger = createLogger('agent.connection');

const HEARTBEAT_INTERVAL_MS = 20_000;

export interface AgentConnectionOptions {
  controllerUrl: string;
  expectedFingerprint: string;
  stateDir: string;
  displayName: string;
  capabilities: AgentCapabilityReport;
  /** Maps store ref → env var name holding the secret (optional). */
  secretMap?: Record<string, string>;
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
  private executor: AgentJobExecutor | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

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
        rejectUnauthorized: false,
      });
      this.socket = socket;

      const finish = (result: ConnectResult) => {
        resolvePromise(result);
      };
      const fail = (error: Error) => {
        this.stopHeartbeats();
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

            this.executor = new AgentJobExecutor(socket, {
              stateDir: this.options.stateDir,
              controllerFingerprint: this.options.expectedFingerprint,
              secretMap: this.options.secretMap,
              toolchainProfiles: this.options.capabilities.toolchain_profiles,
            });
            this.startHeartbeats(socket);
            finish({ status: 'authenticated', agentId });
            return;
          }

          if (status === 'incompatible_protocol') {
            finish({ status: 'incompatible_protocol' });
            return;
          }

          finish({ status: 'rejected' });
        }

        if (this.executor) {
          switch (message.type) {
            case 'lease_offer': {
              const parsed = LeaseOfferPayloadSchema.safeParse(message.payload);
              if (parsed.success) {
                this.executor.handleLeaseOffer(parsed.data);
              } else {
                logger.warn('invalid lease_offer payload', { issues: parsed.error.issues });
              }
              break;
            }
            case 'prepare_source': {
              const parsed = PrepareSourcePayloadSchema.safeParse(message.payload);
              if (parsed.success) {
                void this.executor.handlePrepareSource(parsed.data);
              } else {
                logger.warn('invalid prepare_source payload', { issues: parsed.error.issues });
              }
              break;
            }
            case 'run_job': {
              const parsed = RunJobPayloadSchema.safeParse(message.payload);
              if (parsed.success) {
                void this.executor.handleRunJob(parsed.data);
              } else {
                logger.warn('invalid run_job payload', { issues: parsed.error.issues });
              }
              break;
            }
            case 'artifact_upload_grant': {
              const parsed = ArtifactUploadGrantPayloadSchema.safeParse(message.payload);
              if (parsed.success) {
                this.executor.handleArtifactUploadGrant(parsed.data);
              } else {
                logger.warn('invalid artifact_upload_grant payload', {
                  issues: parsed.error.issues,
                });
              }
              break;
            }
            case 'cancel_job': {
              const parsed = CancelJobPayloadSchema.safeParse(message.payload);
              if (parsed.success) {
                void this.executor.handleCancelJob(parsed.data);
              } else {
                logger.warn('invalid cancel_job payload', { issues: parsed.error.issues });
              }
              break;
            }
          }
        }
      });

      socket.on('close', () => {
        this.stopHeartbeats();
        void this.executor?.abandonOnDisconnect();
        this.executor = null;
      });

      socket.on('error', (error) => {
        fail(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  /** Resolves when the authenticated WebSocket closes (or is already closed). */
  waitUntilDisconnected(): Promise<void> {
    return new Promise((resolvePromise) => {
      if (!this.socket || this.socket.readyState === WebSocket.CLOSED) {
        resolvePromise();
        return;
      }
      this.socket.once('close', () => resolvePromise());
    });
  }

  private startHeartbeats(socket: WebSocket): void {
    this.stopHeartbeats();
    this.sendHeartbeat(socket);
    this.heartbeatTimer = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) {
        this.stopHeartbeats();
        return;
      }
      this.sendHeartbeat(socket);
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private sendHeartbeat(socket: WebSocket): void {
    const busy = this.executor?.isBusy() ?? false;
    this.send(socket, 'heartbeat', {
      state: busy ? 'busy' : 'idle',
      active_jobs: [],
    });
  }

  private stopHeartbeats(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
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
    this.stopHeartbeats();
    const executor = this.executor;
    this.executor = null;
    void executor?.abandonOnDisconnect();
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    logger.debug('connection closed');
  }
}
