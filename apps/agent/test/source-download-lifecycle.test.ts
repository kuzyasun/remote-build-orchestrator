import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LeaseOfferPayloadSchema } from '@rbo/protocol';
import { ensureControllerIdentity } from '@rbo/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { AgentJobExecutor } from '../src/executor/index.js';
import { DEFAULT_REPO_CACHE_CONFIG } from '../src/repos/mirror.js';

function mockSocket() {
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const socket = {
    readyState: 1,
    OPEN: 1,
    send(raw: string) {
      sent.push(JSON.parse(raw));
    },
  } as unknown as WebSocket;
  return { socket, sent };
}

describe('Agent source download lifecycle', () => {
  let identityDir: string;
  let identity: Awaited<ReturnType<typeof ensureControllerIdentity>>;
  const lease = { attempt_id: 'att_source', lease_id: 'lease_source', lease_epoch: 1 };

  beforeAll(async () => {
    identityDir = await mkdtemp(join(tmpdir(), 'rbo-source-identity-'));
    identity = await ensureControllerIdentity(identityDir);
  });

  afterAll(async () => {
    await rm(identityDir, { recursive: true, force: true });
  });

  it.each(['cancel', 'disconnect', 'deadline'] as const)(
    'stops a stalled HTTPS transfer on %s and releases its workspace and slot',
    async (action) => {
      const stateDir = await mkdtemp(join(tmpdir(), 'rbo-source-'));
      const started = Promise.withResolvers<void>();
      const closed = vi.fn();
      const server = createServer(
        { cert: identity.tlsCertPem, key: identity.tlsKeyPem },
        (_req, res) => {
          res.once('close', closed);
          if (action !== 'deadline') {
            res.writeHead(200, { 'Content-Length': '64' });
            res.write('partial source');
          }
          started.resolve();
        },
      );
      const { socket, sent } = mockSocket();
      const reconnect = mockSocket();
      const executor = new AgentJobExecutor(socket, {
        stateDir,
        controllerFingerprint: identity.fingerprint,
        gitAllowlist: { schemes: ['https'], hosts: ['github.com'] },
        repoCache: DEFAULT_REPO_CACHE_CONFIG,
      });
      let preparing: Promise<void> | undefined;

      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', resolve);
        });
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Expected TCP server address');

        if (action === 'deadline') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const offer = LeaseOfferPayloadSchema.parse({
          ...lease,
          job_id: 'job_source',
          job_request: {
            client_request_id: 'req_source',
            source: { project_root: stateDir, cwd: '.' },
            execution: { script: 'echo source' },
          },
          snapshot_metadata: {
            snapshot_id: 'snp_source',
            content_id: 'cid',
            size_bytes: 64,
            sha256: 'ab',
          },
          lease_ttl_seconds: 300,
        });
        executor.handleLeaseOffer(offer);
        preparing = executor.handlePrepareSource({
          ...lease,
          source_mode: 'full',
          download_url: `https://127.0.0.1:${address.port}/snapshot`,
          data_token: 'test-token',
          expected_size_bytes: 64,
          expected_sha256: '0'.repeat(64),
        });
        await started.promise;
        const workspace = join(stateDir, 'workspaces', lease.attempt_id);
        const partial = join(workspace, 'snapshot.tar.zst.part');
        if (action !== 'deadline') {
          await vi.waitFor(async () => expect((await stat(partial)).size).toBeGreaterThan(0));
        }

        if (action === 'cancel') {
          await executor.handleCancelJob({ ...lease, grace_seconds: 1 });
        } else if (action === 'disconnect') {
          const abandoning = executor.abandonOnDisconnect();
          executor.attachSocket(reconnect.socket);
          await abandoning;
        } else {
          await vi.advanceTimersByTimeAsync(15 * 60_000);
          vi.useRealTimers();
        }

        await preparing;
        await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
        await expect(access(workspace)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(executor.getActiveJobs()).toEqual([]);
        expect(sent.some((frame) => frame.type === 'source_ready')).toBe(false);

        const exit = sent.find((frame) => frame.type === 'job_exit');
        if (action === 'cancel') {
          expect(exit?.payload).toMatchObject({ outcome: 'cancelled' });
        } else if (action === 'deadline') {
          expect(exit?.payload).toMatchObject({
            outcome: 'failed',
            failure_category: 'materialization',
            failure_message: expect.stringContaining('Source download deadline exceeded'),
          });
        } else {
          expect(exit).toBeUndefined();
          expect(reconnect.sent).toEqual([]);
        }
        executor.handleLeaseOffer({ ...offer, attempt_id: 'att_next', lease_id: 'lease_next' });
        expect(executor.getActiveAttemptId()).toBe('att_next');
      } finally {
        vi.useRealTimers();
        await executor.forceAbandon();
        await preparing?.catch(() => undefined);
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(stateDir, { recursive: true, force: true });
      }
    },
  );
});
