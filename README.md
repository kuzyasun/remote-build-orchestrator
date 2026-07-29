# RBO — Remote Build Orchestrator

RBO moves builds, tests, QEMU runs, and Docker jobs from an AI coding assistant to one or more
worker machines. Your current checkout stays responsive and untouched, while the assistant still
gets logs and artifacts through MCP.

## What problem does it solve?

AI coding assistants run commands frequently. Running every command directly in your working tree
creates three problems:

- builds compete with your editor and other work for CPU, memory, and disk;
- a command can modify files you are editing;
- adding another machine usually requires client-specific scripts and manual coordination.

RBO gives supported AI clients one interface for this work. It captures the current state of the
project, including uncommitted changes, and runs the job in an isolated workspace on an available
Agent. The Controller can also run the job locally when your policy allows it.

This is useful when you:

- use Codex, Claude, Cursor, Antigravity, OpenCode, or ZCode for development;
- have an idle desktop, laptop, build server, or lab machine;
- run expensive builds, tests, emulators, or containers;
- need outputs from a job without letting it write into the live checkout.

## How it works

```text
AI client ──MCP──> Controller ──secure connection──> Agent
                       │                                │
                       │ creates an isolated snapshot   │ runs the job
                       └──────── logs and artifacts <────┘
```

1. The AI client submits a command and project path.
2. The Controller captures an immutable snapshot of the current working tree.
3. The scheduler selects a compatible Agent, or uses local fallback when allowed.
4. The job runs only inside the isolated snapshot.
5. The client reads the result, logs, and requested artifacts.

Destructive and hardware-risk jobs require explicit confirmation before they start.

## Quick start

RBO requires Node.js 22.14 or newer on the Controller and every Agent.

Install the CLI on each machine that will run a Controller or Agent:

```bash
npm install -g @gemslibe/rbo
```

Then:

1. initialize and start the Controller;
2. initialize an Agent and pair it with the Controller;
3. connect your AI client's MCP configuration;
4. run `rbo doctor`, then submit a first job.

The [getting-started guide](docs/user/getting-started.md) provides the commands and the small set
of configuration values required for each step. If the npm package is not available for your
environment, the same guide also explains how to install a local build.

Once configured, the AI client normally drives RBO for you. The CLI remains useful for diagnostics
and manual jobs:

```bash
rbo agents                 # show workers and pending pairing requests
rbo submit job.json        # submit a job manually
rbo logs <job-id> --follow # follow its logs
rbo cancel <job-id>        # cancel it
rbo doctor                 # check the local setup
```

## Documentation

Start with the document that matches your goal:

| Goal | Read |
| --- | --- |
| Understand, install, and try RBO | [Getting started](docs/user/getting-started.md) |
| Connect a specific AI client | [AI client configuration](docs/user/client-integration/README.md) |
| Diagnose a problem | [Troubleshooting](docs/user/troubleshooting.md) |
| Operate, update, back up, or remove RBO | [Operator runbook](docs/user/runbook.md) |
| Understand the codebase | [Architecture](docs/dev/architecture.md) |
| Build or publish a release | [Release guide](docs/dev/release-builds.md) |
| Work on this repository | [Contributor guidance](AGENTS.md) |
| Read the complete design contract | [Design specification](remote-build-orchestrator-design.md) |

The design specification is intentionally detailed. Most users do not need it, and developers
should use it only when changing a protocol, state machine, scheduler rule, or security boundary.

## Current limitations

- Strong process-tree containment through Windows Job Objects is currently available only on
  Windows x64 Agents. macOS and Linux are suitable for trusted development workloads but do not
  provide equivalent containment.
- Agent service installation is best-effort and dry-run by default. Running
  `rbo agent start --daemon` is the simpler option today.
- RBO isolates a job from your live checkout; it is not a general-purpose sandbox for untrusted
  code.

## Contributing

See [AGENTS.md](AGENTS.md) for repository conventions, canonical commands, and the required
`pnpm format` followed by `pnpm verify` validation gate.
