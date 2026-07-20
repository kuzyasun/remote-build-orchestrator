### Task 2: Agent disk spool, bounded sender, Controller idempotent append + `log_ack`

**Files:**
- Create: `packages/executor/src/spool.ts`
- Modify: `packages/executor/src/index.ts`, `packages/executor/src/logs.ts` (reuse paths; spool owns sequence index)
- Create: `packages/executor/test/spool.test.ts`
- Create: `apps/agent/src/logs/spool-sender.ts`
- Modify: `apps/agent/src/executor/index.ts` (disk-first + sender; stop fire-and-forget live-only send)
- Modify: `apps/agent/src/config.ts` â€” `RBO_LOG_SPOOL_MAX_BYTES` (default e.g. `536870912`), `RBO_LOG_SEND_QUEUE_MAX` (default e.g. `64`)
- Modify: `apps/controller/src/execution/remote-execution.ts` â€” `handleRemoteLogChunk` idempotent + send ack
- Modify: `apps/controller/src/websocket/server.ts` â€” handle sending `log_ack` (via connectedAgents send helper)
- Create: `apps/controller/test/log-spool.test.ts`

**Interfaces:**
- Consumes: Task 1 schemas; `ensureAttemptLogs`; `appendLogChunk`
- Produces:
  - `AttemptSpool` API:
    - `openAttemptSpool(spoolDir): Promise<AttemptSpool>`
    - `appendChunk(spool, stream, bytes): Promise<{ sequence: number }>` â€” assigns next sequence, appends to stream file **and** appends a line to `chunks.jsonl` `{sequence,stream,offset,length}` (or equivalent index) so replay can re-read exact chunks without splitting UTF-8 incorrectly
    - `readAck(spool): Promise<number>` / `writeAck(spool, sequence): Promise<void>` â€” atomic replace of `ack.json` via temp+rename
    - `iterUnacked(spool, afterSequence): AsyncIterable<{sequence,stream,bytes}>`
    - `totalBytes(spool): Promise<number>`
  - `SpoolSender` on Agent: bounded queue; `enqueue(chunk)`; `onAck(sequence)`; `startReplay()`; never blocks the job process; when spool bytes â‰¥ max â†’ fail attempt with `log_spool_limit`
  - Controller: store highest contiguous acked sequence in `job_attempts.log_acked_sequence`; ignore duplicate sequence (still ack); reject gap? Prefer: accept only `sequence === log_acked_sequence + 1` for new append; if `sequence <= log_acked_sequence` â†’ ack again without append; if `sequence > log_acked_sequence + 1` â†’ ignore/log (agent must replay in order)

**Spool layout (canonical):**

```text
{stateDir}/logs/<attempt-id>/
  stdout.log
  stderr.log
  events.jsonl
  chunks.jsonl    # one JSON object per chunk: {sequence,stream,byte_offset,byte_length}
  ack.json        # {"acked_sequence": N}
```

Agent workspace logs under `workspaces/<id>/logs` may remain for local debugging OR be redirected to the spool dir via the same `AttemptLogPaths` â€” prefer **one** directory: pass spool dir into `ensureAttemptLogs` so job script env `RBO_LOG_DIR` points at the spool.

- [ ] **Step 1: Write failing spool unit tests** (`packages/executor/test/spool.test.ts`)

Cover: sequence allocation starts at 1; disk append before return; `writeAck` atomic; `iterUnacked` returns only `sequence > acked` in order; duplicate read after ack empty; `totalBytes` grows.

- [ ] **Step 2: Implement `spool.ts` + export; GREEN unit tests**

- [ ] **Step 3: Write failing Controller idempotent test**

In `apps/controller/test/log-spool.test.ts` (unit-level with temp dataDir + in-memory/db fixture patterned after `remote-execution.test.ts`):

1. First `log_chunk` sequence=1 appends bytes and would emit ack sequence=1.
2. Replay same sequence=1 does not duplicate file bytes; ack still 1.
3. sequence=3 before 2 is ignored (no append).
4. `job_logs` cursor reads durable bytes once.

- [ ] **Step 4: Implement Controller `handleRemoteLogChunk` + `log_ack` send**

Pseudocode:

```typescript
const prev = attempt.log_acked_sequence ?? 0;
if (payload.sequence <= prev) {
  sendLogAck(...); // duplicate ack
  return;
}
if (payload.sequence !== prev + 1) {
  // out of order â€” do not append
  return;
}
await appendLogChunk(...);
updateAttempt({ log_acked_sequence: payload.sequence });
sendLogAck(agent, { attempt_id, lease_id, lease_epoch, sequence: payload.sequence });
```

Wire Agent handler for inbound `log_ack` â†’ `spoolSender.onAck` + `writeAck`.

- [ ] **Step 5: Replace Agent live-only send with spool + bounded sender**

On each stdout/stderr data: redact â†’ `appendChunk` (await) â†’ `sender.enqueue`. Sender drains WS when open; on reconnect (Task 3 will call `startReplay`). If `totalBytes > max` â†’ kill job / `job_exit` with `failure_category: 'log_spool_limit'`.

- [ ] **Step 6: GREEN targeted tests**

Run: `pnpm exec vitest run packages/executor/test/spool.test.ts apps/controller/test/log-spool.test.ts`
Also re-run any agent cancel/log tests that mock `appendLogChunk`.

- [ ] **Step 7: Report** â†’ `.superpowers/sdd/task-2-report.md`

---
