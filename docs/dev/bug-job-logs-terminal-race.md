# Bug writeup: `job_logs` loses all chunks after the first write on fast jobs (terminal-state race)

> Status: untriaged writeup, 2026-09-25. Code references are as of commit
> `145f4273f0f2be46d674c0e14089f3b38acc15eb` (branch `feat/agent-discovery`).
> Paste-ready as a GitHub issue.

## Title

`job_logs` returns only the first stdout chunk (`has_more:false`) after a fast job completes — late `log_chunk` frames dropped on terminal transition

## Summary

A short job (~0.3 s, several small stdout writes, no artifacts) completes successfully
(`exit_code: 0`), but a subsequent MCP `job_logs` call (mode `logs`, null cursor) returns only
the FIRST stdout write and reports `has_more: false`. Chunks 2..N are permanently lost:
re-reading with `next_cursor` returns nothing, and the agent-side spool was already drained and
acked. The job itself still reports success, so the loss is silent.

This is not the documented token-economy behavior: `ai-efficiency-performance-plan.md` §5.3
keeps `job_run` success responses log-free by design but explicitly states "Raw logs remain
available through `job_logs`", and `apps/controller/test/job-logs.test.ts` asserts the full
durable log is paged back once all chunks are ingested.

## Reproduction (observed 2026-09-25)

Controller on Windows host + macOS agent (`mac-agent`, TS executor path), via MCP:

1. `job_run` with `shell: "bash"`, `target_os: ["macos"]`, no artifacts, command:
   ```
   uname -a; sw_vers; git --version; python3 --version; ls
   ```
2. Job `job_01M3AVR2NEEYGY67KR32G2ME9X` completes in 0.264 s (started 23:24:32.225Z,
   finished 23:24:32.489Z), `outcome: "succeeded"`, `exit_code: 0`.
3. `job_logs {job_id, mode: "logs", max_bytes: 8192}` returns exactly one chunk — the
   `uname -a` line (146 bytes), `returned_bytes: 146`, `has_more: false`.
4. Control experiment `job_01M3AVSBMGF14CPDACPF0K5Q9H`: same script prefixed with
   `echo '=== MARKER START ===';` → only that first marker line returned (21 bytes),
   `has_more: false`.
5. Control experiment `job_01M3AVT1PZCEF5F54N8K5E7H3W`: identical commands aggregated into a
   single write (`echo "$(uname -a; sw_vers; …)"`) → the full output (844 bytes, 2 chunks)
   is returned.

Step 5 proves the script executed fully and the pipe was captured by the agent; only the
controller-side ingest lost everything after the first write.

## Expected behavior

Once an attempt is terminal, `job_logs` from a null cursor must return the complete durable
log for that attempt (paged via cursor), per design doc §23.5 and the existing tests.

## Suspected root cause

- `apps/controller/src/websocket/server.ts` (~481–523): `log_chunk` frames are handled
  asynchronously via the per-attempt `logChunkChains` queue
  (`enqueueRemoteLogChunk`, `apps/controller/src/execution/remote-execution.ts` ~1064–1091;
  DB read + two file appends + DB write + ack per chunk), while `job_exit` and
  `cleanup_complete` are handled synchronously and immediately advance the attempt to
  `collecting_artifacts` → `completed`.
- Nothing drains the per-attempt log chain before the terminal transition. Late chunks hit
  the state guard in `rejectStale` (`remote-execution.ts` ~480–503), which accepts
  `log_chunk` only in `running` / `collecting_artifacts`; frames arriving after `completed`
  are dropped with `unexpected state for log_chunk ignored` — silently, unacked.
- The agent's `SpoolSender` (`apps/agent/src/executor/../logs/spool-sender.ts`) replays only
  on reconnect/adopt or after an ack-overflow, so the dropped frames are never re-sent within
  the session; after the attempt is terminal even reconnect replay would be rejected by the
  same state guard. The drop is permanent.
- Secondary loss path: out-of-order frames (`sequence !== prev + 1`) are dropped without ack
  (`remote-execution.ts` ~1041–1049) and likewise have no in-session replay.
- The SSE stream path already compensates for late persists with a "quiet-loop drain"
  (`apps/controller/src/logs/stream.ts` ~282–338); the durable-store/MCP path has no
  equivalent.

Fast jobs with several small writes and no artifacts maximize the race:
`cleanup_complete` follows `job_exit` within one or two WS round-trips and overtakes the
chunk chain.

## Confirming evidence

Controller logs for an affected attempt should contain one of:

- `unexpected state for log_chunk ignored` (state-guard drop), or
- `out-of-order log_chunk ignored` (sequence-gap drop)

together with the attempt id, and the controller's `attempts/<id>/logs/` directory should
contain only chunk 1 in `chunks.jsonl`.

## Suggested fix directions

1. Drain (await) the per-attempt `logChunkChains` before applying the terminal transition on
   `job_exit` / `cleanup_complete`, so every accepted frame is persisted first.
2. Alternatively, widen `log_chunk` ingestion so contiguous late frames
   (`sequence === prev + 1`) are still appended, persisted, and acked after the attempt is
   terminal.
3. Add a regression test: submit a job that emits N small writes and exits quickly with no
   artifacts; after terminal completion, `job_logs` must return all N chunks
   (complements the serialization test in `apps/controller/test/log-spool.test.ts` ~177).

## Client-side workaround

Aggregate output into a single write (`echo "$(cmd1; cmd2; …)"`) or collect output through
job `artifacts` instead of relying on `job_logs` for short jobs.
