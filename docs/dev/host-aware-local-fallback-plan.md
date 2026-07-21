# Plan: host-CPU-aware local fallback

Status: **v1 implemented**, corrected after review (see note below). "Host busy" is CPU% only, per
explicit decision; disk/memory/user-input signals remain out of scope. A real micro-benchmark
capacity score (noted below as a stronger v2 option) is not implemented — v1 uses the
`cores * clock speed` proxy.

**Revision:** the original draft treated the host purely as a last-resort, threshold-gated fallback
(used only when no Agent is eligible at all). Follow-up direction asked for something more: a
strong host should get to exceed the naive threshold, since it finishes the same job faster than a
weaker machine would.

**Correction (post-implementation review):** the first implementation pass wired `cpu_speed_mhz`
and `computeCapacityScore` all the way through the protocol schema, the Agent probe, and the
Controller's submit path into `HostLoadSnapshot.capacityScore` — but `decideLocalFallback` never
actually read that field. The threshold check and the fewest-running-jobs tie-break (§4) were both
real and well-tested; the "strong machine gets real headroom" half of the requirement was not
implemented at all, and a test named for exactly that scenario computed its assertion inline
instead of calling any production code, which is why this went unnoticed initially. Fixed by
`computeEffectiveMaxHostCpuBusyFraction` (§2/§3 below) — a deliberately narrower mechanism than the
original "rank host in the same scored pool as Agents" idea (see why in §3), but one that does
genuinely implement the requirement: a host more powerful than a reference baseline gets a raised
effective threshold, proportional to how much more powerful it is, capped so no host is ever
treated as having no limit at all.

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
(`apps/agent/src/capabilities/probe.ts:177`), just needed `speed` added alongside it
(`cpu_speed_mhz`, same object). Memory factors in as a secondary, smaller weight (a fast CPU
starved for RAM still thrashes) rather than an equal partner — `capacityScore * min(1,
memory_free_mb / memoryReferenceMb)`. A real micro-benchmark (e.g., a few ms of synthetic CPU work
timed at Agent/Controller startup) would be a materially more accurate power signal than "cores ×
clock" — flagging it as a stronger v2 option, not proposing it for v1 given the added complexity
(needs to run once per boot, cache the result, and be comparable across machines consistently).

### 3. What actually consumes the capacity score: a threshold boost, not a ranking

The original idea here was to fold the host into `selectAgentForJob`'s scored candidate pool
alongside Agents (`effectiveScore = capacityScore * (1 - currentLoadFraction)`, pick the highest).
That was **not built** — it would mean restructuring the already-verified §19.2 Agent scoring loop
to also rank a structurally different kind of candidate (no OS/labels/tools/secrets matching
applies to "the Controller's own process"), a materially bigger and riskier change than this
feature needed. It would also cut against the product's own stated motivation: an agent is the
*default* preferred worker specifically so the host stays free; letting a powerful-but-busy host
outrank an available idle Agent would work against that, not reinforce it.

What's actually implemented is narrower and stays entirely inside the existing last-resort fallback
branch — `selectAgentForJob` reaches it exactly like before, only once no Agent is eligible at all:

```ts
// apps/controller/src/scheduler/index.ts
function computeEffectiveMaxHostCpuBusyFraction(
  capacityScore: number,
  baseMaxFraction: number,
  referenceCapacityScore: number, // DEFAULT_REFERENCE_CAPACITY_SCORE: an 8-core/3GHz baseline
): number {
  if (referenceCapacityScore <= 0 || capacityScore <= referenceCapacityScore) {
    return baseMaxFraction; // average-or-weaker host: unchanged, no regression
  }
  const powerRatio = capacityScore / referenceCapacityScore;
  return Math.min(0.97, baseMaxFraction * powerRatio); // capped — never effectively "no limit"
}
```

`decideLocalFallback` compares the host's live `cpuBusyFraction` against this *effective* ceiling
instead of the flat `maxHostCpuBusyFraction` directly. A host at or below the reference power gets
exactly the configured base threshold (identical to pre-feature behavior); a host stronger than the
baseline gets a proportionally higher ceiling, capped at 0.97 so an extreme outlier is never treated
as having no limit at all. This genuinely satisfies "a strong machine can take a job despite being
over the naive threshold" without touching Agent-vs-Agent scoring or the "Agent preferred over
host" default at all.

**Threshold's role, restated accurately**: `RBO_LOCAL_FALLBACK_MAX_HOST_CPU_PERCENT` is the
*baseline* ceiling for an average machine, not a universal cutoff — the effective ceiling actually
applied is host-specific, scaled by that host's own capacity score.

### 4. When everyone is over threshold: fewest running jobs, not a blind failure

If every candidate (host included) is excluded by the threshold, don't `fail_fast`/queue
unconditionally — pick whichever one currently has the **fewest running jobs** (Agents already
expose this via `getActiveJobsForAgents`, `apps/controller/src/scheduler/index.ts:656`; the host's
equivalent is the existing local-execution admission count in
`apps/controller/src/execution/runner.ts`). This is a deliberately simple, well-understood
tie-break for the "nothing is actually free" case — least-bad rather than best, since nothing
qualifies as good right now.

### 5. "Host cools down with no new Agent" gap — already closed, no new code needed

Turned out to already be covered: the existing `leaseSweep` `setInterval` in
`websocket/server.ts` (originally added for lease-expiry sweeping) already calls
`maybeDispatchQueued()` unconditionally every 15s, and `tryDispatchQueuedJobs` re-evaluates
*every* queued job from scratch (not just ones tied to a specific reason) on each call. So a job
queued for `host_busy` gets re-tried on this same cadence with no additional plumbing — implemented
as originally planned turned out to be "nothing to add here."

### 6. Observability

Originally planned as a distinct `job_events` entry — turned out not to fit: `JobEventSchema`
requires a real `attempt_id` (FK to `job_attempts`), and a job stuck in `wait`/`host_busy` has no
attempt yet (that's the whole point — nothing started). Implemented instead as Controller-side
structured logging (`logger.info('local fallback deferred — host over CPU threshold...', {...})`
in `jobs/submit.ts`) when the tie-break resolves against the host — operator-visible, not
surfaced through `job_logs` to the AI client, since there's no attempt for that log to be scoped
to. A future observability-report pass could still aggregate these log lines into a terminal-
outcome-style metric without needing a schema change.

## Open questions (need a decision before implementing)

1. **Threshold default, the reference capacity score, and the 0.97 cap.** 80% CPU as the baseline
   ceiling, an 8-core/3GHz reference machine, and a 0.97 hard cap on the boosted ceiling are all
   placeholders — need validating against what actually feels right in practice, not picked blind.
   In particular, how much should memory factor into the capacity score vs. CPU (currently a
   smaller secondary multiplier — is that right for the workloads this actually runs), and is a
   linear `baseMaxFraction * powerRatio` boost the right curve, or should it flatten out sooner?
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
3. Controller: `HostCpuMonitor` wrapper + config threshold, and
   `computeEffectiveMaxHostCpuBusyFraction` consulted inside `decideLocalFallback` (still reached
   only via `selectAgentForJob`'s existing last-resort fallback branch — see §3's correction). Unit
   tests directly on `decideLocalFallback`/`selectAgentForJob` with fake host/Agent load
   combinations, no real timers/load needed — including the "everyone over threshold → fewest
   running jobs" tie-break and the "stronger-than-reference host gets real headroom" case as their
   own explicit tests (the latter is the one a self-review initially missed, caught only because an
   independent review agent noticed the capacity score was computed but never read).
4. Periodic re-dispatch timer for "everything was over threshold, re-check later," gated on "is
   anything actually queued for this reason" to avoid a no-op busy loop.
5. New `job_events` type for the least-loaded tie-break outcome (§6) in `packages/protocol`'s
   `JobEventSchema`.
6. Update `docs/ops/getting-started.md`'s config table with the new env var(s), and
   `docs/ops/observability-report.md` if it documents terminal-outcome/queue-reason/scheduling-
   decision fields.
