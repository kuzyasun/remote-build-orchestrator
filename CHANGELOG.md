# Changelog

All notable changes to RBO are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/kuzyasun/remote-build-orchestrator/compare/v0.6.2...HEAD
[0.6.2]: https://github.com/kuzyasun/remote-build-orchestrator/releases/tag/v0.6.2
[0.6.0]: https://github.com/kuzyasun/remote-build-orchestrator/releases/tag/v0.6.0
