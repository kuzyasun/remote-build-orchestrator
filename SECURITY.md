# Security policy

RBO executes commands, transfers source snapshots, and connects machines over the network.
Security reports are welcome and should be handled privately.

## Supported versions

RBO is currently pre-1.0. Security fixes are released for the latest published version only.
Please update before reporting an issue that may already be fixed.

## Report a vulnerability

Use
[GitHub private vulnerability reporting](https://github.com/kuzyasun/remote-build-orchestrator/security/advisories/new)
when possible. If that is unavailable, email
[smdev42@proton.me](mailto:smdev42@proton.me).

Do not open a public issue for a suspected vulnerability.

Include:

- the affected RBO version and operating system;
- the Controller and Agent deployment shape;
- steps to reproduce or a minimal proof of concept;
- the expected and observed impact;
- any suggested mitigation, if known.

Please avoid accessing data that is not yours, disrupting other systems, or publishing details
before a fix is available. We aim to acknowledge reports within five business days and will
coordinate disclosure after the issue is understood and a remediation plan exists.

## In scope

Examples include:

- Controller authentication or loopback-boundary bypasses;
- Agent pairing, identity, TLS pinning, or authorization failures;
- workspace escape, path traversal, or unsafe artifact materialization;
- secret exposure through snapshots, logs, or artifacts;
- process-isolation or cleanup failures that cross job boundaries;
- stale-attempt, lease, or fencing behavior that permits unauthorized execution.

General support requests and non-security bugs belong in
[GitHub Issues](https://github.com/kuzyasun/remote-build-orchestrator/issues).
