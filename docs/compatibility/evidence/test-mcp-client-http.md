# Evidence: test-mcp-client / streamable_http

- client: test-mcp-client (Vitest MCP SDK harness)
- transport: streamable_http
- workflow: submit → wait → logs → artifacts → materialize
- job_id: job_01KY27BYXF8YYK058YSCQ5SQ9Z
- attempt_id: att_01KY27C2KDN9F9DWRP8KEVCP8V
- artifact_ids: art_01KY27C3HD62VTFXQD7JGV22T8
- known limitation: not a Codex/Claude/Cursor/Antigravity UI client

## Raw call transcript (this run, redacted)

### 2026-07-21T11:35:56.261Z — job_submit

- request: `{"client_request_id":"phase8-smoke-1784633752455-1x1y8t","name":"phase8-smoke","source":{"project_root":"[REDACTED_PATH]","cwd":".","additional_roots":[]},"execution":{"shell":"powershell","script":"Write-Output \"phase8-smoke\"; Set-Content -Path out.txt -Value \"phase8-artifact\"","env":{},"timeout_seconds":60,"cancel_grace_seconds":2,"cleanup_timeout_seconds":60,"tty":false,"completion":{"type":"run_to_exit"}},"queue_policy":"local_fallback","risk_level":"safe","artifacts":[{"glob":"out.txt",…`
- response: `{"job_id":"job_01KY27BYXF8YYK058YSCQ5SQ9Z","state":"queued","snapshot_id":"snp_01KY27BZ235A4Q8XHXKV66AGCP","content_id":"sha256:ed342a64a35001fcaa3a95def774d2b2e8a1b1ff63e25017c27d414701c64607","snapshot_captured":true,"selected_agent":null,"secret_warnings":[]}`

### 2026-07-21T11:35:57.326Z — job_wait

- request: `{"job_id":"job_01KY27BYXF8YYK058YSCQ5SQ9Z","wait_seconds":60,"include_log_tail_lines":20}`
- response: `{"job":{"id":"job_01KY27BYXF8YYK058YSCQ5SQ9Z","client_id":"phase8-http-smoke","client_request_id":"phase8-smoke-1784633752455-1x1y8t","name":"phase8-smoke","state":"completed","outcome":"succeeded","created_at":"2026-07-21T11:35:56.254Z","updated_at":"2026-07-21T11:35:57.282Z","queued_at":"2026-07-21T11:35:56.254Z","started_at":"2026-07-21T11:35:56.344Z","finished_at":"2026-07-21T11:35:57.282Z","agent_id":null,"snapshot_id":"snp_01KY27BZ235A4Q8XHXKV66AGCP","exit_code":0,"failure_category":null,"…`

### 2026-07-21T11:35:57.347Z — job_logs

- request: `{"job_id":"job_01KY27BYXF8YYK058YSCQ5SQ9Z","attempt_id":null,"cursor":0,"max_bytes":65536,"streams":["stdout","stderr","events"]}`
- response: `{"job_id":"job_01KY27BYXF8YYK058YSCQ5SQ9Z","attempt_id":"att_01KY27C2KDN9F9DWRP8KEVCP8V","events":[{"type":"snapshot_captured","sequence":1,"created_at":"2026-07-21T11:35:56.488Z","job_id":"job_01KY27BYXF8YYK058YSCQ5SQ9Z","attempt_id":"att_01KY27C2KDN9F9DWRP8KEVCP8V","snapshot_id":"snp_01KY27BZ235A4Q8XHXKV66AGCP","content_id":"sha256:ed342a64a35001fcaa3a95def774d2b2e8a1b1ff63e25017c27d414701c64607"},{"type":"materialized","sequence":2,"created_at":"2026-07-21T11:35:56.510Z","job_id":"job_01KY27B…`

### 2026-07-21T11:35:57.353Z — job_artifacts

- request: `{"job_id":"job_01KY27BYXF8YYK058YSCQ5SQ9Z"}`
- response: `{"job_id":"job_01KY27BYXF8YYK058YSCQ5SQ9Z","artifacts":[{"id":"art_01KY27C3HD62VTFXQD7JGV22T8","attempt_id":"att_01KY27C2KDN9F9DWRP8KEVCP8V","logical_name":"out.txt","size_bytes":17,"sha256":"8256dd877d06464275842c7657de36a3179320907947c8c6d13e7a06609968d0"}],"attempts":["att_01KY27C2KDN9F9DWRP8KEVCP8V"],"terminal_attempt_id":"att_01KY27C2KDN9F9DWRP8KEVCP8V"}`

### 2026-07-21T11:35:57.457Z — artifact_materialize

- request: `{"artifact_id":"art_01KY27C3HD62VTFXQD7JGV22T8","destination_path":"[REDACTED_PATH]","overwrite":false}`
- response: `{"artifact_id":"art_01KY27C3HD62VTFXQD7JGV22T8","destination_path":"[REDACTED_PATH]","sha256":"8256dd877d06464275842c7657de36a3179320907947c8c6d13e7a06609968d0"}`
