# Security Best-Practices Review

Date: 2026-07-21  
Scope: current working tree of the RBO monorepo, with emphasis on the Controller HTTP/MCP boundary, Controller-to-Agent transport, pairing and credentials, job execution, source materialization, Git acquisition, service lifecycle, and sensitive on-disk state.

## Executive summary

RBO has several strong security controls already in place: the MCP listener is restricted to loopback, Controller-to-Agent traffic uses pinned TLS plus Ed25519 proof-of-possession, data-plane tokens are short-lived and fenced to a lease tuple, source and artifact paths receive lexical/realpath checks, artifact bytes are size/hash checked, Git remotes are allowlisted, and injected secret values have a stateful streaming redactor.

The review nevertheless found one critical issue, four high-severity issues, and three medium-severity issues. The most urgent problem is that a browser-originated, unauthenticated POST can reach the loopback internal tool API and submit a normal-risk job, which RBO executes without confirmation. The next priorities are eliminating privileged Agent service defaults, stopping wholesale inheritance of daemon environment variables into jobs, bounding unauthenticated pairing traffic, and enforcing the Git allowlist for repository-controlled LFS endpoints.

Because RBO intentionally provides remote code execution, these boundaries must be treated as security controls rather than operational conveniences. A failure in client authentication, least privilege, or secret scoping immediately becomes code execution or credential disclosure.

## Severity overview

| ID | Severity | Finding |
|---|---|---|
| SEC-001 | Critical | Unauthenticated loopback tool API is exposed to cross-origin POSTs and can execute jobs |
| SEC-002 | High | Windows Agent service defaults to `LocalSystem` while executing remote job scripts |
| SEC-003 | High | Every job inherits the daemon's complete environment, bypassing `secret_refs` isolation |
| SEC-004 | High | Unauthenticated Agent pairing is unbounded and can persist attacker-controlled data |
| SEC-005 | High | Repository-controlled Git LFS endpoints bypass the configured Git host allowlist |
| SEC-006 | Medium | Snapshot decompression and tar parsing have no expansion or aggregate extraction limits |
| SEC-007 | Medium | Windows executor handle inheritance can defeat process-tree cleanup and hang an Agent |
| SEC-008 | Medium | Sensitive state directories and most state files rely on the process umask/default ACLs |

## Critical findings

### SEC-001: Unauthenticated loopback tool API is exposed to cross-origin POSTs and can execute jobs

**Impact:** A malicious web page visited by the developer can submit a job to the local Controller and cause arbitrary commands to execute as the Controller user.

Evidence:

- `apps/controller/src/http/server.ts:56-62` buffers request bodies without checking authentication, content type, or origin.
- `apps/controller/src/http/server.ts:73-84` treats the attacker-controlled `x-rbo-client-id` header as identity; it is attribution, not authentication.
- `apps/controller/src/http/server.ts:146-184` accepts any POST body on `/internal/v1/tools/<tool>` and dispatches it directly. It does not require the media type used by the stdio proxy, a bearer credential, a CSRF token, or an allowed `Origin`.
- `apps/controller/src/http/server.ts:243-259` exposes both the MCP and internal tool/admin routes on the loopback listener without route-level authorization.
- `apps/mcp-stdio/src/proxy.ts:26-33` confirms that the intended stdio caller supplies only a client ID, not a secret.
- `apps/controller/src/jobs/submit.ts:120-176` accepts a valid `job_submit`; normal-risk jobs do not enter the confirmation path beginning at line 176 and are dispatched for execution.

An attacker does not need to read the response. A browser can issue a fire-and-forget POST using a browser-safelisted content type such as `text/plain`; the internal handler parses the body as JSON regardless of `Content-Type`. The attacker must know or guess an allowed project path, but common paths can be tried repeatedly because neither authentication nor origin checks gate the operation. Browser local-network protections are not a server-side security boundary and are not consistently available across browsers, webviews, and desktop clients.

Recommended remediation:

1. Generate a high-entropy local API bearer token during Controller initialization, store it with owner-only permissions, and require it on `/mcp`, `/internal/v1/tools/*`, and `/internal/v1/admin/*`. Pass it to the stdio adapter out of band.
2. Reject requests carrying an `Origin` header unless the origin is explicitly configured. Native/CLI callers normally omit `Origin`; this blocks ordinary web-page CSRF.
3. Require the expected JSON media type for mutating endpoints and reject browser-safelisted content types.
4. Validate `Host` against the configured loopback host and bound port as a DNS-rebinding defense in depth.
5. Add per-route request-size limits and short header/body timeouts before JSON parsing.
6. Add an integration test that sends a `text/plain` cross-origin-style request to `job_submit` and verifies rejection before snapshot capture or job creation.

## High-severity findings

### SEC-002: Windows Agent service defaults to `LocalSystem` while executing remote job scripts

Evidence:

- `apps/cli/src/commands/service.ts:71-84` renders `sc.exe create RBOAgent ...` without an `obj=` service account. Windows services created this way run as `LocalSystem` by default.
- `apps/cli/src/commands/service.ts:238-249` executes the rendered commands when requested.
- `apps/cli/src/main.ts:145-156` exposes the `agent install --execute` path.
- `packages/executor/src/script.ts:405-492` launches the submitted script with the Agent process token.

The Agent's core function is remote arbitrary-code execution. Running it as `LocalSystem` turns compromise of a paired Controller, Controller signing material, or an approved job source into complete Windows host compromise. The global LaunchDaemon/systemd installation shapes should likewise define an explicit unprivileged identity rather than depend on system defaults.

Recommended remediation:

- Create a dedicated, non-administrator service account with no interactive logon and ACL only the Agent state/cache directories and required toolchains.
- Require explicit opt-in for narrowly scoped hardware access (serial/JTAG/USB groups or device ACLs); do not grant broad administrator rights.
- On Linux, set `User=`, `Group=`, `NoNewPrivileges=true`, a restrictive `UMask`, and appropriate systemd sandboxing directives. On macOS, set `UserName` in the launchd plist and restrict writable paths.
- Make installation fail closed if the dedicated identity cannot be created or resolved. Document any operator override as a security-impacting choice.

### SEC-003: Every job inherits the daemon's complete environment, bypassing `secret_refs` isolation

Evidence:

- `packages/executor/src/script.ts:387-402` constructs the child environment as `{ ...process.env, ...userEnv, ...injected }`.
- `apps/agent/src/executor/index.ts:1207-1229` resolves and tracks only explicitly requested secret values.
- `apps/agent/src/executor/index.ts:1231-1232` configures log redaction only for those explicitly requested values.
- `apps/controller/src/execution/runner.ts:308-321` uses the same shared spawn path for local execution, so local jobs also receive the full Controller environment.

Any build script can read all environment variables of the Agent/Controller service, including variables used to configure secret mappings, Git credentials, proxy credentials, cloud credentials, and unrelated service secrets. Unrequested values are not passed through the redactor and may be printed directly into persistent logs. This makes `secret_refs` an additive convenience rather than an authorization boundary.

Recommended remediation:

1. Build job environments from a small platform-specific baseline (`PATH`, required system variables, temporary/home directories), not from `process.env`.
2. Add validated user-provided environment values, reserved RBO values, and only explicitly resolved secret references.
3. Maintain an explicit denylist for daemon-only variables (`RBO_*` configuration, credential helper variables, cloud/provider credentials) as defense in depth.
4. Make local execution use the same named-secret resolver and redactor as remote execution.
5. Add tests proving that an unrequested sentinel environment variable is absent from both the child environment and logs, while an explicitly authorized secret is present for the child and redacted from logs.

### SEC-004: Unauthenticated Agent pairing is unbounded and can persist attacker-controlled data

Evidence:

- `apps/controller/src/websocket/server.ts:135-140` creates the WebSocket server without an application-specific `maxPayload`, connection quota, or rate limiter.
- `apps/controller/src/websocket/server.ts:225-299` accepts `pairing_request` before authentication.
- `apps/controller/src/websocket/server.ts:267-288` converts unbounded values to strings and treats the substring `PUBLIC KEY` as sufficient key validation.
- `apps/controller/src/security/pairing.ts:48-85` hashes and persists the complete supplied key, display name, hostname, and metadata for each unique device thumbprint.
- `apps/controller/src/websocket/server.ts:474-479` binds the Agent plane without a host argument, making it network-reachable as intended.

An unauthenticated LAN/VPN peer can repeatedly submit unique oversized pseudo-keys and names. Each request performs hashing and a synchronous SQLite insert and leaves persistent data until operator cleanup. Repetition can exhaust Controller CPU, memory, or disk and obscure legitimate pairing requests.

Recommended remediation:

- Set a small explicit WebSocket payload cap suitable for the protocol (for example, 64 KiB) and bound individual string/array fields in the wire schemas.
- Parse the key with `crypto.createPublicKey`, require Ed25519, and store a canonical exported public key rather than attacker-supplied PEM text.
- Enforce a connection/authentication state machine, per-IP pairing rate limits, a global pending-pairing cap, and automatic deletion of expired/rejected requests.
- Apply handshake, idle, and authentication deadlines and cap simultaneous unauthenticated sockets.

### SEC-005: Repository-controlled Git LFS endpoints bypass the configured Git host allowlist

Evidence:

- `apps/agent/src/repos/controlled-git.ts:79-95` validates `.gitmodules` URLs but invokes `git lfs pull` without resolving and checking the effective LFS URL.
- `apps/agent/src/repos/controlled-git.ts:97-105` attempts only a primary `origin` re-check, and the broad `catch` also suppresses an allowlist rejection.
- The upstream Git LFS documentation states that a repository's `.lfsconfig` may set `lfs.url` or `remote.<name>.lfsurl`, independently of the clone URL: <https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-config.adoc>.

A repository whose ordinary Git origin is allowed can direct the Agent's LFS client to an arbitrary HTTP(S) endpoint. This bypasses the documented host policy and enables network probing/SSRF from the Agent network. Depending on credential-helper configuration, it may also trigger credential prompts or disclosure to a repository-selected endpoint.

Recommended remediation:

1. Before any LFS network operation, resolve the effective LFS endpoint using controlled Git/LFS configuration and apply the same scheme, host, and repository-prefix policy.
2. Override `lfs.url`/`remote.*.lfsurl` with a Controller-approved value, or reject repositories whose effective endpoint is not allowed.
3. Do not swallow `assertAllowedRepositoryUrl` failures. Catch only the expected "origin absent" condition and fail closed for policy violations.
4. Clear or explicitly set `GIT_ASKPASS`, `SSH_ASKPASS`, credential-helper, proxy, and LFS-related environment variables for source acquisition.
5. Add a test repository containing an allowed origin plus a disallowed `.lfsconfig` endpoint and verify that no network command is executed.

## Medium-severity findings

### SEC-006: Snapshot decompression and tar parsing have no expansion or aggregate extraction limits

Evidence:

- `packages/snapshot/src/archive.ts:115-121` performs synchronous whole-buffer zstd compression/decompression.
- `packages/snapshot/src/archive.ts:144-184` parses the entire decompressed tar without validating an aggregate uncompressed byte limit, entry count, declared-size bounds, header checksum, or duplicate normalized paths.
- `packages/snapshot/src/materialize.ts:154-170` reads the complete compressed archive and then fully decompresses it in memory before extraction.
- No snapshot file-count, per-file, aggregate-uncompressed-size, or compression-ratio limit is defined in `packages/snapshot/src`.

A highly compressible source tree can make a small transferred payload expand into a very large allocation, blocking the Node.js event loop and potentially terminating the Controller or Agent. The current archive generator reduces malformed-tar exposure in the normal path, but source bytes are still user/repository controlled, and the design explicitly requires archive-bomb protection.

Recommended remediation:

- Define protocol-level limits for compressed bytes, uncompressed bytes, file count, per-file bytes, path length, and compression ratio.
- Stream decompression and extraction while accounting bytes before allocation/write; abort and clean the temporary workspace when a cap is crossed.
- Validate tar checksums, supported entry types, declared sizes against remaining bytes, and duplicate normalized/case-folded paths before writing.
- Enforce the same limits during capture so the Controller cannot manufacture a payload that an Agent must reject.

### SEC-007: Windows executor handle inheritance can defeat process-tree cleanup and hang an Agent

Evidence:

- `native/windows-executor/src/execute.rs:136-147` creates both ends of stdout/stderr pipes as inheritable.
- `native/windows-executor/src/execute.rs:226-238` calls `CreateProcessW` with `bInheritHandles=true` and no restricted handle list.
- `native/windows-executor/src/execute.rs:281-284` starts readers for the parent-side pipe handles.
- `native/windows-executor/src/execute.rs:304-311` joins those readers before the Job Object is dropped/closed.
- `native/windows-executor/src/execute.rs:83-90` relies on closing the Job Object to enforce kill-on-close.

A job can spawn a descendant that inherits the output pipe handles and then let the primary process exit. The helper leaves the Job Object alive while waiting for pipe EOF, but EOF does not arrive while the descendant holds the inherited write handle. This circular ordering can hang the helper and retain the process tree beyond the intended job lifecycle.

Recommended remediation:

- Mark the parent read ends non-inheritable immediately after `CreatePipe`.
- Prefer `STARTUPINFOEXW` with `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` so only the intended stdout/stderr write handles are inherited.
- After the primary process exits, terminate/close the Job Object before unbounded reader joins, or use bounded joins plus forced cleanup.
- Add a Windows integration test whose primary process exits after spawning a long-lived descendant that retains stdout.

### SEC-008: Sensitive state directories and most state files rely on the process umask/default ACLs

Evidence:

- `apps/controller/src/config.ts:133-135` creates the Controller data directory without an explicit restrictive mode or post-creation permission check.
- `packages/shared/src/controller-identity.ts:31-39` creates the `security` directory without an explicit mode, although individual key files are correctly written with `0o600` at lines 56-67.
- `packages/executor/src/logs.ts:14-49`, `packages/snapshot/src/capture.ts:573-762`, and `apps/controller/src/execution/artifacts.ts:118-143` create logs, source snapshots, artifacts, and audit data using default permissions.
- `apps/agent/src/connection/client.ts:129-132` protects the Agent state file with `0o600`, but its parent directory still depends on inherited/default permissions.

On multi-user Unix hosts, a permissive umask or parent directory can expose source snapshots, build logs, artifacts, job scripts, metadata, and audit records to other local users. On Windows, POSIX mode bits do not establish the required ACL by themselves.

Recommended remediation:

- Create state/security/log/snapshot/artifact directories as owner-only (`0700`) and sensitive files as `0600`; verify and repair existing permissions at startup.
- On Windows, set and verify an ACL granting only the service identity and administrators the required access.
- Refuse to start, or emit a prominent operator error, if key/state directories are writable by unintended principals.
- Add platform-specific permission tests and document the required ownership/ACL model.

## Positive controls observed

- `apps/controller/src/http/server.ts:18-27` rejects non-loopback MCP bind hosts.
- `apps/agent/src/connection/client.ts:157-173` pins the Controller certificate before trusting the WebSocket session.
- `apps/controller/src/security/credentials.ts:61-88` verifies signed Agent credentials, audience, revocation, credential rotation, and device-key thumbprints.
- `apps/controller/src/http/data-plane.ts:128-178` fences data tokens to agent/job/attempt/lease/state, and artifact uploads enforce declared size/hash and path containment.
- `packages/shared/src/paths.ts:60-81` rejects absolute, traversal, UNC/drive, URL-like, empty, dot, and Windows-reserved path forms.
- `apps/agent/src/executor/redactor.ts:1-55` performs exact-value redaction across chunk boundaries for explicitly injected secrets.
- `pnpm audit --audit-level moderate` reported no known dependency vulnerabilities on 2026-07-21.

## Validation and limitations

This was a source-focused review, not a penetration test. I inspected the current working tree and its existing security tests, ran `pnpm audit --audit-level moderate`, and ran five targeted Vitest files covering credentials/pairing, data-plane authorization, snapshot materialization, crypto, and secret redaction (32 tests passed). I did not execute destructive proof-of-concept jobs, install services, mutate OS ACLs, or probe network services. The repository contained pre-existing uncommitted changes, which were treated as in-scope current code and were not modified.

The available security-review guidance covers general JavaScript/TypeScript web-server practices but has no exact profile for raw Node.js HTTP/WebSocket/MCP services or Rust Win32 helpers. Findings for those components were therefore evaluated against the repository's documented trust model and standard platform security properties. A dedicated fuzzing pass for protocol schemas, tar parsing, and WebSocket state transitions, plus Windows service/process integration testing, would provide additional assurance.

## Recommended remediation order

1. Fix SEC-001 before exposing or broadly distributing the Controller.
2. Fix SEC-002 and SEC-003 before recommending service installation on developer/build machines.
3. Fix SEC-004 and SEC-005 before treating trusted LAN/VPN and Git allowlists as meaningful containment boundaries.
4. Address SEC-006 through SEC-008 as hardening required by the design's mandatory controls.
