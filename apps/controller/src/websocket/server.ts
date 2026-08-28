import { randomBytes } from 'node:crypto';
import { createServer as createHttpsServer } from 'node:https';
import type { Server as HttpsServer } from 'node:https';
import {
  AgentCapabilityReportSchema,
  ArtifactManifestPayloadSchema,
  CleanupCompletePayloadSchema,
  JobExitPayloadSchema,
  JobStartedPayloadSchema,
  LeaseAcceptPayloadSchema,
  LeaseRejectPayloadSchema,
  LogChunkPayloadSchema,
  RecoveryReportPayloadSchema,
  SourceNeedPayloadSchema,
  SourceReadyPayloadSchema,
  negotiateProtocolVersion,
} from '@rbo/protocol';
import { createLogger, generateId, verifyNonceSignature } from '@rbo/shared';
import type { ControllerIdentity } from '@rbo/shared';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { z } from 'zod';
import { patchAgentCpuLoad, updateAgentCapabilities } from '../agents/registry.js';
import {
  enqueueRemoteLogChunk,
  expireStaleLeases,
  handleRemoteArtifactManifest,
  handleRemoteCleanupComplete,
  handleRemoteJobExit,
  handleRemoteJobStarted,
  handleRemoteLeaseAccept,
  handleRemoteLeaseReject,
  handleRemoteSourceNeed,
  handleRemoteSourceReady,
  renewActiveLease,
} from '../execution/remote-execution.js';
import { handleDataPlaneRequest } from '../http/data-plane.js';
import {
  DEFAULT_DISCONNECT_GRACE_SECONDS,
  DEFAULT_ORPHAN_TIMEOUT_SECONDS,
  DEFAULT_RECONCILE_DEADLINE_SECONDS,
  RecoveryCoordinator,
} from '../recovery/coordinator.js';
import { markAgentSeen, verifyAgentCredential } from '../security/credentials.js';
import { claimApprovedPairing, createPairingRequest } from '../security/pairing.js';
import type { ControllerDatabase } from '../storage/database.js';

const logger = createLogger('controller.agent-plane');

export interface AgentPlaneDispatchContext {
  dataDir: string;
  allowedProjectRoots?: string[];
  allowedArtifactDestinations?: string[];
  maxConcurrentJobs?: number;
  gitAllowlist?: import('@rbo/shared').GitUrlAllowlist;
  snapshotCaptureLimits?: import('@rbo/snapshot').SnapshotCaptureLimits;
  allowLocalFallback?: boolean;
  /** Controller-level queue policy used when a job does not set one explicitly. */
  defaultQueuePolicy?: import('@rbo/protocol').QueuePolicy;
  /** Host-aware local fallback (docs/dev/host-aware-local-fallback-plan.md). */
  getHostCpuBusyFraction?: () => number;
  maxHostCpuBusyFraction?: number;
}

export interface AgentPlaneOptions {
  port: number;
  db: ControllerDatabase;
  identity: ControllerIdentity;
  dataDir: string;
  dispatchContext?: AgentPlaneDispatchContext;
  /** Host/IP advertised in prepare_source / upload grant URLs. */
  controllerPublicHost?: string;
  dataPlaneBaseUrl?: string;
  disconnectGraceSeconds?: number;
  orphanTimeoutSeconds?: number;
  reconcileDeadlineSeconds?: number;
  maxGitBundleBytes?: number;
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
  recovery: RecoveryCoordinator;
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

function parsePayload<T>(
  schema: z.ZodType<T>,
  payload: Record<string, unknown> | undefined,
  type: string,
): T | null {
  const parsed = schema.safeParse(payload ?? {});
  if (!parsed.success) {
    logger.warn('invalid job-scoped payload', { type, issues: parsed.error.issues });
    return null;
  }
  return parsed.data;
}

export async function startAgentPlaneServer(
  options: AgentPlaneOptions,
): Promise<RunningAgentPlane> {
  const { db, identity, dataDir } = options;
  if (!dataDir) {
    throw new Error('Agent plane requires dataDir');
  }

  const httpsServer = createHttpsServer({
    cert: identity.tlsCertPem,
    key: identity.tlsKeyPem,
  });
  const wss = new WebSocketServer({ server: httpsServer, path: '/agent' });
  const connectedAgents = new Map<string, ConnectedAgent>();
  const inFlightDispatches = new Set<Promise<void>>();
  const drainableWork = new Set<Promise<void>>();
  let shuttingDown = false;

  const trackWork = (work: Promise<void>, context: string, drainOnClose: boolean): void => {
    const bucket = drainOnClose ? drainableWork : inFlightDispatches;
    bucket.add(work);
    void work.then(
      () => {
        bucket.delete(work);
      },
      (error) => {
        bucket.delete(work);
        logger.error(`${context} failed`, { error: String(error) });
      },
    );
  };

  const trackDispatch = (work: Promise<void>, context: string): void => {
    trackWork(work, context, false);
  };

  const trackDrainable = (work: Promise<void>, context: string): void => {
    trackWork(work, context, true);
  };

  const recovery = new RecoveryCoordinator({
    db,
    connectedAgents,
    disconnectGraceSeconds: options.disconnectGraceSeconds ?? DEFAULT_DISCONNECT_GRACE_SECONDS,
    orphanTimeoutSeconds: options.orphanTimeoutSeconds ?? DEFAULT_ORPHAN_TIMEOUT_SECONDS,
    reconcileDeadlineSeconds:
      options.reconcileDeadlineSeconds ?? DEFAULT_RECONCILE_DEADLINE_SECONDS,
  });
  recovery.onControllerStartup();

  const remoteOpts = () => ({
    db,
    identity,
    dataDir,
    connectedAgents,
    serverPort: boundPort,
    controllerPublicHost: options.controllerPublicHost,
    dataPlaneBaseUrl: options.dataPlaneBaseUrl,
    allowedProjectRoots: options.dispatchContext?.allowedProjectRoots,
    snapshotCaptureLimits: options.dispatchContext?.snapshotCaptureLimits,
    maxGitBundleBytes: options.maxGitBundleBytes,
    defaultQueuePolicy: options.dispatchContext?.defaultQueuePolicy,
  });

  const buildSubmitContext = () => {
    if (!options.dispatchContext) {
      return null;
    }
    return {
      db,
      dataDir: options.dispatchContext.dataDir,
      allowedProjectRoots: options.dispatchContext.allowedProjectRoots ?? [],
      allowedArtifactDestinations:
        options.dispatchContext.allowedArtifactDestinations ??
        options.dispatchContext.allowedProjectRoots ??
        [],
      maxConcurrentJobs: options.dispatchContext.maxConcurrentJobs ?? 1,
      gitAllowlist: options.dispatchContext.gitAllowlist,
      snapshotCaptureLimits: options.dispatchContext.snapshotCaptureLimits,
      clientId: 'agent-plane-dispatcher',
      controllerIdentity: identity,
      connectedAgents,
      agentPlanePort: boundPort,
      controllerPublicHost: options.controllerPublicHost,
      dataPlaneBaseUrl: options.dataPlaneBaseUrl,
      allowLocalFallback: options.dispatchContext.allowLocalFallback,
      defaultQueuePolicy: options.dispatchContext.defaultQueuePolicy,
      getHostCpuBusyFraction: options.dispatchContext.getHostCpuBusyFraction,
      maxHostCpuBusyFraction: options.dispatchContext.maxHostCpuBusyFraction,
      shouldContinueDispatch: () => !shuttingDown,
    };
  };

  const maybeDispatchQueued = (): void => {
    if (shuttingDown) {
      return;
    }
    const ctx = buildSubmitContext();
    if (!ctx) {
      return;
    }
    const dispatch = import('../jobs/submit.js').then(({ tryDispatchQueuedJobs }) => {
      if (shuttingDown) {
        return;
      }
      return tryDispatchQueuedJobs(ctx);
    });
    trackDispatch(dispatch, 'queued job dispatch');
  };

  httpsServer.on('request', (req, res) => {
    void handleDataPlaneRequest(req, res, { db, identity, dataDir }).then((handled) => {
      if (!handled && !res.headersSent) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { category: 'validation', message: 'Not found', retryable: false },
          }),
        );
      }
    });
  });

  let boundPort = options.port;
  const leaseSweep = setInterval(() => {
    try {
      expireStaleLeases(db);
      maybeDispatchQueued();
    } catch (error) {
      logger.error('lease sweep failed', { error: String(error) });
    }
  }, 15_000);
  leaseSweep.unref?.();

  wss.on('connection', (socket) => {
    let authenticated: ConnectedAgent | null = null;
    let pendingNonce: string | null = null;
    let pendingCredential: string | null = null;

    socket.on('message', (raw) => {
      if (shuttingDown) {
        return;
      }
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
            maybeDispatchQueued();
            return;
          }

          case 'capabilities': {
            if (!authenticated) {
              return;
            }
            const parsed = AgentCapabilityReportSchema.safeParse(message.payload);
            if (parsed.success) {
              // Detect an Agent process restart via boot_id (before updateAgentCapabilities
              // persists the new one) and sweep leaked in-flight attempts pinned to it.
              recovery.onAgentConnect(authenticated.agentId, parsed.data.boot_id);
              updateAgentCapabilities(db, authenticated.agentId, parsed.data);
              maybeDispatchQueued();
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
            const cpuLoad = message.payload?.cpu_load;
            if (typeof cpuLoad === 'number' && Number.isFinite(cpuLoad)) {
              patchAgentCpuLoad(db, authenticated.agentId, cpuLoad);
            }
            renewActiveLease(db, authenticated.agentId);
            return;
          }

          case 'lease_accept': {
            if (!authenticated) return;
            const payload = parsePayload(LeaseAcceptPayloadSchema, message.payload, message.type);
            if (!payload) return;
            handleRemoteLeaseAccept(remoteOpts(), authenticated.agentId, payload);
            return;
          }

          case 'lease_reject': {
            if (!authenticated) return;
            const payload = parsePayload(LeaseRejectPayloadSchema, message.payload, message.type);
            if (!payload) return;
            handleRemoteLeaseReject(remoteOpts(), authenticated.agentId, payload);
            maybeDispatchQueued();
            return;
          }

          case 'source_need': {
            if (!authenticated) return;
            const payload = parsePayload(SourceNeedPayloadSchema, message.payload, message.type);
            if (!payload) return;
            trackDrainable(
              handleRemoteSourceNeed(remoteOpts(), authenticated.agentId, payload),
              'remote source_need handling',
            );
            return;
          }

          case 'source_ready': {
            if (!authenticated) return;
            const payload = parsePayload(SourceReadyPayloadSchema, message.payload, message.type);
            if (!payload) return;
            handleRemoteSourceReady(remoteOpts(), authenticated.agentId, payload);
            return;
          }

          case 'job_started': {
            if (!authenticated) return;
            const payload = parsePayload(JobStartedPayloadSchema, message.payload, message.type);
            if (!payload) return;
            handleRemoteJobStarted(remoteOpts(), authenticated.agentId, payload);
            return;
          }

          case 'log_chunk': {
            if (!authenticated) return;
            const payload = parsePayload(LogChunkPayloadSchema, message.payload, message.type);
            if (!payload) return;
            trackDrainable(
              enqueueRemoteLogChunk(remoteOpts(), authenticated.agentId, payload),
              'remote log_chunk handling',
            );
            return;
          }

          case 'job_exit': {
            if (!authenticated) return;
            const payload = parsePayload(JobExitPayloadSchema, message.payload, message.type);
            if (!payload) return;
            handleRemoteJobExit(remoteOpts(), authenticated.agentId, payload);
            return;
          }

          case 'artifact_manifest': {
            if (!authenticated) return;
            const payload = parsePayload(
              ArtifactManifestPayloadSchema,
              message.payload,
              message.type,
            );
            if (!payload) return;
            handleRemoteArtifactManifest(remoteOpts(), authenticated.agentId, payload);
            return;
          }

          case 'cleanup_complete': {
            if (!authenticated) return;
            const payload = parsePayload(
              CleanupCompletePayloadSchema,
              message.payload,
              message.type,
            );
            if (!payload) return;
            handleRemoteCleanupComplete(remoteOpts(), authenticated.agentId, payload);
            maybeDispatchQueued();
            return;
          }

          case 'recovery_report': {
            if (!authenticated) return;
            const payload = parsePayload(
              RecoveryReportPayloadSchema,
              message.payload,
              message.type,
            );
            if (!payload) return;
            recovery.onRecoveryReport(authenticated.agentId, payload);
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
      if (shuttingDown) {
        return;
      }
      if (authenticated) {
        connectedAgents.delete(authenticated.agentId);
        markAgentSeen(db, authenticated.agentId, 'offline');
        recovery.onAgentDisconnect(authenticated.agentId);
        maybeDispatchQueued();
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
  boundPort = port;
  logger.info('agent plane listening', { port });

  return {
    port,
    server: httpsServer,
    connectedAgents,
    recovery,
    close: async () => {
      shuttingDown = true;
      await new Promise<void>((resolvePromise) => {
        clearInterval(leaseSweep);
        recovery.dispose();
        for (const client of wss.clients) {
          client.terminate();
        }
        wss.close(() => {
          httpsServer.close(() => resolvePromise());
        });
      });
      await Promise.allSettled(drainableWork);
    },
  };
}
