import { RBO_AGENT_VERSION, createLogger, generateId } from '@rbo/shared';
import { probeCapabilities } from './capabilities/probe.js';
import { type AgentConfig, ensureStateDir, loadAgentConfig } from './config.js';
import { AgentConnection } from './connection/client.js';
import { type AgentRuntimeConnection, writeAgentRuntimeStatus } from './runtime-status.js';

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
  // Process-identity marker: generated once per process start, reused across network reconnects.
  // The Controller detects a restart by comparing to the last known boot_id and sweeps leaked
  // in-flight attempts pinned to this Agent.
  const bootId = generateId('boot');
  capabilities.boot_id = bootId;

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

  const reportStatus = (status: {
    connection: AgentRuntimeConnection;
    agent_id?: string;
    detail?: string;
  }) => {
    try {
      writeAgentRuntimeStatus(config.stateDir, {
        ...status,
        controller_url: config.controllerUrl,
      });
    } catch (error) {
      logger.warn('failed to write runtime status', { error: String(error) });
    }
  };

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
    reportStatus({ connection: 'connecting' });
    try {
      const result = await connection.connectOnce();
      attempt = 0;

      if (result.status === 'authenticated') {
        logger.info('agent authenticated', { agentId: result.agentId });
        reportStatus({ connection: 'authenticated', agent_id: result.agentId });
        // Heartbeats run inside AgentConnection; wait until disconnect or stop.
        await Promise.race([connection.waitUntilDisconnected(), waitUntil(() => stopped)]);
        if (!stopped) {
          reportStatus({ connection: 'disconnected', agent_id: result.agentId });
        }
      } else if (result.status === 'pairing_pending') {
        logger.info('pairing request pending operator approval');
        reportStatus({ connection: 'pairing_pending' });
        await sleep(RECONNECT_BASE_DELAY_MS);
      } else if (result.status === 'incompatible_protocol') {
        logger.warn('connection did not authenticate', { status: result.status });
        reportStatus({ connection: 'incompatible_protocol' });
        await sleep(RECONNECT_BASE_DELAY_MS);
      } else {
        logger.warn('connection did not authenticate', { status: result.status });
        reportStatus({ connection: 'rejected', detail: result.status });
        await sleep(RECONNECT_BASE_DELAY_MS);
      }
    } catch (error) {
      attempt += 1;
      const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** attempt, RECONNECT_MAX_DELAY_MS);
      const detail = error instanceof Error ? error.message : String(error);
      logger.error('connection failed, retrying', { error: String(error), retry_in_ms: delay });
      reportStatus({ connection: 'error', detail });
      await sleep(delay);
    } finally {
      // Park attempt for reconnect; kill only when the agent process is stopping.
      connection.close({ killProcess: stopped });
    }
  }

  reportStatus({ connection: 'stopped' });

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
