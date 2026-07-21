# RBO — Remote Build Orchestrator

**Stop letting AI-agent builds and tests peg your main machine. Offload them to whatever other
computers you have sitting idle — while still being able to run them on your own host when that's
the right call.**

AI coding agents (Codex, Claude, Cursor, Antigravity, …) build and test *a lot* while they work —
often heavier and more often than a human would, and usually right when you're trying to keep
using the same machine for everything else. RBO's first job is to spread that load: whenever you
have another machine available, an agent's build/test/QEMU/Docker job runs there instead of on
your host, so your host stays responsive and the agent isn't waiting behind your own CPU/disk
contention. It's not an all-or-nothing switch — a job can still run locally when that's what makes
sense (no other machine free, a policy that requires it); the point is to actually *distribute* the
work across host + available machines, not to ban local execution. The net effect: agents get more
throughput, and working on your own machine while they're busy stays comfortable.

RBO does this by running each job against an exact, isolated snapshot of your current dirty working
tree (uncommitted changes included) — never against your live files. Whichever machine ends up
running the job, it can't touch the tree you're actively editing. The same snapshot isolation also
makes it safe to run genuinely destructive or hardware-risk jobs: they come back
`awaiting_confirmation` with a short-lived token, and nothing runs until you confirm it.

## Why

- **Keep your host free while agents work.** Route the build/test/QEMU/Docker load an AI agent
  generates onto other available machines instead of competing with it for your own CPU/disk —
  local execution stays available as a fallback, not disabled. When it does fall back to your own
  machine, it checks your host's real CPU load first and prefers queuing (or another machine)
  over piling onto an already-busy host — see
  [`docs/dev/host-aware-local-fallback-plan.md`](docs/dev/host-aware-local-fallback-plan.md).
- **Faster agents, more comfortable host.** Spreading work across host + Agents means an agent
  doesn't have to wait its turn behind whatever else you're doing on the same machine, and you
  don't have to wait behind the agent.
- **Safe by construction, not by policy.** Every job runs against a snapshot instead of your live
  tree, so a `rm -rf` in a "destructive" job can't touch your real files, and destructive/hardware-
  risk jobs come back `awaiting_confirmation` with a short-lived token nothing can skip.
- **Works with the repo you actually have.** Uncommitted changes, untracked files, staged and
  unstaged edits — captured exactly, including on large repos via a cached Git overlay instead of
  re-sending the whole tree every time.
- **Recovers from real interruptions.** A dropped connection during a long build doesn't lose logs
  or silently re-run a side-effecting script.
- **One MCP integration, any client.** Codex, Claude, Cursor, and Antigravity all talk to the same
  Controller through the same tools — `job_submit`, `job_wait`, `job_logs`, `job_artifacts`,
  `job_cancel`.

## What it looks like in practice

1. Your AI agent calls `job_submit` with a script and your project's dirty working tree.
2. RBO snapshots that tree exactly as it is right now and queues the job.
3. A paired Agent on another machine picks it up and runs it there — freeing your own machine
   entirely for that job's duration; if no other machine is available (or policy calls for it),
   it falls back to running locally instead.
4. Your agent polls `job_wait`/`job_logs`, then pulls back any declared output via
   `job_artifacts`/`artifact_materialize`.
5. You keep working on your host the entire time, unaffected by whatever the job is doing —
   whether it ran elsewhere or fell back to local, it only ever touched an isolated snapshot.

## Install

RBO isn't published as a single global package yet — see [Roadmap](#roadmap) below. Today:

**Option A — download a release archive** (fastest, no build toolchain needed):
extract the archive for your OS, then follow
[`docs/ops/getting-started.md`](docs/ops/getting-started.md) to set up the Controller, pair an
Agent, and connect your AI client's MCP config.

**Option B — build and run from this repo** (if you're modifying RBO, or no release archive exists
yet for your platform):

```bash
git clone <this repo> && cd rm-builder
pnpm install
pnpm verify                 # build + full test gate — should exit 0
node apps/controller/dist/main.js   # start the Controller (see getting-started.md for env vars)
```

Then continue from step 4 of [`docs/ops/getting-started.md`](docs/ops/getting-started.md) (pairing
an Agent and wiring your AI client).

## Usage

Once set up, you mostly don't type commands — your AI client's MCP tools drive the whole
`job_submit → job_wait → job_logs → job_artifacts` workflow. To try it by hand or script it
outside an AI client, the `rbo` CLI exposes the same operations:

```bash
rbo submit job.json      # submit a job request (see getting-started.md for the JSON shape)
rbo logs <job_id>        # fetch incremental logs
rbo cancel <job_id>      # cancel a running job
rbo doctor               # sanity-check git, data dir, shells, Controller reachability
```

Want your AI agent to *default* to routing builds through RBO instead of running them inline? See
step 8 of [`docs/ops/getting-started.md`](docs/ops/getting-started.md#8-tell-your-ai-coding-assistant-to-actually-use-rbo)
for an `AGENTS.md`/`CLAUDE.md` snippet to drop into your own project.

## Documentation

| For... | Read |
|---|---|
| Setting up a Controller + Agent(s) and connecting an AI client | [`docs/ops/getting-started.md`](docs/ops/getting-started.md) |
| Day-2 operations (pair/drain/revoke/repair/update/backup/restore) | [`docs/ops/runbook.md`](docs/ops/runbook.md) |
| Modifying RBO itself — architecture, component interaction, tech stack | [`docs/dev/architecture.md`](docs/dev/architecture.md) |
| Building and packaging a release | [`docs/dev/release-builds.md`](docs/dev/release-builds.md) |
| The full architectural design spec (§-numbered, canonical) | [`remote-build-orchestrator-design.md`](remote-build-orchestrator-design.md) |

## Known limitations

- Real process-tree containment (Win32 Job Objects) exists for Windows Agents only; macOS/Linux
  Agents run scripts without an equivalent isolation layer today.
- OS service install for the Agent is dry-run by default (`--execute` runs it for real, but there's
  no fully-automated unattended install path yet).
- AI client compatibility is honestly `not_verified` for every real product client until someone
  runs the smoke workflow against it and records evidence — see
  [`docs/compatibility/report.md`](docs/compatibility/report.md).

## Roadmap

- A single global install (`npm install -g rbo-cli` or similar, then `rbo controller start` /
  `rbo agent start` / `rbo submit ...`) instead of extracting a per-OS archive. Not built yet — see
  [`docs/dev/global-cli-packaging-plan.md`](docs/dev/global-cli-packaging-plan.md) for what's
  actually required to get there.

## Contributing

See [`AGENTS.md`](AGENTS.md) (mirrored in `CLAUDE.md`) for repo conventions, canonical commands,
and the required `pnpm format && pnpm verify` gate before any change is considered done.
