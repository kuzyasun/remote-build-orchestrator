import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { AgentCapabilityReport } from '@rbo/protocol';
import {
  ArtifactUploadGrantPayloadSchema,
  BundleDownloadPayloadSchema,
  CancelJobPayloadSchema,
  LeaseOfferPayloadSchema,
  LogAckPayloadSchema,
  PrepareSourcePayloadSchema,
  ReconcileDecisionPayloadSchema,
  RunJobPayloadSchema,
} from '@rbo/protocol';
import {
  certificateFingerprint,
  createLogger,
  generateDeviceKeyPair,
  generateId,
  signNonce,
} from '@rbo/shared';
import type { GitUrlAllowlist } from '@rbo/shared';
import WebSocket from 'ws';
import {
  type BuildCacheConfig,
  BuildCacheStore,
  DEFAULT_BUILD_CACHE_CONFIG,
  resolveBuildCachesDir,
} from '../build-cache/index.js';
import {
  applyRefreshedBuildCacheAds,
  probeCpuLoad,
  refreshBuildCacheCapabilityAds,
} from '../capabilities/probe.js';
import { resolveReposDir } from '../config.js';
import { cleanupDockerResourcesForAttempt } from '../docker/cleanup.js';
import { AgentJobExecutor } from '../executor/index.js';
import { AgentRecoveryCoordinator } from '../recovery/coordinator.js';
import { applyDiskPressureCleanup } from '../recovery/disk-pressure.js';
import { DEFAULT_REPO_CACHE_CONFIG, type RepoCacheConfig } from '../repos/mirror.js';

const logger = createLogger('agent.connection');

const HEARTBEAT_INTERVAL_MS = 20_000;

export interface AgentConnectionOptions {
  controllerUrl: string;
  expectedFingerprint: string;
  stateDir: string;
  /** Mirror cache root override (§2.8). */
  repoCacheDir?: string;
  displayName: string;
  capabilities: AgentCapabilityReport;
  /** Maps store ref → env var name holding the secret (optional). */
  secretMap?: Record<string, string>;
  gitAllowlist: GitUrlAllowlist;
  repoCache?: RepoCacheConfig;
  buildCache?: BuildCacheConfig;
  logSpoolMaxBytes?: number;
  logSendQueueMax?: number;
  /** Disk admission floor (Phase 6). */
  diskMinFreeBytes?: number;
  /** Cached free-disk probe used for heartbeat/capabilities/admission. */
  getFreeDiskBytes?: () => number;
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
  private recovery: AgentRecoveryCoordinator;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: AgentConnectionOptions) {
    this.options = options;
    this.recovery = new AgentRecoveryCoordinator({
      stateDir: options.stateDir,
      hooks: {
        terminateAttempt: async (attemptId) => {
          await this.executor?.terminateAttemptForRecovery(attemptId);
        },
        resendJobExit: (meta) => {
          this.executor?.resendJobExitIfCompleted(meta);
        },
        resumeArtifactUpload: async (meta) => {
          await this.executor?.resumeArtifactUpload(meta);
        },
        cleanupAttemptResources: async (attemptId) => {
          await cleanupDockerResourcesForAttempt({ attemptId });
        },
      },
    });
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
            this.options.capabilities.agent_id = agentId;
            this.send(socket, 'capabilities', {
              ...this.options.capabilities,
              agent_id: agentId,
            });

            this.recovery.attachSocket(socket);
            if (this.executor) {
              // Reconnect with live attempt: re-bind socket and reconcile.
              this.executor.attachSocket(socket);
            } else {
              this.executor = new AgentJobExecutor(socket, {
                stateDir: this.options.stateDir,
                repoCacheDir: this.options.repoCacheDir,
                controllerFingerprint: this.options.expectedFingerprint,
                secretMap: this.options.secretMap,
                toolchainProfiles: this.options.capabilities.toolchain_profiles,
                gitAllowlist: this.options.gitAllowlist,
                repoCache: this.options.repoCache ?? DEFAULT_REPO_CACHE_CONFIG,
                buildCache: this.options.buildCache ?? DEFAULT_BUILD_CACHE_CONFIG,
                logSpoolMaxBytes: this.options.logSpoolMaxBytes,
                logSendQueueMax: this.options.logSendQueueMax,
                recovery: this.recovery,
                diskMinFreeBytes: this.options.diskMinFreeBytes,
                getFreeDiskBytes: this.options.getFreeDiskBytes,
                getSpoolPressure: () => this.executor?.isUnderSpoolPressure() ?? false,
              });
            }
            void this.recovery.reportAll().catch((error) => {
              logger.warn('recovery_report scan failed', { error: String(error) });
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
            case 'bundle_download': {
              const parsed = BundleDownloadPayloadSchema.safeParse(message.payload);
              if (parsed.success) {
                this.executor.handleBundleDownload(parsed.data);
              } else {
                logger.warn('invalid bundle_download payload', { issues: parsed.error.issues });
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
            case 'log_ack': {
              const parsed = LogAckPayloadSchema.safeParse(message.payload);
              if (parsed.success) {
                void this.executor.handleLogAck(parsed.data);
              } else {
                logger.warn('invalid log_ack payload', { issues: parsed.error.issues });
              }
              break;
            }
            case 'reconcile_decision': {
              const parsed = ReconcileDecisionPayloadSchema.safeParse(message.payload);
              if (parsed.success) {
                void this.recovery.handleReconcileDecision(parsed.data);
              } else {
                logger.warn('invalid reconcile_decision payload', {
                  issues: parsed.error.issues,
                });
              }
              break;
            }
          }
        }
      });

      socket.on('close', () => {
        this.stopHeartbeats();
        // Park attempt through grace — do not kill safe/normal jobs.
        void this.executor?.abandonOnDisconnect();
        // Keep executor alive across reconnect so the process and spool sender remain.
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
    this.executor?.renewLeaseDeadline();
    const freeBytes = this.options.getFreeDiskBytes?.() ?? 0;
    const minFree = this.options.diskMinFreeBytes ?? 0;
    const spoolPressure = this.executor?.isUnderSpoolPressure() ?? false;
    const diskPressure = minFree > 0 && freeBytes < minFree;
    const underPressure = diskPressure || spoolPressure;
    const accepting = underPressure ? false : (this.options.capabilities.accepting_jobs ?? true);

    if (underPressure) {
      const retentionDays = this.options.repoCache?.retention_days ?? 14;
      const buildCache = this.options.buildCache ?? DEFAULT_BUILD_CACHE_CONFIG;
      // Wire heartbeat free-disk measurement so min-free eviction can trigger.
      const buildCacheStore = new BuildCacheStore(
        resolveBuildCachesDir(this.options.stateDir),
        buildCache,
        {
          getFreeBytes: async () => this.options.getFreeDiskBytes?.() ?? freeBytes,
        },
      );
      void applyDiskPressureCleanup({
        stateDir: this.options.stateDir,
        reposDir: resolveReposDir(this.options),
        minFreeBytes: minFree > 0 ? minFree : 1,
        freeBytes,
        spoolPressure,
        retentionMs: retentionDays * 24 * 60 * 60 * 1000,
        cleanupAttemptResources: async (attemptId) => {
          await this.recovery.cleanupVerifiedOrphan(attemptId);
        },
        // After inactive repo caches: evict LRU inactive build-cache keys (never locked/in-use).
        evictInactiveBuildCaches: async () => {
          const result = await buildCacheStore.evictInactive({
            maxSizeBytes: buildCache.maxSizeGb * 1024 ** 3,
            minFreeBytes: buildCache.minFreeDiskGb * 1024 ** 3,
          });
          return result.evictedKeys;
        },
      }).catch((error) => {
        logger.warn('disk-pressure cleanup failed', { error: String(error) });
      });
    }

    this.send(socket, 'heartbeat', {
      state: busy ? 'busy' : 'idle',
      active_jobs: [],
      cpu_load: probeCpuLoad(),
      accepting_jobs: accepting,
      disk_free_bytes: freeBytes,
      disk_min_free_bytes: minFree,
      disk_pressure: diskPressure,
      spool_pressure: spoolPressure,
    });

    void this.refreshBuildCacheCapabilities(socket).catch((error) => {
      logger.warn('build-cache capability refresh failed', { error: String(error) });
    });
  }

  private async refreshBuildCacheCapabilities(socket: WebSocket): Promise<void> {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const agentId = this.options.capabilities.agent_id;
    if (!agentId) {
      return;
    }
    const buildCache = this.options.buildCache ?? DEFAULT_BUILD_CACHE_CONFIG;
    const refreshed = await refreshBuildCacheCapabilityAds({
      stateDir: this.options.stateDir,
      enabledKinds: buildCache.enabledKinds,
    });
    const { changed, build_caches } = applyRefreshedBuildCacheAds(
      this.options.capabilities,
      refreshed,
    );
    if (!changed) {
      return;
    }
    if (build_caches) {
      this.options.capabilities.build_caches = build_caches;
    } else {
      this.options.capabilities.build_caches = undefined;
    }
    this.send(socket, 'capabilities', {
      ...this.options.capabilities,
      agent_id: agentId,
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

  /**
   * Close the WS session.
   * @param opts.killProcess when true (agent shutdown), kill any running job.
   *   Default false parks the attempt for reconnect grace.
   */
  close(opts?: { killProcess?: boolean }): void {
    this.stopHeartbeats();
    const kill = opts?.killProcess === true;
    const executor = this.executor;
    if (kill) {
      this.executor = null;
      void executor?.forceAbandon();
    } else {
      void executor?.abandonOnDisconnect();
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    logger.debug('connection closed', { killProcess: kill });
  }
}
