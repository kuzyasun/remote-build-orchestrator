# Changelog

All notable changes to RBO are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.0] - 2026-09-24

### Added

- Native macOS mDNS discovery adapter in `@rbo/discovery` using `/usr/bin/dns-sd` IPC with `mDNSResponder`, resolving UDP 5353 port binding conflicts on macOS while maintaining cross-platform `bonjour-service` support on Windows and Linux.
- Cross-platform network and port diagnostics in `rbo doctor`:
  - `controller_ports`: TCP 7410 (HTTP) and 7411 (Agent Plane WebSocket) availability and active process inspection across Windows (`netstat`), Linux (`ss`, `lsof`), and macOS (`lsof`).
  - `mdns_port`: UDP 5353 collision detection that warns when non-wildcard interface bindings (e.g. Zoom) intercept incoming mDNS discovery packets on the local host.
  - `firewall`: Cross-platform firewall status checks with actionable remediation commands for Windows Defender Firewall (`New-NetFirewallRule`), Linux `ufw` and `firewalld`, and macOS Application Firewall (`socketfilterfw`).
- Local development guide (`docs/dev/local-development.md`) covering building from source, packaging with `pnpm pack`, and global installation workflows.
- Dedicated firewall troubleshooting guide (`docs/user/troubleshooting.md`) and getting-started reference covering inbound rules for Node.js (`nvm4w`), Agent plane (TCP 7411), and mDNS discovery (UDP 5353) across Windows, Linux, and macOS.

### Changed

- `scripts/bump-version.mjs`: Dynamically synchronizes all 12 monorepo workspace packages (`apps/*`, `packages/*`), `native/windows-executor/Cargo.toml`, `Cargo.lock`, runtime constants, lockfile, packaging manifests, and `CHANGELOG.md` in lockstep.
- `scripts/release-pack.mjs`: Added cross-platform packaging support for non-Windows hosts, and automated CLI bundle rebuilding before packaging.
- Synchronized package versions across all `@rbo/*` workspace packages and `Cargo.toml` to lockstep product version `0.8.0`.
- Added `"private": true` to all 9 internal workspace packages (`@rbo/*`) to protect against unintended npm registry publication.

### Fixed

- Windows Defender Firewall evaluation in `rbo doctor` now requires TCP or ANY protocol before marking `node.exe` inbound traffic allowed, preventing false positives from mDNS UDP rules.
- Linux Controller port conflict detection now properly flags foreign occupied sockets on port 7411 when unprivileged `ss` reports PID 0.
- macOS Application Firewall query failure handling now reports an advisory warning rather than falsely diagnosing the firewall as disabled when `socketfilterfw` is unavailable.
- `lsof` socket parser now dynamically locates PID tokens to support command names containing whitespace.
- Cleaned up dependency graph: moved `@rbo/testing` from `dependencies` to `devDependencies` in `apps/agent` and added missing runtime `ws` dependency in `apps/controller`.

## [0.8.0] - 2026-09-16

### Added

- Zero-configuration mDNS/DNS-SD discovery (`@rbo/discovery`, §7.2) for automatic Controller advertisement and Agent discovery on local networks.
- Controller automatic mDNS advertisement on start, with graceful goodbye packets on shutdown (`mdns_enabled`, `mdns_display_name`).
- Interactive Controller selection during `rbo agent init` and standalone `rbo discover [--json]` command for scanning LAN controllers.
- Interactive Agent pairing approval and rejection (`rbo agent approve` / `rbo agent reject`) on the Controller without needing to copy 26-character pairing IDs.
- Standalone CLI reference guide (`docs/user/cli-reference.md`) covering all commands, options, and shell execution semantics.

### Changed

- Made zero-configuration mDNS discovery the primary default onboarding path in `README.md` and `docs/user/getting-started.md`.
- Streamlined `docs/user/getting-started.md` and moved manual network configuration to a dedicated fallback section for routed subnets and headless CI.
- Updated `rbo agent approve` and `rbo agent reject` usage to support optional `[<pairing-request-id>]` argument with TTY prompt fallback.

## [0.7.0] - 2026-08-28

### Added

- Bounded MCP log presentation for `job_run` and `job_logs`, with a default 16 KiB `job_run` output
  budget, opaque attempt-scoped resumable cursors, and ANSI/OSC stripping for AI clients. Durable
  raw logs on disk are unchanged. Terminal MCP payloads omit empty metadata.
- `rbo run -- <command>` CLI that captures a snapshot, submits the same compact request as
  `job_run`, waits for a terminal result, follows live logs, prompts for confirmation from a TTY,
  supports `--json`, and cancels on Ctrl+C.
- Explicit `shell`, `target_os`, and `queue_policy` on MCP `job_run` and `rbo run`, plus compact
  `no_match` diagnostics when no compatible Agent is online.
- Streaming snapshot capture directly to `.tar.zst`, with capture leases, publication fencing, and
  configurable Controller limits.
- Linux and Windows GitHub Actions source-verification workflow on pull requests and `master`.

### Changed

- Replaced synthetic byte log cursors with opaque server-issued cursors. Clients must copy
  `next_cursor` and must not construct cursors.
- `job_wait` waits on job lifecycle events instead of polling.
- Snapshot capture is bounded before compression by Controller defaults (1 GiB source, 100,000
  files, 256 MiB per file), overridable in `controller.json`.
- Controller storage schema version 5 (snapshot capture leases). Existing data directories migrate
  on start.

### Fixed

- Preserved Windows process trees when a job is cancelled.
- Stopped cross-platform jobs from silently running on the Controller when no matching Agent is
  available.
- Rolled back failed snapshot publication and surfaced submodule status failures instead of capturing
  a partial tree.

## [0.6.2] - 2026-07-30

### Added

- Complete npm package metadata for the project, author, repository, issue tracker, and keywords.
- Repository-level AGPL-3.0-only license and security reporting policy.
- GitHub Actions publishing through npm Trusted Publishing with automatic provenance.

### Changed

- Reorganized user and developer documentation around task-focused entry points.

### Fixed

- Made the synthetic warm-cache test verify the executed path instead of relying on runner timing.
- Normalized repository text files to LF so release builds are reproducible on Windows runners.
- Build and pack the Windows helper before verifying packaging manifests in the release workflow.

## [0.6.0] - 2026-07-29

Baseline release for this changelog. It includes the RBO CLI, Controller, Agent, MCP stdio adapter,
remote execution, isolated source snapshots, logs, artifacts, and the Windows x64 Job Object
helper.

Earlier pre-1.0 npm releases were not documented in this file.

[Unreleased]: https://github.com/kuzyasun/remote-build-orchestrator/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/kuzyasun/remote-build-orchestrator/releases/tag/v0.9.0
[0.8.0]: https://github.com/kuzyasun/remote-build-orchestrator/releases/tag/v0.8.0
[0.7.0]: https://github.com/kuzyasun/remote-build-orchestrator/releases/tag/v0.7.0
[0.6.2]: https://github.com/kuzyasun/remote-build-orchestrator/releases/tag/v0.6.2
[0.6.0]: https://github.com/kuzyasun/remote-build-orchestrator/releases/tag/v0.6.0
