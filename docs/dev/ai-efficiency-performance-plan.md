# AI Efficiency, Logging, Snapshot, and CLI Development Plan

Status: reviewed for coordinator-led execution  
Created: 2026-08-19  
Revision: 6  
Target: pre-1.0 development line

> [!IMPORTANT]
> This document is an implementation plan, not an architecture or protocol source of truth.
> Nearby code and tests, `packages/protocol`, and `remote-build-orchestrator-design.md` remain
> authoritative. Any accepted wire-contract change must update those sources together.

## 1. Outcome

Make RBO measurably cheaper and easier for AI clients to use while improving latency and large
workspace behavior. The selected work covers:

1. correctly ordered incremental logs with exact byte-range resume;
2. bounded and compact MCP responses;
3. ANSI/OSC cleanup in AI-facing log presentation;
4. event-driven job waiting;
5. pull-request and push CI;
6. direct streaming snapshot compression;
7. explicit cross-platform shell selection in `job_run`;
8. a human-friendly `rbo run` command.

The implementation must preserve raw durable logs, immutable snapshot guarantees, Agent fencing,
secret redaction, artifact containment, and local/remote execution parity.

## 2. Scope boundaries

### In scope

- `job_logs` cursor and response redesign.
- Incremental `job_run` resume with a hard log-response budget.
- Compact terminal responses with sparse optional fields.
- Presentation-only ANSI CSI and OSC stripping.
- In-memory job-state notifications with a database recovery fallback.
- CI on pull requests and pushes for Windows and Linux.
- Streaming tar directly into zstd without a full uncompressed temporary tar.
- Snapshot byte/file limits and bounded memory behavior.
- Optional explicit `shell` and target OS in `job_run`; queue policy is a separate decision gate.
- `rbo run -- <shell-command-string>` with wait, follow, cancellation, and JSON output modes.
- Focused benchmarks and metrics needed to validate this work.

### Deferred

- `rbo watch`.
- mDNS/Zeroconf discovery.
- A custom shared or peer-to-peer build cache.
- Linux/macOS sandboxing and resource isolation.
- A full observability dashboard or long-term metrics store.
- Controller snapshot/log/artifact retention and garbage collection.
- General scheduler refactoring beyond changes required by cross-platform `job_run`.
- Broad decomposition of large source modules.

## 3. Coordinator execution protocol

This plan is intended to be executed by one coordinator agent that delegates bounded work to
worker agents and independently reviews every handoff. A worker's statement that a task is done is
never sufficient to advance the plan.

### 3.1 Roles

#### Coordinator

The coordinator owns:

- the task ledger and dependency order;
- decision gates and requests for user direction;
- Git/worktree hygiene and preservation of unrelated changes;
- worker selection, prompts, file scopes, and parallelism;
- independent review of every worker diff;
- independent validation after every accepted task;
- integration across packages and final completion reporting.

The coordinator must read the relevant implementation and tests before delegating. It must not
delegate interpretation of repository guidance, protocol authority, or acceptance criteria.

#### Implementation worker

An implementation worker receives exactly one work package. It may inspect adjacent code needed
for that package, but it may edit only the paths listed in its delegation brief. It must:

- preserve unrelated working-tree changes;
- avoid staging, committing, pushing, publishing, or opening a pull request;
- avoid broad formatting or refactoring;
- run the narrow validations named in the brief;
- return a structured handoff with limitations and exact commands/results.

#### Optional review or verification worker

For high-risk protocol, snapshot, lifecycle, and cross-platform changes, the coordinator may ask a
separate read-only worker to inspect the implementation. This supplements, but never replaces, the
coordinator's own review.

### 3.2 Task state machine

The coordinator tracks every task using these states:

```text
pending -> ready -> delegated -> worker_handoff -> coordinator_review
        -> revision_required -> delegated
        -> accepted -> independently_verified -> complete
```

Terminal or paused outcomes outside the happy path are:

- `rejected_by_decision`: the user rejected an optional decision-gated task;
- `operator_required`: implementation is locally complete, but named external infrastructure or a
  real-platform smoke must still be performed by an operator;
- `blocked`: a concrete dependency cannot be satisfied in the current environment.

Rules:

- A task becomes `ready` only when every dependency and decision gate is complete.
- F-03 is the reporting exception: it may start after F-02 when every E gate has either completed or
  has a precise recorded `operator_required`/`blocked` status; this does not make release readiness
  complete.
- Only the coordinator changes a task to `accepted`, `independently_verified`, or `complete`.
- Any review finding returns the task to `revision_required` with a focused fix brief.
- After a revision, the coordinator rereads the complete task diff, not only the latest patch.
- A local implementation phase gate cannot pass while any required local task in that phase is
  incomplete. An external release gate may remain `operator_required` without being mislabeled as
  complete.
- A later task may not hide or compensate for an unresolved earlier finding.

### 3.3 Shared-workspace safety

Before every delegation, the coordinator records:

```powershell
git status --short --branch
git diff --cached --name-only
git diff -- <allowed paths>
```

The coordinator includes the observed baseline in the worker brief. Workers must not modify the Git
index. If the worktree is dirty, ownership of every overlapping file must be established before a
worker is started.

Parallel workers are allowed only when all of the following are true:

- their editable path sets are disjoint;
- neither task changes a shared wire contract, root manifest, lockfile, formatter output, or
  generated packaging manifest;
- neither task depends on unreviewed output from the other;
- the coordinator can review and accept each diff independently.

Do not run two implementation workers concurrently in the same package unless their exact files
are disjoint and both tasks are read-only outside those files. Protocol, lifecycle, snapshot
capture, root scripts, and final formatting tasks run sequentially.

Workers do not run repository-wide `pnpm format`. The coordinator runs it at a phase or final gate
after checking that the only pending changes are understood. Any formatting changes outside the
accepted scope must be investigated and reverted only with clear ownership.

### 3.4 Decision gates

The following material choices must be presented to the user before implementation unless the user
has explicitly approved this reviewed plan as the decision record:

| Gate | Decision | Required record |
| --- | --- | --- |
| DG-LOG | Replace the synthetic byte cursor with an opaque attempt/mode-scoped resumable cursor | Partial-chunk behavior, ANSI carry state, stale-attempt behavior, examples, version impact |
| DG-BUDGET | Default/minimum response budgets and sparse success response | Exact defaults, minimum 4-byte progress rule, truncation behavior, artifact behavior |
| DG-SNAPSHOT | Stream directly from opened source handles and add capture limits | Fail-closed identity checks, candidate/final ownership, capture lease, fsync/rename order, default limits, operator override path |
| DG-SHELL | Add explicit shell/target OS and define omitted-shell behavior | Matching semantics, canonical OS values, no automatic shell translation |
| DG-QUEUE | Decide whether compact `job_run` exposes queue policy in this delivery | Separate public-input decision and scheduling/fallback test scope |
| DG-CLI | Define `rbo run` quoting, timeout, confirmation, cancellation, output modes, SSE reconnect, and exit statuses | CLI examples, remote-vs-wait timeout semantics, non-interactive behavior, cursor-domain separation, exact status table |

The coordinator records each decision as `approved`, `rejected`, or `revised`. A worker must not be
asked to choose a material public contract while implementing it.

### 3.5 Delegation brief template

Every worker prompt uses this minimum structure:

```text
Task ID and title:
Objective:
Dependencies already accepted:
Repository guidance and source-of-truth files to read:
Allowed edit paths:
Read-only context paths:
Explicitly forbidden changes:
Required behavior and acceptance criteria:
Required targeted validation:
Expected handoff format:
Known baseline Git status and overlapping user changes:
```

The allowed edit paths are a closed set. If implementation requires another path, the worker stops
and asks the coordinator to expand the scope.

### 3.6 Worker handoff template

Each worker returns:

```text
Summary:
Files changed:
Behavior/contract changed:
Tests added or updated:
Commands run and exact results:
Commands not run and why:
Risks, assumptions, and follow-up items:
Git status and confirmation that the index was not modified:
```

Generated output, screenshots, benchmark JSON, or environment-gated evidence must be identified by
path. A handoff must not claim a cross-platform result that was not actually run.

### 3.7 Coordinator review checklist for every task

The coordinator performs all of the following before acceptance:

1. Recheck `git status`, staged paths, and the worker's allowed path set.
2. Read the full diff and relevant unchanged surrounding code.
3. Search all callers, schemas, fixtures, documentation, and platform variants affected by changed
   symbols.
4. Compare behavior against the task acceptance criteria and applicable decision record.
5. Check error paths, cancellation, cleanup, restart/recovery, and bounded-resource behavior where
   relevant.
6. Check that tests fail for the old behavior and cover the new boundary cases.
7. Run at least the task's targeted validation independently; do not rely only on worker output.
8. Verify that no migration shim, public alias, or unrelated refactor was introduced.
9. Record findings by severity and either accept the task or issue a focused revision brief.
10. Update the coordinator ledger only after the accepted diff and validation evidence agree.

For protocol and snapshot tasks, the coordinator also requests a separate read-only review worker
unless no agent slot is available; if skipped, the final report states that limitation.

### 3.8 Phase gate procedure

At the end of every phase, the coordinator:

1. verifies every phase task is independently complete;
2. reviews the combined phase diff for interactions missed in per-task review;
3. runs the phase-level commands listed below;
4. compares current benchmark/response evidence with the Phase 0 baseline;
5. checks documentation and design-spec alignment;
6. records environment-gated checks performed and not performed;
7. confirms no unexpected staged files or unrelated edits exist;
8. only then unlocks dependent tasks.

### 3.9 Mandatory coordinator loop for each atomic task

The coordinator repeats this loop for every ledger ID; grouped phase prose does not permit one
worker to take several task IDs as an unreviewed batch:

1. Select exactly one `ready` task and re-read its decision record, dependencies, nearby code, and
   tests.
2. Capture Git baseline and resolve ownership of every allowed path.
3. Write a closed-scope delegation brief from Section 3.5 and start one implementation worker.
   Workers may not delegate further unless the coordinator explicitly authorizes a read-only
   investigation with no edits.
4. While the worker runs, prepare the review checklist and independent validation commands; do not
   edit the same paths or start a competing implementation worker.
5. Receive the Section 3.6 handoff and ensure the worker has stopped editing before review begins.
6. Compare the final Git state with the baseline, reject out-of-scope edits, and read the complete
   task diff plus relevant unchanged callers.
7. Perform the Section 3.7 review. For a high-risk task, start the required separate read-only review
   worker only after the implementation handoff, then adjudicate its findings independently.
8. If any finding is actionable, mark `revision_required` and delegate one focused fix brief. After
   handoff, reread the entire task diff and repeat review; do not review only the newest patch.
9. Run the targeted validation independently. A worker's green result is supporting evidence, not
   the acceptance decision.
10. Record commands, findings, revisions, and remaining external gates. Mark `complete` only after
    code review and independent validation pass; otherwise use the precise paused/terminal state.
11. At the last task in a phase, run the separate phase-gate procedure before making downstream
    tasks `ready`.

## 4. Success criteria

Release readiness is complete only when all of the following are demonstrated. Local implementation
may finish earlier under Section 11.1, with E-CI/E-XP/E-MCP recorded as `operator_required` rather
than misreported as passed:

- Incremental log reads never duplicate or skip raw byte ranges when stdout and stderr grow
  concurrently; a partial and later continuation may legitimately share one durable sequence ID.
- Unicode text is preserved across cursor boundaries.
- Log cursors are attempt-scoped and stable across Controller restart.
- Mixed stdout/stderr output preserves durable chunk sequence.
- Default `job_run` log text never exceeds its documented byte budget.
- A resumed `job_run` does not resend previously acknowledged raw log bytes.
- Successful jobs return a compact response without an unsolicited large tail.
- Raw durable log files retain original ANSI/OSC data; AI-facing responses are plain text by
  default.
- Job completion wakes MCP waiters without a 200 ms polling dependency.
- Snapshot creation no longer writes and rereads a complete uncompressed tar.
- Snapshot peak heap usage is bounded by stream buffers and metadata, not total payload size.
- Concurrent workspace changes still fail closed with `workspace_changed`.
- A Windows Controller can submit an explicitly Bash-targeted job to a compatible Linux/macOS
  Agent, and the inverse explicit-shell cases are validated where supported.
- `rbo run -- <shell-command-string>` completes a remote job without requiring a JSON request file.
- Pull requests run build and verification gates before merge.
- A successful `job_run` with no artifacts or warnings serializes to at most 2 KiB.
- A default failure response serializes to at most its 16 KiB log-text budget plus 8 KiB of JSON
  metadata, and its diagnostic fixture contains the exact expected error sentinel.
- A default `job_logs` page returns at most 64 KiB of presented log text, at most 128 chunk objects,
  and at most 16 KiB of JSON metadata overhead.
- The small-snapshot benchmark has no more than 10% median wall-time regression and no more than
  32 MiB peak-RSS regression against the Phase 0 baseline.
- The event-driven wait fixture has no fixed 200 ms dependency; its injected-transition wakeup is
  under 25 ms at p95 in the local benchmark environment, with the environment recorded.

The numeric thresholds above become enforceable only after Phase 0 confirms that the fixtures are
stable enough to compare. Before/after benchmark results and the measured environment must be
attached to the implementing change. If a fixture is too noisy to enforce, C-00 must revise the
fixture or request an explicit threshold decision; later workers may not silently weaken it.

## 5. Contract decisions

### 5.1 Log cursor

Replace the current synthetic byte offset across separately growing stdout/stderr files with an
opaque, server-issued cursor. Durable chunk sequence remains the ordering basis, while the cursor
also supports a position inside one large chunk so a hard response budget never forces data loss
or repetition.

Rules:

- `cursor` is `null` for the beginning or an opaque bounded string copied from `next_cursor`.
- Clients must not parse or construct cursors.
- Internally the cursor version records mode, attempt ID, durable chunk sequence, raw byte offset
  inside that chunk, and the minimum presentation-parser state required for exact resume.
- A response begins at the exact raw byte following the prior response, including when the prior
  page ended in the middle of a durable chunk.
- A page boundary never splits a UTF-8 code point. `max_output_bytes` has a minimum of 4; smaller
  values fail schema validation, so one Unicode scalar can always make progress.
- `next_cursor` is the exact next unread position, or the input cursor when no bytes are consumed.
- Cursor scope is one resolved `attempt_id`, mode, cursor version, and presentation profile.
- Log and event cursors remain separate domains.
- Requests must select either `mode: "logs"` or `mode: "events"`; mixing events with stdout/stderr
  is rejected.
- A cursor for a different job/attempt/mode/profile returns a structured non-retryable mismatch
  error; it is never silently reset to the latest attempt.
- A non-null cursor is authoritative for attempt resolution and must identify an attempt belonging
  to the requested job.
- Contiguous complete chunks from the same stream may be coalesced to reduce JSON overhead.
- A partial chunk remains individually identified and can resume without replaying its prefix.
- Cursor decoding validates version, size, integer bounds, attempt ownership, and parser state.
- The serialized cursor is at most 512 bytes, integrity-protected with persistent Controller
  identity material, and carries no secret, log text, host path, or credential material.

Proposed log response shape:

```json
{
  "job_id": "job_...",
  "attempt_id": "att_...",
  "mode": "logs",
  "chunks": [
    {
      "sequence": 43,
      "stream": "stderr",
      "text": "...",
      "complete": false
    }
  ],
  "next_cursor": "rbo-log-cursor-v1-opaque-value",
  "returned_bytes": 8120,
  "has_more": true,
  "truncated": true
}
```

The exact opaque encoding is an internal implementation detail selected during DG-LOG. It may be a
bounded base64url payload with strict schema validation; it must not require Controller memory to
resume after restart. Because the project is pre-1.0 and repository guidance rejects migration
shims, replace the old cursor contract cleanly rather than supporting byte and opaque cursors
simultaneously.

### 5.2 Response budgets

Introduce one shared log-presentation budget implementation used by `job_logs`, `job_wait`, and
`job_run`.

Initial defaults to validate in tests and benchmarks:

- `job_run`: 16 KiB of serialized log text per response.
- `job_wait`: no tail unless explicitly requested; an explicit tail still has a 16 KiB default
  cap.
- `job_logs`: 64 KiB default, with the existing explicit upper bound retained unless benchmark
  evidence supports lowering it.
- Public log byte-budget inputs (`job_logs.max_bytes` and `job_run.max_output_bytes`) have a minimum
  of 4 bytes and reject smaller values with a structured validation error.
- One logical line or durable chunk cannot bypass the byte cap; partial-chunk continuation uses the
  opaque cursor.
- A page contains at most 128 chunk objects; adjacent complete chunks from the same stream are
  coalesced before that limit is applied. Hitting the object limit sets `has_more` without violating
  the byte budget.
- Presentation may scan at most 1 MiB of raw input per page when stripped control sequences produce
  no text; reaching that internal scan cap returns a resumable cursor and prevents unbounded work.
- Default failure output has at most 8 KiB of serialized metadata beyond its log-text budget.
- Default `job_logs` output has at most 16 KiB of serialized metadata beyond its log-text budget.

Budgeting uses UTF-8 bytes after presentation cleanup. The response reports truncation and the
next resumable cursor. The complete serialized response should also have a regression test so
metadata growth cannot silently defeat the intended token economy.

### 5.3 Compact `job_run`

Terminal success returns only fields that carry information:

```json
{
  "job_id": "job_...",
  "state": "completed",
  "outcome": "succeeded",
  "exit_code": 0
}
```

Rules:

- Omit `failure_category`, `failure_message`, empty artifacts, empty warnings, and null tail fields.
- Success has no unsolicited log tail by default.
- Failure may return a bounded, explicitly non-resumable `diagnostic_excerpt`, stderr first, then
  the newest remaining text.
- Only exact consecutive duplicate lines may be collapsed in the first implementation.
- Do not add compiler-specific or regex-based semantic error extraction in this phase.
- Raw logs remain available through `job_logs` and CLI follow.
- Non-terminal `log_chunks` remain in durable sequence order and return only data after the supplied
  `log_cursor`.
- `diagnostic_excerpt` never advances `next_log_cursor`; it is presentation-only and may overlap raw
  logs later requested explicitly.
- A response always returns `next_log_cursor` for ordered `log_chunks` so the client can resume
  without duplication.
- A tail-free terminal success does not manufacture a high-watermark cursor. With no input
  `log_cursor` and no delivered `log_chunks`, omit `next_log_cursor`; with an input cursor but no
  consumed raw bytes, return that exact cursor unchanged.
- Nonempty artifact metadata shares the response metadata budget. If it does not fit, return the
  fitting prefix plus `artifact_count`, `artifacts_truncated: true`, and a short hint to call the
  existing `job_artifacts` tool; never cut one artifact record mid-field.

### 5.4 ANSI and OSC handling

Preserve original redacted bytes in durable logs. Strip terminal presentation sequences only when
returning AI-facing MCP text, with an opt-out for diagnostics if needed.

The implementation must handle:

- CSI Select Graphic Rendition color/style sequences;
- other common CSI cursor/control sequences;
- OSC hyperlinks and titles;
- escape sequences split across durable chunks;
- malformed or incomplete escape sequences without dropping ordinary text.

The opaque cursor carries a small validated sanitizer state so a CSI/OSC sequence split across MCP
responses resumes exactly. The state is an enum plus bounded parser fields, never buffered log
content. Define and test a maximum escape length; overlong malformed sequences are discarded in a
documented fail-plain manner without exposing control bytes. Changing `strip_ansi` or another
presentation option invalidates a cursor issued for a different presentation profile.

Exact duplicate-line collapse is page-local in the first implementation. It buffers at most one
64 KiB complete presented line, resets at a page boundary, and is not encoded into the cursor; an
overlong or cross-page line is emitted normally rather than retained for deduplication.

Apply secret redaction before presentation cleanup and test that neither operation reintroduces
secret material.

### 5.5 Cross-platform `job_run`

Do not translate PowerShell into Bash or vice versa. Extend `job_run` with explicit selection:

- `shell?: ShellId`;
- `target_os?: string[]`, mapped to canonical job requirements.

Expose `queue_policy?: QueuePolicy` in the same delivery only if DG-QUEUE is independently approved.
It is not required to solve cross-platform shell selection.

Behavior:

- An explicit shell is copied to `execution.shell` and participates in normal Agent matching.
- `target_os` narrows scheduling but does not rewrite the command.
- If shell is omitted, preserve the existing same-platform convenience behavior.
- If only cross-platform Agents are eligible and shell was omitted, return a short actionable
  diagnostic asking for `shell`/`target_os` instead of silently generating an incompatible script.
- Keep the full `job_submit` path for advanced execution settings.

True direct executable launch is not part of this phase. The existing Windows `direct` mode still
uses `cmd.exe`; a future direct-exec contract should use separate `executable` and `args` fields.

### 5.6 Snapshot publication and crash recovery

Treat snapshot capture, publication, and job attachment as one crash-consistent protocol. A
snapshot is published only when a committed database row references final immutable paths.

Required order:

1. Acquire a persisted capture-owner token plus monotonically increasing fencing generation and a
   renewable lease on the reserved submission. Every candidate and final path includes that fencing
   generation, then the owner streams into its uniquely named private candidate files.
2. Close the streams, finalize hashes and sizes, and run all file-identity, repository, submodule,
   and workspace-change guards.
3. Serialize and validate the manifest from the bytes actually archived.
4. Flush and close the candidate files where the platform supports it.
5. Immediately before each no-replace rename, revalidate the owner token, fencing generation, and
   unexpired lease. Rename the archive candidate and manifest candidate separately to that
   generation's published final names, with failure injection before, between, and after the two
   renames. This precheck avoids known-stale work but is not the authoritative publication fence.
6. On POSIX, fsync the parent directory after both renames and before SQLite commit. On Windows, use
   the strongest available flush/rename primitive and document the weaker/variant durability
   boundary rather than claiming POSIX guarantees.
7. In one SQLite transaction, conditionally verify the same owner token, fencing generation, and
   unexpired lease, then insert the snapshot row, create the job with `snapshot_id` already attached,
   perform the existing lifecycle transitions to queued/confirmation state, and complete the
   reserved submission with its job ID and response. A zero-row ownership check rolls back the whole
   transaction. The database must never reference a temporary path or expose a job without its
   snapshot.
8. Only after commit may dispatch or any state that exposes the snapshot proceed.

Lifecycle events belonging to step 7 are persisted inside the transaction. Any in-memory notifier
introduced by W-01 fires only after the outer transaction commits; rollback must not wake a waiter
for state that never became durable.

If a crash or database failure occurs before step 7 commits, final-but-unreferenced files are
orphans, not published snapshots. Startup recovery removes stale `.tmp-*` files and final snapshot
directories that have no database reference only when no unexpired capture-owner lease protects
them. Age alone is not proof of inactivity. The active owner renews its lease during long capture;
recovery and same-key retry may reclaim only an expired lease by compare-and-swap on its owner token
and fencing generation and must never delete a database-referenced payload. A stale owner may win a
TOCTOU race and perform a late rename after its precheck, but only into its no-replace,
generation-scoped path; that file is a safe orphan. The authoritative conditional check in step 7
prevents the stale generation from committing or becoming database-visible. A stale owner cleans
only its private candidates; final orphans remain recovery-owned. A committed `captured` reservation
remains immutable and returns its stored response. S-03 must add failure injection at every numbered
boundary, including between renames and after parent-directory flush, and prove same-key retry
produces one valid referenced snapshot without leaking temporary or orphaned data.

## 6. Coordinator task ledger and work breakdown

The coordinator executes the following ledger in order. The detailed phase sections define the
behavior; this ledger defines delegation and review boundaries.

| ID | Work package | Depends on | Primary editable scope | Coordinator review focus |
| --- | --- | --- | --- | --- |
| C-00 | Baseline audit and decision records | none | plan/ledger only | Scope, dirty-worktree ownership, DG-LOG through DG-CLI |
| B-01 | Benchmark harnesses and baseline capture | C-00 | focused benchmark scripts/tests | Determinism, no tracked-output mutation, honest metrics |
| CI-01 | PR/push source-verification workflow | C-00 | `.github/workflows/` and CI docs | Pinned actions, Windows/Linux parity, build included |
| L-01 | Sequence-indexed executor log reader | B-01, DG-LOG | `packages/executor/src/logs*`, executor tests | UTF-8 bytes, ordering, bounded reads, restart recovery |
| P-01 | ANSI/OSC and budget presentation primitive | L-01, DG-BUDGET | focused shared/executor module and tests | Streaming escapes, secret safety, exact UTF-8 caps, bounded state |
| L-02 | `job_logs` wire, presentation, and Controller integration | L-01, P-01 | protocol MCP schema, Controller handler/tests | Clean contract replacement, attempt scoping, transport parity |
| L-03 | CLI log client and documentation migration | L-02 | CLI log client/tests, design/user docs | No old cursor semantics, reconnect correctness |
| P-02 | Compact incremental `job_run` | L-02, P-01 | protocol MCP input, `job-run`, focused tests | Sparse success, failure excerpt, cursor non-repetition |
| P-03 | Bounded `job_wait` and response fixtures | P-02 | wait handler/tests and synthetic fixtures | Shared budget use, no hidden unbounded path |
| W-01 | Lifecycle notifier primitive | P-03 | Controller lifecycle/notifier and tests | Emit after outer commit, cleanup, multiple waiters |
| W-02 | Event-driven waiter integration | W-01 | submit/wait path and race tests | Subscribe/reread race, abort/timeout fallback |
| S-01 | Direct tar-to-zstd writer | B-01, DG-SNAPSHOT | snapshot archive module/tests | Backpressure, atomic output, deterministic archive |
| S-02 | Full/overlay capture integration | S-01 | snapshot capture module/tests | Open-handle identity, fail-closed guards, archive equivalence |
| S-03 | Crash-consistent publication and recovery | S-02, W-01 | Controller storage/capture/submit/lifecycle/recovery and focused tests | Publish order, capture lease, idempotency, post-commit notify, failure injection |
| S-04 | Capture limits and operator configuration | S-03 | Controller config/templates, snapshot tests/docs | Safe defaults, early rejection, actionable errors |
| S-05 | Metadata-concurrency experiment | S-04 | focused capture helper/benchmarks | Evidence for 1/4/8 workers, bounded memory, determinism |
| X-01 | Explicit shell/OS compact contract | P-03, W-02, DG-SHELL | protocol and `job-run` mapping/tests | No command translation, canonical request mapping |
| XQ-01 | Optional compact queue-policy exposure | X-01, DG-QUEUE approved | protocol, `job-run`, focused policy tests | Separate public-input decision, fallback semantics unchanged |
| X-02 | Matching diagnostics and scheduling integration | X-01, XQ-01 if approved | scheduler/submit and focused tests | Bounded diagnostics, fencing, local/remote parity |
| X-03 | Cross-platform transport/docs validation | X-02 | integration tests and docs | Stdio/HTTP parity, claimed vs actually run platforms |
| R-01 | `rbo run` parser and request construction | X-03, DG-CLI | CLI command/help/tests | Quoting contract, no duplicate request model |
| R-02 | Follow and SSE reconnect | R-01 | CLI follow/runtime helpers/tests | Event cursor domain, reconnect, output ordering, no duplicates |
| R-03 | Confirmation, cancellation, exit, and JSON behavior | R-02 | CLI runtime helpers/tests | Ctrl+C lifecycle, TTY safety, JSON purity, exact exit mapping |
| R-04 | CLI documentation and smoke workflow | R-03 | getting-started/help/docs tests | One-command path, timeout semantics, advanced submit retained |
| F-01 | Independent combined-diff review | all implementation tasks | read-only unless fixes authorized | Cross-package drift, recovery, security, compatibility |
| F-02 | Final repository validation | F-01 findings resolved | formatter-generated changes only if expected | Format, verify, build, packaging, benchmark deltas |
| E-CI | Hosted Windows/Linux CI evidence | F-02 | no repository edits | Final-identity success runs, workflow-hash negative proof, required checks |
| E-XP | Real cross-platform execution smoke | F-02 | no repository edits | Exact final artifact, Controller/Agent OS pair, shell, result |
| E-MCP | Real stdio and Streamable HTTP client smokes | F-02 | no repository edits | Exact final artifact, client versions, transports, resume result |
| F-03 | Final evidence and handoff | F-02; E gates attempted | no repository edits | Honest chat/external handoff, evidence identity, skipped gates, Git state |

### 6.1 Coordinator execution record

For each task, the coordinator records a compact entry:

```text
Task:
State:
Worker agent:
Start baseline:
Allowed edit paths:
Worker handoff received:
Coordinator findings:
Revision rounds:
Independent commands and results:
Additional review worker result, if required:
Accepted commit/diff identity or working-tree paths:
Completion decision:
```

Only the coordinator edits this record. Keep the live record in coordinator task state or an
append-only external evidence ledger, not by mutating this repository plan during execution. If the
user requests a repository report, finalize it before F-02 and include it in the evidence identity.
Worker agents must not mark checkboxes in this plan.

### 6.2 Default execution sequence and parallel lane

The safe default is sequential execution in ledger order. One optional parallel lane is allowed:

- after C-00, B-01 and CI-01 may run concurrently because their edit scopes are disjoint;
- after B-01 and DG-SNAPSHOT, S-01 through S-05 may run alongside the log/token lane only while
  snapshot workers remain inside `packages/snapshot` and snapshot-only tests;
- S-03 starts only after W-01 and is sequential with W-02 and any other task touching Controller
  submit, lifecycle, transactions, or recovery;
- S-04 pauses if it needs root manifests, protocol, Controller files already owned by another
  worker;
- P-01 runs after L-01 and before L-02; protocol changes L-02, P-02, and X-01 are always sequential;
- W-01/W-02 are sequential with P-02/P-03 because both touch Controller lifecycle/wait code;
- R-01 through R-04 start only after the final compact `job_run` contract is accepted;
- E-CI, E-XP, and E-MCP start only after F-02 freezes and records the exact final diff/artifact
  identity; an `operator_required` external gate does not prevent F-03 local handoff, but it does
  prevent a claim of release readiness.

When in doubt, the coordinator chooses sequential execution. Lower elapsed time does not justify an
unreviewable combined diff.

### 6.3 Task C-00: baseline audit and decisions

Coordinator-only steps:

1. Read current guidance, manifests, protocol schemas, design sections, and nearby tests.
2. Record branch, worktree, staged paths, Node/pnpm/Rust versions, and operating system.
3. Identify user-owned changes and freeze overlapping paths.
4. Present DG-LOG, DG-BUDGET, DG-SNAPSHOT, DG-SHELL, DG-QUEUE, and DG-CLI as a concise decision
   record.
5. Obtain approval or revise this plan before implementation delegation.
6. Create the live task ledger using the IDs above.

Review gate: the coordinator confirms every material contract is decided and that no implementation
task is active. C-00 completes without source changes.

### 6.4 Task B-01: benchmark harnesses

Worker brief:

- implement only the benchmark fixtures and runner described in Phase 0;
- do not optimize production code;
- do not write benchmark results into tracked files during normal tests;
- expose machine-readable measurements and document how to reproduce them.

Worker validation: targeted benchmark tests and one small local benchmark run.

Coordinator review:

- inspect fixtures for determinism and bounded runtime;
- verify the benchmark measures the current bottleneck rather than fixture setup;
- independently run the small profile;
- run the 1 GiB profile only when disk/time budget is explicitly available;
- save baseline evidence outside tracked source or in an explicitly approved report.

Exit gate: baseline data exists for logs, response size, and snapshots before optimized code lands.

### 6.5 Task CI-01: PR/push CI

Worker brief:

- add a new source-verification workflow without modifying publishing behavior;
- pin actions by SHA;
- include Windows and Linux, frozen install, build, and verify;
- separate required fast gates from environment-gated tests.

Worker validation: parse/review workflow syntax and run any repository-local workflow checks that
exist. Do not claim GitHub-hosted execution locally.

Coordinator review:

- inspect permissions, triggers, concurrency, cache keys, timeouts, and shell portability;
- confirm publish permissions were not copied into PR CI;
- independently run the workflow command sequence locally where available;
- treat any early GitHub run as workflow debugging only; E-CI completes only after F-02 when the run
  references the exact final evidence identity.

Exit gate: repository code for CI is accepted; hosted-run evidence may remain an explicitly tracked
`operator_required` external gate until a pull request exists.

### 6.6 Tasks L-01, P-01, L-02, and L-03: log contract vertical slice

#### L-01 worker brief

Implement the internal sequence reader and writer-offset recovery without changing the public MCP
shape. Add focused executor tests first. Preserve durable files unless DG-LOG explicitly approves a
format change.

Coordinator review emphasizes:

- Buffer/file-offset correctness rather than JavaScript string indices;
- chronological mixed-stream order;
- bounded reads near the end of large logs;
- restart reconstruction and incomplete index tails;
- append durability ordering and no regression to Agent acknowledgement.

Independent validation: focused executor log tests plus B-01 log benchmark.

#### P-01 worker brief

Implement a small presentation primitive with streaming ANSI/OSC state, page-local bounded exact
duplicate-line collapse, UTF-8 byte budgeting, and the 4-byte minimum progress rule. Durable log
writes are read-only context and must not be altered. Do not change a public MCP schema in this task.

Coordinator review emphasizes malformed/split escapes, redaction order, post-strip byte counts, the
1 MiB raw-scan cap, 64 KiB dedup state cap, and one huge logical line. Reject regex-only ANSI
handling that cannot preserve split-sequence state.

Independent validation: focused presentation unit tests, 1–4 byte budget cases, split UTF-8/control
sequences, bounded-state assertions, and synthetic compiler fixtures.

#### L-02 worker brief

Replace the public `job_logs` input/output contract and wire the accepted P-01 presentation primitive
through the Controller. Edit only the protocol MCP definitions, handler, and directly related tests.
Do not update CLI or broad docs in this task.

Coordinator review emphasizes:

- exact DG-LOG shape;
- events/log mode separation;
- attempt-scoped cursor rejection;
- ANSI/OSC parser state and presentation-profile scoping in the opaque cursor;
- minimum budget validation and exact mid-chunk progress;
- stdio and HTTP returning the same JSON;
- no byte-cursor compatibility shim;
- error responses remaining bounded and structured.

Independent validation: protocol tests, Controller `job_logs` tests, and transport parity tests.
Request an additional read-only protocol review worker before acceptance.

#### L-03 worker brief

Migrate CLI readers, reconnect behavior, authoritative design sections, and user integration docs to
the accepted contract. Remove old cursor assumptions from tests and comments. Preserve the separate
numeric SSE `Last-Event-ID` domain; only callers of MCP `job_logs` use the opaque log cursor.

Coordinator review emphasizes complete symbol/search migration and no historical draft being
treated as authority.

Independent validation: CLI log tests, MCP smoke workflow, and repository search proving old
synthetic-byte semantics are gone.

Phase exit gate: run the Phase 1 acceptance suite and review the combined L-01/P-01/L-02/L-03 diff.

### 6.7 Tasks P-02 and P-03: token-efficient MCP responses

#### P-02 worker brief

Implement compact incremental `job_run` using the accepted presentation module and opaque log
cursor.
Keep confirmation responses complete. Do not change scheduling or shell selection in this task.

Coordinator review emphasizes:

- sparse success shape;
- stderr-first bounded failure excerpt;
- no repeated acknowledged raw log bytes;
- terminal resume behavior, including no synthetic cursor advance on fresh tail-free success;
- artifact and warning omission only when empty;
- progress notification behavior unchanged unless explicitly covered.

Independent validation: focused `job-run` tests, response-size fixtures, and stdio/HTTP parity.

#### P-03 worker brief

Apply the same budget implementation to explicit `job_wait` tails and add representative toolchain
fixtures. Do not add semantic error parsing.

Coordinator review searches every MCP path that can return logs and verifies there is no unbounded
alternate response.

Independent validation: wait tests, fixture tests, B-01 response benchmark, and a raw CLI follow
regression check.

Phase exit gate: run Phase 2 acceptance and record before/after serialized response sizes.

### 6.8 Tasks W-01 and W-02: event-driven waiting

#### W-01 worker brief

Add the notifier primitive and route committed lifecycle transitions through it. Do not yet remove
the polling fallback or rewrite `waitForJob`.

Coordinator review audits every direct `UPDATE jobs` call and verifies notification occurs only
after the outermost transaction commits for the transitions that exist when W-01 lands. The primitive
must expose an explicit post-commit path that S-03 can use later. Check listener ownership, rollback
behavior, and Controller shutdown cleanup; S-03 separately reviews snapshot-transaction integration.

Independent validation: notifier unit tests and lifecycle transition tests.

#### W-02 worker brief

Switch `waitForJob` to subscribe/reread/await with timeout, abort cleanup, and low-frequency durable
fallback. Add deterministic race tests with injected scheduling/timers.

Coordinator review emphasizes lost-wakeup races, multiple waiters, cancellation, recovery, and zero
listener leaks. Independently run the race tests repeatedly, not just once.

Independent validation: repeated focused race suite, fake-clock timeout/abort cases, listener-count
assertions, and the B-01 fast-job wakeup benchmark.

Phase exit gate: run Phase 3 acceptance and compare fast-job latency with B-01 baseline evidence.

### 6.9 Tasks S-01 through S-05: snapshot streaming

#### S-01 worker brief

Build and test the direct tar-to-zstd primitive in the archive module. It may rename an internal
`.writing` file to a private candidate name, but it must never create the published final snapshot
name; S-03 exclusively owns publication rename. Do not integrate capture or remove the old writer in
this task. Preserve archive format determinism and materialization compatibility.

Coordinator review emphasizes backpressure, hash/size accounting, atomic temporary output, cleanup
on every thrown path, and deterministic headers. Request an additional read-only snapshot review.

Independent validation: archive tests, decompression/materialization comparison, and large-file RSS
measurement.

#### S-02 worker brief

Integrate the accepted writer into full and overlay capture with opened-handle identity checks and
final workspace guards. Remove obsolete staging/uncompressed-tar paths only after equivalence tests
pass.

Coordinator review traces acquisition, stream completion, identity verification, manifest creation,
and cleanup as one immutable byte-capture protocol. Pay special attention to Windows file semantics,
symlinks, submodules, additional roots, and workspace changes during streaming.

Independent validation: full/overlay/materialization/capture-scenario tests and B-01 snapshot
benchmarks. Request an additional read-only snapshot review before acceptance.

#### S-03 worker brief

Implement the Section 5.6 publication order, single-transaction snapshot/job/submission commit,
capture-owner token/fencing generation/lease renewal, compare-and-swap stale-capture reclaim,
generation-scoped no-replace paths, orphan startup recovery, post-rename parent-directory flush, and
boundary failure injection. Refactor the capture helper to return a finalized private candidate
rather than publishing its own database row. Do not change capture limits or introduce metadata
concurrency.

Coordinator review traces final guards, file flush/close, atomic rename, database commit, dispatch
visibility, retry, recovery, and cleanup as one crash-consistent protocol. Verify recovery cannot
delete an active or database-referenced payload, the job is never visible without its snapshot, and
same-key retry cannot create two jobs. Verify any in-memory state notification is deferred until the
outer transaction commits. Verify lease renewal protects a deliberately long capture, stale-owner
commit always fails after reclaim, any late rename is isolated as a generation-scoped orphan, and
owner cleanup cannot touch another generation. Inspect every injected failure boundary, especially
between renames and after parent-directory flush.

Independent validation: focused publication/recovery tests, restart tests at every boundary, a
successful retry after each failure, active-lease/non-owner reclaim races, database/file
reconciliation assertions, and an additional read-only snapshot review.

#### S-04 worker brief

Add the approved limits to Controller configuration/templates and enforce them before expensive
compression when possible. Keep errors structured and actionable.

Coordinator review checks all config precedence paths, defaults, environment overrides, docs,
integer bounds, and cleanup after a mid-stream breach.

Independent validation: config tests, full/overlay limit tests, and one operator-facing error
snapshot.

#### S-05 worker brief

Run the 1/4/8-worker metadata experiment. Adopt a concurrent default only if both Windows NTFS and
Linux many-small-file fixtures show at least 15% median metadata-preflight improvement, neither has
more than 10% p95 wall-time regression, and peak RSS increases by no more than the greater of 32 MiB
or 10%. Keep payload reads sequential. If both real-platform datasets are unavailable or thresholds
are not met, retain the sequential default, record the no-change reason, and complete the task
without production concurrency edits. A later adoption attempt requires a new evidence-backed task.

Coordinator review verifies the chosen default follows evidence rather than the original proposal.

Independent validation: coordinator reruns the selected 1/4/8 profiles, checks the raw benchmark
JSON and environment metadata, and reproduces at least one profile on each available real platform.

Phase exit gate: run Phase 4 acceptance, snapshot benchmarks, and combined-diff snapshot review.

### 6.10 Tasks X-01 through X-03: explicit cross-platform execution

#### X-01 worker brief

Add `shell` and `target_os` to compact `job_run` and map them into canonical `JobRequest`. Do not
change scheduler scoring, queue policy, or CLI in this task.

Coordinator review checks DG-SHELL, validation defaults, command wrapping for every shell, and no
secondary request model or automatic syntax translation.

Independent validation: protocol and `buildJobRunRequest` tests for Windows and POSIX inputs.
Request an additional read-only protocol review.

#### XQ-01 optional worker brief

Only when DG-QUEUE is approved, expose canonical `queue_policy` through compact `job_run` and add
focused tests proving existing `local_fallback`, `wait`, and `fail_fast` behavior is unchanged. Do
not combine this with scheduler refactoring or shell matching changes.

Coordinator review treats this as a separate public contract even when the same worker implements
it after X-01. If DG-QUEUE is rejected, record XQ-01 as `rejected_by_decision`, not incomplete.

Independent validation: protocol, compact job-run, scheduler-policy, and local-fallback tests for
all three canonical policies.

#### X-02 worker brief

Integrate constraints with matching/fallback and add bounded structured no-match diagnostics. Avoid
broad scheduler refactoring.

Coordinator review checks capacity, requirements, local fallback, absent shell, offline Agents,
Agent fencing, local/remote parity, and diagnostic token size. Verify diagnostics do not expose
internal paths or full capabilities.

Independent validation: scheduler, local-fallback, and focused job-run integration tests.

#### X-03 worker brief

Add transport parity, fake-capability matrix tests, authoritative docs, and release smoke gates.
Separate simulated platform coverage from actually executed platform coverage.

Coordinator review verifies every claimed platform result has evidence and all integration examples
match the final schema.

Independent validation: coordinator reruns transport-parity tests and records real-platform smokes
as passed or `operator_required`, never as implied by fake capability fixtures.

Phase exit gate: run Phase 5 local acceptance. Track the real cross-platform smoke as E-XP; when
infrastructure is unavailable it remains `operator_required` rather than silently blocking local
review or being marked complete.

### 6.11 Tasks R-01 through R-04: `rbo run`

#### R-01 worker brief

Add CLI parsing/help and request construction using existing Controller client helpers. Keep network
execution minimal and do not duplicate protocol validation. Map `--timeout` only to remote
`timeout_seconds`; the initial CLI has no separate overall wait deadline.

Coordinator review checks the exactly-one-string `--` handling, PowerShell/cmd/POSIX quoting,
project/cwd resolution, repeated flags, `--timeout` mapping, and JSON-mode separation. Repeated
`--artifact` values map to `{ glob, required: false }` in the existing compact request.

Independent validation: parser and request-construction unit tests on current OS plus platform-
parameterized fixtures.

#### R-02 worker brief

Implement terminal waiting plus optional SSE follow and reconnect using the event-stream
`Last-Event-ID` sequence domain. Do not implement confirmation, Ctrl+C cancellation, JSON mode, or
process exit mapping in this task.

Coordinator review covers submit, no-follow wait, follow, disconnect/reconnect, terminal tail, SSE
event ordering, and stdout/stderr ordering. Verify reconnect does not duplicate raw log bytes and the
opaque MCP log cursor is never reused as an SSE cursor.

Independent validation: focused fake-Controller follow/reconnect tests and one local Controller
normal-success follow smoke.

#### R-03 worker brief

Implement TTY confirmation, non-interactive refusal, Ctrl+C cancellation, fixed 10-second
cancel-confirmation wait, JSON mode, and exact process-exit mapping. A CLI transport call may have a
bounded request/reconnect timeout, but there is no overall job wait deadline separate from the
remote execution timeout.

Coordinator review executes confirmation, disconnect, first and repeated Ctrl+C, cancellation not
confirmed within 10 seconds, remote timeout, transport failure, remote exit pass-through, and JSON
purity. Ctrl+C sends best-effort `job_cancel`; after 10 seconds it exits 130 with a warning and job
ID even if terminal cancellation was not observed.

Independent validation: fake-Controller lifecycle matrix, TTY/non-TTY tests, stdout/stderr capture,
JSON schema snapshot, and every reserved/pass-through exit case.

#### R-04 worker brief

Update getting started, CLI README/help fixtures, and the product readiness checklist. Keep
`rbo submit` documented for advanced requests.

Coordinator review runs every paste-ready example that is safe in the available environment and
checks documentation against actual `--help` output.

Independent validation: docs/help snapshot tests plus one local Controller CLI smoke for normal
success, one JSON invocation, and one cancellation path.

Phase exit gate: run Phase 6 acceptance and record JSON, cancellation, and normal-success examples.

### 6.12 Tasks F-01 and F-02: final local integration

#### F-01 combined review

Start at least one read-only review worker with the full accepted diff and ask it to focus on
cross-package protocol drift, recovery, security boundaries, and missing tests. The coordinator then
performs its own full review, adjudicates every finding, and delegates focused fixes one at a time.

No finding is considered resolved until the coordinator rereads the affected full diff and reruns
the relevant targeted tests.

#### F-02 final validation

The coordinator, not a worker, runs the final commands from Section 8. It reviews any formatter or
generated-manifest change before proceeding. Failures produce a new focused fix task followed by a
repeat of targeted and final validation. On success, record a reproducible final evidence identity:
commit SHA when the user has authorized commit/push, otherwise a working-tree manifest containing
the base SHA plus hashes of every changed/untracked deliverable and built artifact used by a smoke.

### 6.13 External evidence gates E-CI, E-XP, and E-MCP

These gates require real external state and are not delegated as implementation work. They run only
after F-02 and must reference its exact final evidence identity. When the environment is unavailable,
the coordinator records `operator_required` with the exact missing precondition and continues to the
honest local handoff.

For each external gate, the coordinator:

1. verifies the branch/artifact/working-tree identity exactly matches the F-02 evidence identity;
   the sole exception is E-CI's documented negative source mutation, whose workflow/configuration
   hashes must still match F-02 exactly;
2. records the platform and Controller/Agent/client versions plus the exact command/request used;
3. obtains the operator action or infrastructure access without broadening repository permissions;
4. captures durable evidence such as run URL, relevant log excerpt, and final status;
5. checks the result against the accepted contract rather than modifying code during the smoke;
6. creates a new focused fix task if evidence exposes a defect, then reruns F-01, F-02, and every
   affected external gate.

Any edit to a path covered by F-02, any regenerated artifact, or any changed base SHA after evidence
capture automatically invalidates the evidence identity and moves all affected E gates back to
`pending` or `operator_required`. Preliminary runs may inform debugging but never satisfy release
readiness. Appending run URLs/statuses to the explicitly external evidence ledger does not alter the
product identity; copying that ledger into the repository does.

E-CI requires successful hosted Windows and Linux build/verify jobs for the exact final F-02 source
identity. Its negative proof is a separate controlled failing commit/run derived from that identity:
only the documented deliberate TypeScript error may differ, and the CI workflow/configuration hashes
must exactly match F-02. The failing run never substitutes for final-identity success runs. E-XP
requires at least one Controller/Agent OS-family mismatch using an explicit compatible shell. E-MCP
requires one actual stdio client and one actual Streamable HTTP client to submit, wait, resume logs,
and reach terminal state without duplication.

### 6.14 Task F-03: final handoff

#### F-03 final handoff

F-03 is read-only with respect to the repository and built artifacts. The coordinator reports in
chat or an append-only external evidence system:

- completed and deferred task IDs;
- files and public contracts changed;
- exact test/build/benchmark commands and results;
- Windows/Linux and real-client coverage actually performed;
- performance and response-size deltas;
- hardware/environment gates not performed;
- remaining risks;
- final branch, staged paths, unstaged paths, and untracked files.

The coordinator does not stage, commit, push, publish, or open a pull request unless the user asks
separately. It does not edit this plan or a repository report after F-02; a requested durable
repository report must be finalized before F-02 and included in its identity.

## Phase 0: Baseline and CI

### 0.1 Add focused benchmark harnesses

Add deterministic, non-release-blocking benchmark commands for:

- log read near the end of 8 MiB and 1 GiB spools;
- alternating stdout/stderr chunk replay;
- `job_run` serialized response size;
- full snapshot of many small files;
- full snapshot containing one large file;
- overlay snapshot with hundreds of dirty/untracked files.

Record at minimum:

- elapsed milliseconds;
- bytes read and written where measurable;
- process heap/RSS delta;
- compressed and temporary disk bytes;
- response UTF-8 byte size;
- duplicate/missing raw-byte-range count and durable-order violations.

Benchmarks must write outside tracked source paths or print machine-readable JSON. They must not
modify a committed report during normal `pnpm test`.

### 0.2 Add pull-request and push CI

Create a source-verification workflow separate from npm publishing:

- triggers: pull request and pushes to the primary branch;
- operating systems: `windows-latest` and `ubuntu-latest`;
- Node version: the repository minimum or a clearly documented supported matrix;
- install: `pnpm install --frozen-lockfile`;
- gates: `pnpm build`, `pnpm verify`;
- packaging verification: one Windows job after build;
- environment-gated Docker/QEMU/large-log tests remain separate and explicitly reported as skipped;
- action versions remain pinned by commit SHA.

Add concurrency cancellation for superseded branch runs. Branch protection is an operator action
and must be documented but is not changed by repository code.

### Phase 0 acceptance

- CI workflow configuration and local command equivalence are accepted; actual Windows and Linux
  hosted runs remain `operator_required` until observed on a test pull request.
- Workflow inspection proves `pnpm build` is an independent gate; a controlled test pull request
  with a deliberate TypeScript build error must fail before E-CI is complete. The negative run may
  use a separate failing source commit, but its workflow/configuration hashes must match final F-02.
- Baseline benchmark JSON is captured before performance implementation begins.

## Phase 1: Correct incremental log access

### 1.1 Replace full-file log readers

Refactor `packages/executor/src/logs.ts` so MCP reads do not load entire stdout/stderr files.

Implementation direction:

- use `chunks.jsonl` sequence entries as the canonical ordering index;
- read only selected byte ranges from the corresponding stream file;
- preserve `Buffer` byte semantics until final UTF-8 decoding;
- handle an incomplete trailing UTF-8 code point without loss or duplication;
- avoid `readFile()` for tail and cursor operations;
- replace existence checks that read file contents with open/access operations;
- maintain append offsets in the active writer rather than calling `stat()` for every chunk;
- keep recovery capable of reconstructing offsets from durable files.

If scanning a large JSONL index remains O(total chunks), add a sparse sequence-to-index-byte-offset
checkpoint file or periodically persisted checkpoint records. Do not introduce an in-memory-only
index that breaks restart behavior.

### 1.2 Build the bounded presentation primitive

Complete P-01 before changing the public cursor schema. The primitive owns streaming ANSI/OSC
state, UTF-8-safe page boundaries, the 4-byte minimum output budget, the 1 MiB raw-scan cap, and
page-local bounded duplicate collapse. It has no public MCP dependency.

### 1.3 Update protocol and handlers

- Update `packages/protocol/src/mcp-tools.ts` and protocol tests.
- Update Controller handlers and stdio/HTTP transport parity tests.
- Reject mixed logs/events mode explicitly.
- Update CLI polling helpers and any archived compatibility fixtures that are still authoritative.
- Update design specification sections describing `job_logs`.
- Update user-facing MCP integration documentation.

### 1.4 Add regression tests

Cover:

- ASCII and multibyte Unicode across chunk and byte boundaries;
- alternating stdout/stderr ordering;
- both streams growing after a previous cursor;
- empty chunks and empty files;
- one very large line;
- restart and replay;
- attempt change with a stale cursor;
- cursor at, before, and after the current high watermark;
- byte budget reached exactly and mid-chunk;
- no duplicate or missing raw bytes, including legal continuation segments with the same sequence.

### Phase 1 acceptance

- All cursor regression tests pass on the coordinator's current OS, and platform-parameterized path
  and encoding fixtures pass locally. Real Windows/Linux hosted evidence is recorded by E-CI.
- Reading the last bounded page of a large log does not allocate memory proportional to total log
  size.
- The old synthetic concatenated stdout/stderr byte cursor no longer exists.

## Phase 2: Token-efficient MCP presentation

### 2.1 Reuse the shared presentation pipeline

Use the P-01 module already integrated by L-02. For every additional MCP consumer it performs, in
order:

1. receive already redacted durable chunks;
2. preserve stream/sequence metadata;
3. strip ANSI/OSC for AI presentation;
4. optionally collapse exact consecutive duplicate lines;
5. apply the UTF-8 byte budget;
6. emit truncation and cursor metadata.

Do not make this logic Controller-only if local and remote execution paths both consume it.

### 2.2 Update `job_run` and `job_wait`

- Add `log_cursor` and `max_output_bytes` to the compact `job_run` input.
- Give `max_output_bytes` the shared 4-byte minimum and documented upper bound.
- Return `next_log_cursor`, `log_chunks` only when useful, and explicit truncation metadata.
- Make terminal success sparse and tail-free by default.
- Make terminal failure return a bounded stderr-first excerpt.
- Apply the same bounded logic to explicitly requested `job_wait` tails.
- Keep artifacts out of the response when none exist.
- Ensure an awaiting-confirmation response remains complete and actionable.

### 2.3 Measure token-facing output

Add fixtures for representative outputs from TypeScript, Vitest, Cargo, GCC/Clang, ESP-IDF, and
Biome. Store short synthetic fixtures rather than copyrighted or machine-specific full logs.

For each fixture, assert:

- output byte limit;
- ANSI/OSC removal;
- important error text remains present in the newest bounded failure excerpt;
- no secret values appear;
- the designated failure fixture contains its exact error sentinel after presentation cleanup;
- a no-artifact/no-warning success response is at most 2 KiB serialized;
- a default failure response is at most 16 KiB of presented log text plus 8 KiB of JSON metadata;
- a default `job_logs` response is at most 64 KiB of presented log text, 128 chunk objects, and
  16 KiB of JSON metadata.

### Phase 2 acceptance

- Fresh and resumed `job_run` calls never repeat acknowledged raw log bytes.
- Default successful `job_run` responses contain no empty/null boilerplate fields.
- Serialized-response fixtures stay under their documented caps.
- The exact error sentinel remains in every designated bounded-failure fixture.
- Raw CLI follow output remains available and unchanged unless the user requests plain output.

## Phase 3: Event-driven job waiting

### 3.1 Introduce a Controller lifecycle notifier

Add a per-job notifier owned by the Controller runtime. It must support multiple simultaneous
waiters without retaining completed jobs indefinitely.

Race-free wait sequence:

1. read current state;
2. subscribe to the job notifier;
3. read current state again;
4. return immediately if terminal, otherwise await notification or timeout;
5. unsubscribe in `finally`.

### 3.2 Centralize notifications

- Emit after committed state changes, never before persistence.
- Audit direct `UPDATE jobs` statements that bypass `transitionJobState`.
- Either route them through the lifecycle helper or explicitly notify after a successful update.
- Preserve a low-frequency database fallback for recovery and test injection.
- Do not use the notifier as durable state.

### 3.3 Test lifecycle races

Cover completion:

- before subscription;
- between first read and subscribe;
- between subscribe and second read;
- while multiple MCP clients wait;
- during Controller shutdown;
- after timeout;
- after cancellation and lost-attempt recovery.

### Phase 3 acceptance

- Fast jobs have no fixed 200 ms polling dependency and meet the under-25-ms p95 injected-transition
  wakeup threshold in the recorded local benchmark environment.
- No waiter hangs when a transition races subscription.
- Listener count returns to zero after completion, cancellation, timeout, and client abort.

## Phase 4: Streaming snapshot archive

### 4.1 Build a direct tar-to-zstd writer

Replace the uncompressed temporary tar with a backpressure-aware pipeline:

```text
ordered entry metadata -> tar header -> file stream -> padding -> zstd -> private candidate archive
```

Requirements:

- deterministic entry ordering and tar metadata;
- write output to a private `.writing` sibling and optionally atomically rename it to a private
  candidate name on writer success; only S-03 may rename a candidate to the published final name;
- compute compressed payload size and SHA-256 while writing;
- compute per-file SHA-256 while reading the file stream;
- hold at most bounded stream buffers plus metadata in memory;
- remove partial archives on error or workspace change;
- support files, directories, symlinks, additional roots, full snapshots, and overlays;
- keep materialization compatible with the existing tar.zst format.

### 4.2 Preserve immutable capture semantics

For every streamed regular file:

- open with containment checks already satisfied;
- capture identity before reading;
- use the opened handle for the stream;
- verify identity again after reading;
- fail `workspace_changed` if size, mtime, type, or file identity changes;
- run the existing repository/status/submodule guard after archive completion;
- build and persist the manifest only from the bytes actually archived.

Do not publish the snapshot row or expose the final archive path before all guards pass. Follow the
publication, database-attachment, orphan-recovery, and failure-injection protocol in Section 5.6.

### 4.3 Add capture limits

Add Controller configuration with conservative defaults for:

- maximum total uncompressed source bytes;
- maximum regular-file count;
- maximum single-file bytes, with an explicit operator override;
- maximum temporary snapshot bytes where meaningful.

Reject before expensive compression whenever metadata is sufficient. Error responses must identify
the limit, actual value, and safe remediation.

### 4.4 Evaluate bounded metadata concurrency

After the streaming writer is correct, benchmark a small internal concurrency pool for lstat,
realpath, and metadata preflight.

- Start with 4 and 8 workers, not 32–64.
- Keep large payload reading sequential through the archive writer.
- Avoid a new dependency if a small local worker-pool helper is sufficient.
- Choose the default only from real Windows NTFS and Linux results using the S-05 thresholds: at
  least 15% median improvement on both fixtures, no p95 regression above 10%, and peak-RSS growth no
  greater than the larger of 32 MiB or 10%.
- Preserve sorted deterministic output regardless of completion order.

### Phase 4 acceptance

- No complete uncompressed tar is created on disk.
- No complete file payload is retained in heap by the archive path.
- Existing full/overlay/materialization and workspace-change tests pass.
- Failure injection at every Section 5.6 publication boundary leaves no referenced partial payload,
  and recovery removes only aged unreferenced temporary/orphaned data.
- Large-file peak RSS and temporary disk usage are bounded and recorded.
- Small snapshots stay within the 10% median wall-time and 32 MiB peak-RSS regression limits.
- Metadata concurrency is enabled only if both real-platform S-05 thresholds pass; otherwise the
  sequential default remains.

## Phase 5: Explicit cross-platform `job_run`

### 5.1 Extend the compact input

- Add optional `shell` and `target_os` fields to the shared MCP registry.
- Map them to the canonical `JobRequest` without introducing a second request model.
- Preserve command wrapping fail-closed behavior for each explicit shell.
- Include shell and target constraints in the derived job name/diagnostics only when useful.

Only if DG-QUEUE is approved, XQ-01 separately adds optional `queue_policy`; it is not part of the
shell/OS acceptance gate.

### 5.2 Improve scheduling diagnostics

When no Agent matches, return a compact structured explanation:

```json
{
  "category": "no_matching_agent",
  "retryable": false,
  "required_shell": "bash",
  "target_os": ["linux"],
  "hint": "No online Agent provides bash on linux"
}
```

Do not return the complete capability report for every Agent. Keep diagnostic text bounded.

### 5.3 Add cross-platform tests

Cover at minimum:

- Windows Controller request explicitly targeting Bash/Linux;
- Linux Controller request explicitly targeting PowerShell/Windows;
- shell present on a non-default OS;
- target OS conflict with shell availability;
- omitted shell with only incompatible cross-platform Agents;
- local fallback respecting explicit shell and OS constraints;
- stdio and Streamable HTTP parity.

Use fake capability reports for deterministic unit coverage and retain a small environment-gated
real cross-platform smoke matrix for releases.

### Phase 5 acceptance

- Compact `job_run` no longer requires `job_submit` solely to select a remote shell/OS.
- The Controller never silently rewrites command syntax between shell families.
- No-match responses are actionable without a separate full `agents_list` call in normal cases.

## Phase 6: `rbo run`

### 6.1 Command interface

Initial interface:

```text
  rbo run [options] -- <shell-command-string>

Options:
  --project <path>         Project root, default current directory
  --cwd <relative-path>    Working directory inside the project
  --shell <shell>          bash|zsh|sh|powershell|pwsh|cmd|direct
  --target-os <os>         Repeatable target OS constraint
  --timeout <seconds>       Remote execution timeout, not an overall CLI wait deadline
  --follow                 Stream logs while running
  --json                   Machine-readable output
  --risk <level>           safe|normal|destructive|hardware
  --artifact <glob>        Repeatable artifact rule
```

If and only if DG-QUEUE and XQ-01 are accepted, also expose:

```text
  --queue-policy <policy>  local_fallback|wait|fail_fast
```

Exactly one positional string is accepted after `--`; zero or multiple positional values are a
usage error. The user's local shell removes its outer quoting, and RBO passes the remaining string
unchanged as target-shell text to `job_run`. Documentation must provide PowerShell, cmd, and POSIX
quoting examples such as `rbo run -- "pnpm test"`. This does not claim argv-safe direct execution.

### 6.2 Runtime behavior

- Build the same compact request used by MCP `job_run`.
- Map `--risk` to `risk_level`, each repeated `--artifact <glob>` to
  `{ glob, required: false }`, and `--timeout` to remote `timeout_seconds`; do not create CLI-only
  policy semantics. Required artifact rules remain available through advanced `rbo submit`.
- Default project root to the resolved current directory.
- The initial CLI has no overall job wait deadline. Individual Controller requests and SSE reconnect
  attempts remain bounded; unrecoverable Controller/transport failure exits 125.
- Use live SSE for `--follow`. SSE reconnect uses the existing event-stream `Last-Event-ID` sequence
  domain; it must not parse, reuse, or expose the opaque MCP log cursor as an SSE event cursor.
- Forward Ctrl+C to `job_cancel`, then wait at most 10 seconds for terminal cancellation. If it is
  still unconfirmed, print the job ID and warning to stderr and exit 130 after the best-effort cancel.
- For confirmation-required jobs, print the snapshot and warnings to stderr and require an explicit
  TTY confirmation. In non-interactive mode, exit 125 with the job ID and confirmation instructions;
  the initial delivery has no silent bypass flag.
- When a terminal remote exit code exists, pass through its 0–255 value exactly. Only when no remote
  exit code exists, use 124 for timeout, 130 for cancellation, 125 for Controller/transport/protocol
  failure, and 1 for another terminal failure.
- Keep stdout suitable for job output and stderr suitable for CLI diagnostics.
- `--json` writes exactly one final JSON object and no human progress text to stdout. Reject
  `--json --follow` in the initial interface instead of inventing an undocumented JSONL stream.

### 6.3 Documentation and tests

- Add help text and getting-started examples.
- Replace the manual JSON file as the primary CLI smoke path while keeping `rbo submit` for advanced
  requests.
- Test quoting on PowerShell, cmd, and POSIX shells.
- Test follow reconnect, cancellation, confirmation, JSON output, and exit-status mapping.

### Phase 6 acceptance

- An operator can run and follow a normal remote command from the current directory with one CLI
  invocation.
- JSON mode is stable enough for scripts and contains no ANSI decoration by default.
- Exit mapping, TTY confirmation, non-interactive refusal, Ctrl+C cancellation, and the separate SSE
  event cursor are covered by integration tests.
- Advanced `rbo submit` behavior remains available and unchanged outside intentional protocol
  updates.

## 7. Dependency order

```text
Phase 0 baseline + CI
        |
        v
Phase 1 opaque resumable logs
        |
        v
Phase 2 MCP presentation
        |
        v
Phase 3 event-driven wait
        |
        v
Phase 5 cross-platform job_run
        |
        v
Phase 6 rbo run

Phase 0 baseline ----> S-01 writer ----> S-02 capture integration
                                          +
Phase 3 W-01 post-commit notifier --------+----> S-03 publish/recovery -> S-04 -> S-05
```

S-01/S-02 can proceed in parallel with the log lane after Phase 0 within the path restrictions in
Section 6.2. S-03 waits for both S-02 and W-01 and runs sequentially with W-02 because it integrates
post-commit notification into the snapshot transaction. Snapshot changes should land separately
from the log wire-contract change. Phase 6 depends on the final `job_run` and cursor contracts so the
CLI does not immediately require a rewrite.

## 8. Validation strategy

During each phase:

1. run the narrowest relevant Vitest files while iterating;
2. run cross-platform or environment-gated checks where the phase requires them;
3. run the before/after benchmark for that phase;
4. update protocol/design/user documentation in the same change as behavior;
5. finish with the repository-required `pnpm format` and `pnpm verify`;
6. also run `pnpm build`, because the current `verify` command does not build TypeScript packages;
7. for packaging-manifest or release-bundle changes, run `pnpm package:archives` and
   `pnpm package:verify` after a successful build; snapshot-runtime changes use their focused
   capture/materialization suites unless they also affect packaging.

Release-level validation additionally records:

- Windows and Linux hosted CI results (`operator_required` until observed);
- actual MCP smoke results for at least one stdio and one Streamable HTTP client
  (`operator_required` until observed);
- snapshot benchmark deltas;
- log response byte-size deltas;
- environment-gated checks performed or explicitly not performed.

## 9. Rollout and compatibility

- Treat the `job_logs` cursor redesign as a coordinated pre-1.0 contract replacement.
- Bump the relevant protocol/tool version and update the compatibility matrix.
- Controller and packaged stdio adapter must ship together.
- Error clearly on an incompatible old adapter/client rather than interpreting an old byte cursor
  as a sequence.
- Keep raw stored logs and tar.zst snapshot format readable where the underlying durable format is
  unchanged.
- Do not add dual response shapes or deprecated aliases.

## 10. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Cursor change breaks clients | Coordinated protocol bump, transport parity tests, explicit incompatibility error |
| ANSI cleanup removes meaningful text | Presentation-only transform, raw logs preserved, CSI/OSC fixtures |
| Byte cap cuts a critical error | Stderr-first newest excerpt, truncation metadata, resumable cursor |
| Event notification loses a race | Subscribe-then-reread pattern and DB fallback |
| Streaming archive captures mixed bytes | Open-handle identity checks, final capture guard, atomic publish |
| Crash leaves ambiguous snapshot state | Final-path-before-DB order, one DB transaction, aged-orphan reconciliation, boundary failure injection |
| Parallel metadata overloads storage | Benchmark 4/8 workers, sequential payload streaming, configurable cap |
| Explicit shell still mismatches syntax | No automatic translation; actionable matching diagnostics |
| CLI quoting differs by platform | Shell-specific integration tests and documented shell-text semantics |
| CI becomes too slow | Fast required matrix plus separate environment-gated/nightly jobs |

## 11. Completion checklist

### 11.1 Local implementation complete

- [ ] Phase 0 baselines recorded and PR/push CI configuration implemented.
- [ ] Opaque resumable log contract implemented and documented.
- [ ] UTF-8, mixed-stream, restart, and cursor tests pass.
- [ ] Shared response budget and ANSI/OSC presentation pipeline implemented.
- [ ] Compact and incremental `job_run` implemented.
- [ ] Event-driven waiter implemented without listener leaks.
- [ ] Direct tar-to-zstd snapshot writer implemented.
- [ ] Capture limits and bounded metadata concurrency validated.
- [ ] Explicit cross-platform `job_run` shell/OS selection implemented.
- [ ] `rbo run` implemented and documented.
- [ ] Local stdio and Streamable HTTP transport-parity tests pass.
- [ ] `pnpm format`, `pnpm verify`, `pnpm build`, and relevant packaging checks pass.
- [ ] Before/after token-facing and performance measurements are included in the final report.

### 11.2 Release evidence complete

- [ ] E-CI has successful hosted Windows/Linux runs for the exact final F-02 identity and a separate
  controlled failure run whose workflow/configuration hashes match F-02.
- [ ] E-XP has a real cross-platform Controller/Agent shell-selection smoke using the exact final
  F-02 artifact.
- [ ] E-MCP has actual stdio and Streamable HTTP client smokes with log resume using the exact final
  F-02 artifact.
- [ ] S-05 has real Windows NTFS and Linux evidence, or the sequential metadata default is retained.
- [ ] No relevant path, base SHA, or built artifact changed after the E-gate evidence was captured;
  otherwise F-02 and affected E gates were rerun.
- [ ] No gate is `operator_required` or `blocked`; external evidence is never inferred from mocks.
