/**
 * Agent process kill+respawn with the same state dir must re-emit recovery_report.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatProcessIdentity } from '@rbo/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { writeAttemptMetadata } from '../src/recovery/attempt-metadata.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER = join(__dirname, 'fixtures', 'restart-recovery-worker.mjs');

const ATTEMPT_ID = 'att_restart_1';
const TEST_IDENTITY = formatProcessIdentity(99, 1_700_000_000_000);

function spawnRecoveryWorker(
  stateDir: string,
  wsPort: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER], {
      env: {
        ...process.env,
        RBO_STATE_DIR: stateDir,
        RBO_WS_PORT: String(wsPort),
        RBO_ATTEMPT_ID: ATTEMPT_ID,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code !== 0) {
        reject(new Error(`worker exited ${code}: ${stderr}`));
        return;
      }
      resolve({ code, signal });
    });
  });
}

describe('Agent restart reattach (Task 9)', () => {
  let stateDir: string;
  let httpServer: ReturnType<typeof createServer>;
  let wss: WebSocketServer;
  let wsPort = 0;
  const reports: Array<{ attempt_id: string; process_identity: string }> = [];

  afterEach(async () => {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    reports.length = 0;
    if (stateDir) {
      await rm(stateDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function bootWsServer(): Promise<void> {
    httpServer = createServer();
    wss = new WebSocketServer({ server: httpServer });
    wss.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const frame = JSON.parse(String(raw)) as {
          type: string;
          payload?: { attempt_id: string; process_identity: string };
        };
        if (frame.type === 'recovery_report' && frame.payload) {
          reports.push({
            attempt_id: frame.payload.attempt_id,
            process_identity: frame.payload.process_identity,
          });
        }
      });
    });
    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = httpServer.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('expected bound TCP port');
    }
    wsPort = addr.port;
  }

  it('kill+respawn re-sends recovery_report from persisted metadata', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'rbo-agent-restart-'));
    await bootWsServer();

    writeAttemptMetadata(stateDir, {
      attempt_id: ATTEMPT_ID,
      job_id: 'job_restart',
      lease_id: 'lease_restart',
      lease_epoch: 1,
      process_identity: TEST_IDENTITY,
      status: 'orphaned',
      workspace_path: join(stateDir, 'workspaces', ATTEMPT_ID),
      spool_dir: join(stateDir, 'logs', ATTEMPT_ID),
      risk_level: 'safe',
      updated_at: new Date().toISOString(),
    });

    await spawnRecoveryWorker(stateDir, wsPort);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toEqual({
      attempt_id: ATTEMPT_ID,
      process_identity: TEST_IDENTITY,
    });

    await spawnRecoveryWorker(stateDir, wsPort);
    expect(reports).toHaveLength(2);
    expect(reports[1]).toEqual(reports[0]);
  });
});
