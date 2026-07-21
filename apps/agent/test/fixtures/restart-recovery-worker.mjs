import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';

const stateDir = process.env.RBO_STATE_DIR;
const wsPort = process.env.RBO_WS_PORT;
const attemptId = process.env.RBO_ATTEMPT_ID;
if (!stateDir || !wsPort || !attemptId) {
  console.error('RBO_STATE_DIR, RBO_WS_PORT, RBO_ATTEMPT_ID required');
  process.exit(2);
}

const metaPath = join(stateDir, 'attempts', attemptId, 'metadata.json');
const meta = JSON.parse(readFileSync(metaPath, 'utf8'));

const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
ws.on('open', () => {
  ws.send(
    JSON.stringify({
      protocol: 1,
      type: 'recovery_report',
      message_id: `msg_${Date.now()}`,
      sent_at: new Date().toISOString(),
      attempt_id: meta.attempt_id,
      lease_id: meta.lease_id,
      lease_epoch: meta.lease_epoch,
      payload: {
        attempt_id: meta.attempt_id,
        lease_id: meta.lease_id,
        lease_epoch: meta.lease_epoch,
        status: 'orphaned',
        process_identity: meta.process_identity,
        last_sent_sequence: 0,
        last_acked_sequence: 0,
        artifact_upload_pending: false,
      },
    }),
  );
  setTimeout(() => {
    ws.close();
    process.exit(0);
  }, 200);
});
ws.on('error', (err) => {
  console.error(err);
  process.exit(1);
});
