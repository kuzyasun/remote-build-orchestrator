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

RBO requires Node.js 24.0 or newer on the Controller and every Agent.

Install the CLI on each machine that will run a Controller or Agent:

```bash
npm install -g @gemslibe/rbo
```

### Zero-config setup

1. **Controller machine**: initialize and start (advertises on LAN via mDNS by default):
   ```bash
   rbo controller init
   rbo controller start --daemon
   ```
   *Note: For remote workers across a LAN, data-plane transfers automatically use the connecting network interface. If using custom hostnames, VPNs, or reverse proxies, set `controller_public_host` in `~/.rbo/controller.json`.*
2. **Worker Agent machine**: auto-discover Controller and start:
   ```bash
   rbo agent init             # scans LAN via mDNS, select your Controller [1]
   rbo agent start --daemon
   ```
3. **Controller machine**: approve the worker pairing:
   ```bash
   rbo agent approve          # interactive menu (or `rbo agent approve <id>`)
   ```
4. **AI client**: connect MCP proxy (`rbo-mcp-stdio`) and submit builds.

The [getting-started guide](docs/user/getting-started.md) walks through project configuration and client snippets.

Once configured, the AI client normally drives RBO for you. The CLI remains useful for operations:

```bash
rbo discover                 # scan LAN for active Controllers via mDNS
rbo agents                   # show workers and pending pairing requests
rbo agent approve            # approve a worker (interactive menu or pass <id>)
rbo run --follow -- 'cmd'    # run a job on an available worker
rbo doctor                   # check local setup and connectivity
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
| Review release changes | [Changelog](CHANGELOG.md) |
| Report a vulnerability | [Security policy](SECURITY.md) |
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

## License

RBO is available under the [GNU Affero General Public License v3.0](LICENSE).

For commercial licensing, contact Serge Martyniuk at
[smdev42@proton.me](mailto:smdev42@proton.me).
