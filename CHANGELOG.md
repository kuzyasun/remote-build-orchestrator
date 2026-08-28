# Changelog

All notable changes to RBO are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/kuzyasun/remote-build-orchestrator/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/kuzyasun/remote-build-orchestrator/releases/tag/v0.7.0
[0.6.2]: https://github.com/kuzyasun/remote-build-orchestrator/releases/tag/v0.6.2
[0.6.0]: https://github.com/kuzyasun/remote-build-orchestrator/releases/tag/v0.6.0
