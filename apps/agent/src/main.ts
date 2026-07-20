import { RBO_AGENT_VERSION, createLogger } from '@rbo/shared';
import { probeCapabilities } from './capabilities/probe.js';
import { ensureStateDir, loadAgentConfig } from './config.js';
import { AgentConnection } from './connection/client.js';

const logger = createLogger('agent.main');

const RECONNECT_BASE_DELAY_MS = 2_000;
const RECONNECT_MAX_DELAY_MS = 60_000;

async function main(): Promise<void> {
  const config = loadAgentConfig();
  ensureStateDir(config);

  const capabilities = await probeCapabilities({
    agentId: '', // overwritten by the Controller-assigned ID once known
    displayName: config.displayName,
    maxJobs: config.maxJobs,
    stateDir: config.stateDir,
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

  while (!stopped) {
    const connection = new AgentConnection({
      controllerUrl: config.controllerUrl,
      expectedFingerprint: config.controllerFingerprint,
      stateDir: config.stateDir,
      displayName: config.displayName,
      capabilities,
      secretMap: config.secretMap,
      gitAllowlist: config.gitAllowlist,
      repoCache: config.repoCache,
    });

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
      connection.close();
    }
  }

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

main().catch((error) => {
  console.error(`rbo-agent failed: ${String(error)}`);
  process.exit(1);
});
