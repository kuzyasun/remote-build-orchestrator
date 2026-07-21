# Plan: host-CPU-aware local fallback

Status: **plan only, not implemented.** v1 defines "host busy" as CPU% only (per explicit decision);
disk/memory/user-input signals are out of scope for v1.

**Revision:** the original draft treated the host purely as a last-resort, threshold-gated fallback
(used only when no Agent is eligible at all). Follow-up direction changed the shape of this:
instead of a flat "yes/no" gate, rank the host among the same candidate pool as Agents, weighted by
a rough capacity score (not just current busy%) — a strong, idle host can still take a job even
near the naive threshold, because it'll finish faster than a weaker machine would anyway. And when
literally every candidate (host + every Agent) is over its threshold, don't fail/queue — pick
whichever one has the fewest currently running jobs. The sections below reflect this.

## What's actually happening today

`selectAgentForJob` (`apps/controller/src/scheduler/index.ts:513-654`) hard-filters and scores
Agents; only when **no eligible Agent exists at all** does it fall through to the fallback table
(§35 Phase 4): `queue_policy=wait` → stays queued, `fail_fast` → structured failure,
`local_fallback` → runs on the Controller's own host, gated only by a static
`allowLocalFallback` boolean (`RBO_ALLOW_LOCAL_FALLBACK`, default true) and the job's risk level
(destructive/hardware never fall back locally). This function is called once at `job_submit`
time (`apps/controller/src/jobs/submit.ts:283`), and again later via `tryDispatchQueuedJobs` →
`maybeDispatchQueued()` (`apps/controller/src/websocket/server.ts:184-194`), which fires whenever
an Agent connects/authenticates/heartbeats — there is currently no *time-based* re-check, only an
*Agent-event*-based one.

So today: if no Agent is eligible and local fallback is allowed, the job runs on your host
regardless of how busy your host already is. The goal is to make that one more condition: don't
run it locally if the host is already under CPU load — queue it instead, and let it dispatch
either when an Agent becomes available (already wired) or when the host itself cools down (not
yet wired — see below).

## A related bug this plan should NOT inherit

`apps/agent/src/capabilities/probe.ts:95` (`probeCpuLoad`) computes CPU load from
`os.loadavg()[0] / cpus().length`. **`os.loadavg()` returns `[0, 0, 0]` on Windows** (confirmed on
this machine, `win32`) — Node doesn't emulate a load average there. This means the existing
scheduler's `-cpu_load*100` scoring term (§19.2, already verified correct in a prior review) is
silently a no-op for every Windows Agent today: it never actually penalizes a busy Windows worker,
because the input is always 0. This plan's new host-side sampler must NOT reuse `probeCpuLoad` as
written; it needs a delta-based `os.cpus()` sampler that works identically on Windows/Linux/macOS
(described below). Fixing `probeCpuLoad` itself to use the same technique is a natural follow-up
but is a separate, pre-existing bug, not part of this plan's scope — flagging it here since it was
found while researching this feature, not to silently leave it undiscovered.

## Design

### 1. Cross-platform CPU sampler (new, in `packages/shared`)

```ts
// two os.cpus() snapshots a short interval apart; busy% = 1 - idleDelta/totalDelta, averaged
// across cores. Works on win32/linux/darwin — unlike os.loadavg().
export function sampleCpuBusyFraction(intervalMs = 200): Promise<number>;
```

Exposed via a small poller (`HostCpuMonitor`) that keeps a short rolling average (e.g. last 3
samples over ~last 3-6s) rather than a single instantaneous read, so one momentary spike doesn't
flap the decision. Runs inside the Controller process (the "host" is the machine running the
Controller, since that's where local-fallback execution actually happens).

### 2. Capacity score — a rough "how powerful is this machine" proxy

A literal CPU-model lookup (matching `os.cpus()[0].model` strings like `"Intel(R) Core(TM)
i7-9700K CPU @ 3.60GHz"` against a table of known chips) isn't practical — there's no
maintainable, portable database of relative CPU performance by model name, and the string format
varies by OS. `os.cpus()` already gives something usable without one: per-core `speed` (MHz) and
core count. Use `cpu_logical * cpu_speed_mhz` as the raw throughput proxy:

```ts
capacityScore = os.cpus().length * (os.cpus()[0]?.speed ?? 0)
```

This is already close to free — `cpu_logical` is already reported in `AgentCapabilityReport`
(`apps/agent/src/capabilities/probe.ts:177`), just needs `speed` added alongside it. Memory factors
in as a secondary, smaller weight (a fast CPU starved for RAM still thrashes) rather than an equal
partner — e.g. `capacityScore * min(1, memory_free_mb / memoryReferenceMb)`. A real micro-benchmark
(e.g., a few ms of synthetic CPU work timed at Agent/Controller startup) would be a materially more
accurate power signal than "cores × clock" — flagging it as a stronger v2 option, not proposing it
for v1 given the added complexity (needs to run once per boot, cache the result, and be comparable
across machines consistently).

### 3. Rank host alongside Agents instead of gating it as last resort

Today `selectAgentForJob` only considers the host once no Agent passes hard-filtering — the host
is not part of the same competition. Change this: after hard-filtering (OS/arch/labels/memory/
disk/toolchain/secrets — unchanged), build one candidate list containing every eligible Agent *and*
the host itself (host is excluded from this list entirely for `destructive`/`hardware` jobs, same
safety rule as today — that constraint doesn't change, only *how* the safe/normal case ranks).

For each candidate compute an **effective score**:

```ts
effectiveScore = capacityScore * (1 - currentLoadFraction)
```

`currentLoadFraction` is the existing `cpu_load` heartbeat value for Agents (already tracked, was
already fed into §19.2's `-cpu_load*100` term) and the new `HostCpuMonitor` reading for the host.
Pick the candidate with the highest `effectiveScore`. This is what lets "our strong machine" win a
job over a weaker idle one even at moderate load — its *available* throughput (power × headroom)
is still higher — without needing a separate carve-out or a raised threshold just for it.

**Threshold's remaining job**: `RBO_LOCAL_FALLBACK_MAX_HOST_CPU_PERCENT` becomes a floor, not the
whole decision — a candidate above it is excluded from consideration entirely regardless of score
(a machine at 95% CPU shouldn't take a job just because its raw specs are good), narrowing the
"who's even eligible" set before ranking by effective score within it.

### 4. When everyone is over threshold: fewest running jobs, not a blind failure

If every candidate (host included) is excluded by the threshold, don't `fail_fast`/queue
unconditionally — pick whichever one currently has the **fewest running jobs** (Agents already
expose this via `getActiveJobsForAgents`, `apps/controller/src/scheduler/index.ts:656`; the host's
equivalent is the existing local-execution admission count in
`apps/controller/src/execution/runner.ts`). This is a deliberately simple, well-understood
tie-break for the "nothing is actually free" case — least-bad rather than best, since nothing
qualifies as good right now.

### 5. Close the "host cools down with no new Agent" gap

`tryDispatchQueuedJobs` already re-fires on Agent connect/heartbeat (`maybeDispatchQueued`,
`websocket/server.ts:184`), but nothing re-fires purely because the host got less busy. Add a
periodic timer (same pattern as the existing lease-expiry `setInterval` at
`websocket/server.ts:210`) that calls `maybeDispatchQueued()` on an interval — but only bother
doing so when at least one job is actually queued for this reason, to avoid a busy-loop when the
queue is empty.

### 6. Observability

Emit a distinct `job_events` entry when every candidate is over threshold and the queue-then-
least-loaded tie-break (§4) had to be used, separate from the normal "picked by effective score"
dispatch — so an AI client watching `job_logs` can tell "everything was busy, went with the least-
bad option" apart from a normal, healthy dispatch, and an operator can see it in the observability
report's terminal-outcome breakdown (also record which candidates were considered and their scores,
for auditing a scheduling decision after the fact).

## Open questions (need a decision before implementing)

1. **Threshold default, and the score formula's weights.** 80% CPU as the exclusion floor and
   `cores * speed` as the capacity proxy are both placeholders — need validating against what
   actually feels right in practice, not picked blind. In particular, how much should memory factor
   in vs. CPU (the plan above treats it as a smaller secondary multiplier — is that right for the
   workloads this actually runs)?
2. ~~What if the host is busy and no Agent is ever available?~~ **Resolved by §4**: if the host is
   the only candidate and it's over threshold, "pick fewest running jobs among all candidates"
   still picks the host (there's nothing else to compare it to) rather than queuing forever — no
   separate grace-period mechanism needed.
3. **Does this apply to jobs already past admission** (i.e., should a long-running local job be
   throttled/paused if the host gets busy mid-run), or only to the initial dispatch decision? This
   plan only covers the latter — pausing an in-flight job is a materially bigger feature.
4. **New:** should a *remote* Agent's own local-fallback-equivalent (i.e., does an Agent ever have
   a reason to refuse/defer a job because of Agent-side non-CPU load, like disk pressure — already
   partially handled by existing disk-pressure admission) participate in the same effective-score
   ranking, or does disk-pressure admission stay a separate, earlier hard-filter as it is today?
   Leaning toward "stays a separate hard-filter" (it's binary — degraded disk means genuinely can't
   accept, not just "less preferable") but worth confirming.

## Implementation order

1. `packages/shared`: `sampleCpuBusyFraction` + tests (mock `os.cpus()` timings, verify math on a
   synthetic before/after pair — no real machine load dependency).
2. `packages/shared` or `packages/protocol`: `capacityScore(cpuLogical, cpuSpeedMhz, memoryFreeMb)`
   as a small, independently unit-testable pure function — add `cpu_speed_mhz` alongside the
   already-reported `cpu_logical` in `AgentCapabilityReport`, and compute the host's own via the
   same function.
3. Controller: `HostCpuMonitor` wrapper + config threshold, and the effective-score ranking inside
   `selectAgentForJob` — host becomes one more entry in the candidate list rather than a separate
   branch. Unit tests directly on `selectAgentForJob` with fake candidates (varied score/load
   combinations), no real timers/load needed — including the "everyone over threshold → fewest
   running jobs" tie-break as its own explicit test case.
4. Periodic re-dispatch timer for "everything was over threshold, re-check later," gated on "is
   anything actually queued for this reason" to avoid a no-op busy loop.
5. New `job_events` type for the least-loaded tie-break outcome (§6) in `packages/protocol`'s
   `JobEventSchema`.
6. Update `docs/ops/getting-started.md`'s config table with the new env var(s), and
   `docs/ops/observability-report.md` if it documents terminal-outcome/queue-reason/scheduling-
   decision fields.
