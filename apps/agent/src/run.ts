import { addAbortListener } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { RBO_AGENT_VERSION, createLogger, generateId } from '@rbo/shared';
import { probeCapabilities } from './capabilities/probe.js';
import {
  type AgentConfig,
  ensureStateDir,
  loadAgentConfig,
  persistAgentControllerUrl,
} from './config.js';
import { AgentConnection } from './connection/client.js';
import {
  CONTROLLER_MDNS_REFRESH_INTERVAL_MS,
  discoverRelocatedControllerUrl,
} from './controller-refresh.js';
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
  // An explicit URL (env or caller) stays pinned. The file URL from discovery can go stale.
  const rediscoveryEnabled =
    overrides.controllerUrl === undefined && process.env.RBO_CONTROLLER_URL === undefined;
  let controllerUrl = config.controllerUrl;

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
    controller: controllerUrl,
    displayName: config.displayName,
    mdns_refresh: rediscoveryEnabled,
  });

  let attempt = 0;
  let stopped = false;
  // Daemon safety net: a single async handler failure must not kill the Agent.
  // Call sites still catch and log; this covers any remaining fire-and-forget gaps.
  const onUnhandledRejection = (reason: unknown) => {
    logger.error('unhandledRejection', { error: String(reason) });
  };
  process.on('unhandledRejection', onUnhandledRejection);

  const reportStatus = (status: {
    connection: AgentRuntimeConnection;
    agent_id?: string;
    detail?: string;
  }) => {
    try {
      writeAgentRuntimeStatus(config.stateDir, {
        ...status,
        controller_url: controllerUrl,
      });
    } catch (error) {
      logger.warn('failed to write runtime status', { error: String(error) });
    }
  };

  const connection = new AgentConnection({
    controllerUrl,
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

  const stopAbort = new AbortController();
  const stop = () => {
    stopped = true;
    stopAbort.abort();
    connection.close({ killProcess: true });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  let refreshInFlight: Promise<void> | null = null;
  let sessionOpen = false;

  const refreshControllerLocation = (): Promise<void> => {
    if (!rediscoveryEnabled || stopped) {
      return Promise.resolve();
    }
    if (refreshInFlight) {
      return refreshInFlight;
    }
    const run = async () => {
      const next = await discoverRelocatedControllerUrl({
        currentUrl: controllerUrl,
        fingerprint: config.controllerFingerprint,
        signal: stopAbort.signal,
      });
      if (!next || stopped || next === controllerUrl) {
        return;
      }
      logger.info('controller address updated from mDNS', {
        from: controllerUrl,
        controller: next,
      });
      controllerUrl = next;
      connection.setControllerUrl(next);
      try {
        persistAgentControllerUrl(config.stateDir, next);
      } catch (error) {
        logger.warn('failed to persist controller url', { error: String(error) });
      }
      reportStatus({
        connection: sessionOpen ? 'authenticated' : 'connecting',
      });
      connection.dropIfOpenToOtherUrl(next);
    };
    refreshInFlight = run().finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  };

  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  if (rediscoveryEnabled) {
    await refreshControllerLocation();
    refreshTimer = setInterval(() => {
      void refreshControllerLocation();
    }, CONTROLLER_MDNS_REFRESH_INTERVAL_MS);
    refreshTimer.unref?.();
  }

  while (!stopped) {
    reportStatus({ connection: 'connecting' });
    try {
      const result = await connection.connectOnce();
      attempt = 0;

      if (result.status === 'authenticated') {
        logger.info('agent authenticated', { agentId: result.agentId });
        reportStatus({ connection: 'authenticated', agent_id: result.agentId });
        sessionOpen = true;
        // Heartbeats run inside AgentConnection; wait until disconnect or stop.
        await waitForDisconnect(connection, stopAbort.signal);
        sessionOpen = false;
        if (!stopped) {
          reportStatus({ connection: 'disconnected', agent_id: result.agentId });
        }
      } else if (result.status === 'pairing_pending') {
        logger.info('pairing request pending operator approval');
        reportStatus({ connection: 'pairing_pending' });
        await sleep(RECONNECT_BASE_DELAY_MS, stopAbort.signal);
      } else if (result.status === 'incompatible_protocol') {
        logger.warn('connection did not authenticate', { status: result.status });
        reportStatus({ connection: 'incompatible_protocol' });
        await sleep(RECONNECT_BASE_DELAY_MS, stopAbort.signal);
      } else {
        logger.warn('connection did not authenticate', { status: result.status });
        reportStatus({ connection: 'rejected', detail: result.status });
        await sleep(RECONNECT_BASE_DELAY_MS, stopAbort.signal);
      }
    } catch (error) {
      if (stopped) {
        break;
      }
      const detail = error instanceof Error ? error.message : String(error);
      const previousUrl = controllerUrl;
      await refreshControllerLocation();
      if (controllerUrl !== previousUrl) {
        attempt = 0;
        logger.info('connection failed; retrying at discovered controller address', {
          error: detail,
          controller: controllerUrl,
        });
        reportStatus({ connection: 'connecting' });
        continue;
      }
      attempt += 1;
      const retryDelay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** attempt, RECONNECT_MAX_DELAY_MS);
      logger.error('connection failed, retrying', { error: detail, retry_in_ms: retryDelay });
      reportStatus({ connection: 'error', detail });
      await sleep(retryDelay, stopAbort.signal);
    } finally {
      // Park attempt for reconnect; kill only when the agent process is stopping.
      connection.close({ killProcess: stopped });
    }
  }

  reportStatus({ connection: 'stopped' });

  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
  stopAbort.abort();
  clearInterval(freeDiskTimer);
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  process.off('unhandledRejection', onUnhandledRejection);
  connection.close({ killProcess: true });
  logger.info('agent stopped');
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch (error) {
    if (!signal.aborted) {
      throw error;
    }
  }
}

async function waitForDisconnect(connection: AgentConnection, signal: AbortSignal): Promise<void> {
  let stopListener: ReturnType<typeof addAbortListener> | undefined;
  const stopped = new Promise<void>((resolve) => {
    stopListener = addAbortListener(signal, () => resolve());
  });
  try {
    await Promise.race([connection.waitUntilDisconnected(), stopped]);
  } finally {
    stopListener?.[Symbol.dispose]();
  }
}
