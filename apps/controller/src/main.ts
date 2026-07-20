import { RBO_CONTROLLER_VERSION, createLogger, ensureControllerIdentity } from '@rbo/shared';
import { ensureDataDir, loadControllerConfig } from './config.js';
import { startControllerServer } from './http/server.js';
import { migrateToLatest, openDatabase } from './storage/database.js';
import { startAgentPlaneServer } from './websocket/server.js';

const logger = createLogger('controller.main');

async function main(): Promise<void> {
  const config = loadControllerConfig();
  ensureDataDir(config);

  const db = openDatabase(config.databasePath);
  migrateToLatest(db);

  const identity = await ensureControllerIdentity(config.dataDir);

  const agentPlane = await startAgentPlaneServer({
    port: config.agentPlanePort,
    db,
    identity,
    dataDir: config.dataDir,
    controllerPublicHost: config.controllerPublicHost,
    dataPlaneBaseUrl: config.dataPlaneBaseUrl,
    dispatchContext: {
      dataDir: config.dataDir,
      allowedProjectRoots: config.allowedProjectRoots,
      allowedArtifactDestinations: config.allowedArtifactDestinations,
      maxConcurrentJobs: config.localExecutor.maxConcurrentJobs,
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
    await httpServer.close();
    await agentPlane.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  logger.error('controller failed to start', { error: String(error) });
  process.exit(1);
});
