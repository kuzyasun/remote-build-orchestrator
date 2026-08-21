import {
  HostCpuMonitor,
  RBO_CONTROLLER_VERSION,
  createLogger,
  ensureControllerIdentity,
} from '@rbo/shared';
import { type ControllerConfig, ensureDataDir, loadControllerConfig } from './config.js';
import { startControllerServer } from './http/server.js';
import {
  JobLifecycleNotifier,
  bindJobLifecycleNotifier,
  unbindJobLifecycleNotifier,
} from './jobs/lifecycle-notifier.js';
import { recoverSnapshotPublications } from './recovery/snapshot-publication.js';
import { migrateToLatest, openDatabase } from './storage/database.js';
import { startAgentPlaneServer } from './websocket/server.js';

const logger = createLogger('controller.main');

/** How often the host CPU sampler takes a fresh reading (host-aware local fallback). */
const HOST_CPU_SAMPLE_INTERVAL_MS = 5_000;

/**
 * Start the Controller in-process (MCP HTTP + agent plane). Blocks until
 * SIGINT/SIGTERM; shutdown handlers call `process.exit(0)`.
 */
export async function runController(overrides: Partial<ControllerConfig> = {}): Promise<void> {
  const config = loadControllerConfig(overrides);
  ensureDataDir(config);

  const db = openDatabase(config.databasePath);
  migrateToLatest(db);
  await recoverSnapshotPublications({ db, dataDir: config.dataDir });
  const lifecycleNotifier = new JobLifecycleNotifier();
  bindJobLifecycleNotifier(db, lifecycleNotifier);

  const identity = await ensureControllerIdentity(config.dataDir);

  const hostCpuMonitor = new HostCpuMonitor();
  hostCpuMonitor.start(HOST_CPU_SAMPLE_INTERVAL_MS);
  const getHostCpuBusyFraction = () => hostCpuMonitor.currentBusyFraction();

  const agentPlane = await startAgentPlaneServer({
    port: config.agentPlanePort,
    db,
    identity,
    dataDir: config.dataDir,
    controllerPublicHost: config.controllerPublicHost,
    dataPlaneBaseUrl: config.dataPlaneBaseUrl,
    disconnectGraceSeconds: config.disconnectGraceSeconds,
    orphanTimeoutSeconds: config.orphanTimeoutSeconds,
    reconcileDeadlineSeconds: config.reconcileDeadlineSeconds,
    maxGitBundleBytes: config.maxGitBundleBytes,
    dispatchContext: {
      dataDir: config.dataDir,
      allowedProjectRoots: config.allowedProjectRoots,
      allowedArtifactDestinations: config.allowedArtifactDestinations,
      maxConcurrentJobs: config.localExecutor.maxConcurrentJobs,
      gitAllowlist: config.gitAllowlist,
      allowLocalFallback: config.allowLocalFallback,
      defaultQueuePolicy: config.defaultQueuePolicy,
      getHostCpuBusyFraction,
      maxHostCpuBusyFraction: config.maxHostCpuBusyFraction,
    },
  });

  const httpServer = await startControllerServer({
    host: config.mcpHost,
    port: config.mcpPort,
    db,
    identity,
    connectedAgents: agentPlane.connectedAgents,
    agentPlanePort: agentPlane.port,
    controllerPublicHost: config.controllerPublicHost,
    dataPlaneBaseUrl: config.dataPlaneBaseUrl,
    dataDir: config.dataDir,
    allowedProjectRoots: config.allowedProjectRoots,
    allowedArtifactDestinations: config.allowedArtifactDestinations,
    maxConcurrentJobs: config.localExecutor.maxConcurrentJobs,
    gitAllowlist: config.gitAllowlist,
    allowLocalFallback: config.allowLocalFallback,
    allowFullSnapshotFallback: config.allowFullSnapshotFallback,
    defaultQueuePolicy: config.defaultQueuePolicy,
    getHostCpuBusyFraction,
    maxHostCpuBusyFraction: config.maxHostCpuBusyFraction,
  });

  logger.info('controller started', {
    version: RBO_CONTROLLER_VERSION,
    mcp: `http://${httpServer.host}:${httpServer.port}/mcp`,
    agentPlane: `wss://0.0.0.0:${agentPlane.port}/agent`,
    fingerprint: identity.fingerprint,
    database: config.databasePath,
  });

  const shutdown = async () => {
    logger.info('controller shutting down');
    hostCpuMonitor.stop();
    await httpServer.close();
    await agentPlane.close();
    unbindJobLifecycleNotifier(db);
    lifecycleNotifier.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Stay alive until signal handlers call process.exit.
  await new Promise<never>(() => undefined);
}
