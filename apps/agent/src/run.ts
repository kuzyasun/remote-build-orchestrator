import { RBO_AGENT_VERSION, createLogger } from '@rbo/shared';
import { probeCapabilities } from './capabilities/probe.js';
import { type AgentConfig, ensureStateDir, loadAgentConfig } from './config.js';
import { AgentConnection } from './connection/client.js';

const logger = createLogger('agent.main');

const RECONNECT_BASE_DELAY_MS = 2_000;
const RECONNECT_MAX_DELAY_MS = 60_000;

/**
 * Start the Agent in-process (connect/reconnect loop). Resolves when the process
 * receives SIGINT/SIGTERM and the loop exits cleanly.
 */
export async function runAgent(overrides: Partial<AgentConfig> = {}): Promise<void> {
  const config = loadAgentConfig(overrides);
  ensureStateDir(config);

  let cachedFreeBytes = 0;
  const refreshFreeDisk = async () => {
    try {
      const { statfs } = await import('node:fs/promises');
      const s = await statfs(config.stateDir);
      cachedFreeBytes = Number(s.bavail) * Number(s.bsize);
    } catch {
      cachedFreeBytes = 0;
    }
  };
  await refreshFreeDisk();
  const freeDiskTimer = setInterval(() => {
    void refreshFreeDisk();
  }, 30_000);
  freeDiskTimer.unref?.();

  const capabilities = await probeCapabilities({
    agentId: '', // overwritten by the Controller-assigned ID once known
    displayName: config.displayName,
    maxJobs: config.maxJobs,
    stateDir: config.stateDir,
    repoCacheDir: config.repoCacheDir,
    diskMinFreeBytes: config.diskMinFreeBytes,
    enabledBuildCacheKinds: config.buildCache.enabledKinds,
    configuredPriority: config.configuredPriority,
  });

  logger.info('agent starting', {
    version: RBO_AGENT_VERSION,
    controller: config.controllerUrl,
    displayName: config.displayName,
  });

  let attempt = 0;
  let stopped = false;
  process.on('SIGINT', () => {
    stopped = true;
  });
  process.on('SIGTERM', () => {
    stopped = true;
  });
  // Daemon safety net: a single async handler failure must not kill the Agent.
  // Call sites still catch and log; this covers any remaining fire-and-forget gaps.
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandledRejection', { error: String(reason) });
  });

  const connection = new AgentConnection({
    controllerUrl: config.controllerUrl,
    expectedFingerprint: config.controllerFingerprint,
    stateDir: config.stateDir,
    repoCacheDir: config.repoCacheDir,
    displayName: config.displayName,
    capabilities,
    secretMap: config.secretMap,
    gitAllowlist: config.gitAllowlist,
    repoCache: config.repoCache,
    buildCache: config.buildCache,
    maxJobs: config.maxJobs,
    logSpoolMaxBytes: config.logSpoolMaxBytes,
    logSendQueueMax: config.logSendQueueMax,
    diskMinFreeBytes: config.diskMinFreeBytes,
    getFreeDiskBytes: () => cachedFreeBytes,
  });

  while (!stopped) {
    try {
      const result = await connection.connectOnce();
      attempt = 0;

      if (result.status === 'authenticated') {
        logger.info('agent authenticated', { agentId: result.agentId });
        // Heartbeats run inside AgentConnection; wait until disconnect or stop.
        await Promise.race([connection.waitUntilDisconnected(), waitUntil(() => stopped)]);
      } else if (result.status === 'pairing_pending') {
        logger.info('pairing request pending operator approval');
        await sleep(RECONNECT_BASE_DELAY_MS);
      } else {
        logger.warn('connection did not authenticate', { status: result.status });
        await sleep(RECONNECT_BASE_DELAY_MS);
      }
    } catch (error) {
      attempt += 1;
      const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** attempt, RECONNECT_MAX_DELAY_MS);
      logger.error('connection failed, retrying', { error: String(error), retry_in_ms: delay });
      await sleep(delay);
    } finally {
      // Park attempt for reconnect; kill only when the agent process is stopping.
      connection.close({ killProcess: stopped });
    }
  }

  clearInterval(freeDiskTimer);
  connection.close({ killProcess: true });
  logger.info('agent stopped');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitUntil(predicate: () => boolean): Promise<void> {
  return new Promise((resolvePromise) => {
    const interval = setInterval(() => {
      if (predicate()) {
        clearInterval(interval);
        resolvePromise();
      }
    }, 250);
    interval.unref?.();
  });
}
