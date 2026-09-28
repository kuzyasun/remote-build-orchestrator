# RBO — Remote Build Orchestrator

RBO runs builds, tests, QEMU, and Docker jobs on a worker machine, instead of in the checkout your
editor is using. An AI client talks only to a Controller on the same computer. The Controller sends
the job to a paired Agent.

```text
your computer                         worker on the same LAN
┌───────────┐   MCP, localhost   ┌────────────┐     LAN, paired    ┌───────┐
│ AI client │ ─────────────────► │ Controller │ ─────────────────► │ Agent │
└───────────┘                    └────────────┘                    └───────┘
                                      │  snapshot of the checkout       │ runs the job
                                      └──────── logs and artifacts ◄────┘
```

The Controller copies the working tree, including uncommitted changes, and the job runs only in
that copy. Logs and requested artifacts come back to the client. The command does not run in the
live checkout.

The Agent link is for a local network you already trust (or a VPN you treat the same way). You
approve each worker before it can take a job. This is not a secure remote-access product, and it
does not protect you from other devices on that network. Keep the Controller's MCP port on
localhost.

The same computer can run both the Controller and an Agent. A second machine is useful when you
want the build off the machine you are editing on.

## Quick start

Node.js 24 or newer is required on the Controller and on every Agent.

```bash
npm install -g @gemslibe/rbo
```

On the Controller:

```bash
rbo controller init
rbo controller start --daemon
```

On each worker, on the same LAN:

```bash
rbo agent init      # finds the Controller and asks you to pick it
rbo agent start --daemon
```

Back on the Controller, approve the worker:

```bash
rbo agent approve
```

Then point your AI client at the local MCP proxy (`rbo-mcp-stdio`). After that, the client submits
jobs. These commands are for you:

```bash
rbo agents                 # workers and pending pairing requests
rbo run --follow -- 'cmd'  # run one command on a worker
rbo doctor                 # local setup and connectivity
```

A worker that is not on the same LAN, and the per-client MCP snippets, are in the
[getting-started guide](docs/user/getting-started.md).

Destructive and hardware-risk jobs wait for an explicit confirmation before they start.

## Documentation

| Goal | Read |
| --- | --- |
| Install, pair, and run a first job | [Getting started](docs/user/getting-started.md) |
| Connect an AI client | [AI client configuration](docs/user/client-integration/README.md) |
| Something failed | [Troubleshooting](docs/user/troubleshooting.md) |
| Day-to-day operation | [Operator runbook](docs/user/runbook.md) |
| How the code is laid out | [Architecture](docs/dev/architecture.md) |
| Build from this repository | [Local development](docs/dev/local-development.md) |
| Cut a release | [Release guide](docs/dev/release-builds.md) |
| What changed | [Changelog](CHANGELOG.md) |
| Report a vulnerability | [Security policy](SECURITY.md) |
| Work in this repository | [Contributor guidance](AGENTS.md) |
| Protocol and scheduler contract | [Design specification](remote-build-orchestrator-design.md) |

The design specification is for protocol, scheduler, and security changes. You do not need it to
install or operate RBO.

## Current limitations

- The Agent port is for a trusted LAN or VPN. Do not publish it on the internet.
- A job is isolated from your live checkout. RBO is not a sandbox for untrusted code.
- Windows Job Object process trees exist only for Windows x64 Agents. macOS and Linux Agents are
  for trusted development workloads.
- Installing the Agent as an OS service is dry-run unless you pass `--execute`.
  `rbo agent start --daemon` is the straightforward way to run a worker.

## Contributing

See [AGENTS.md](AGENTS.md) for repository conventions and the required `pnpm format` then
`pnpm verify` check.

## License

RBO is available under the [GNU Affero General Public License v3.0](LICENSE).

For commercial licensing, contact Serge Martyniuk at
[smdev42@proton.me](mailto:smdev42@proton.me).
