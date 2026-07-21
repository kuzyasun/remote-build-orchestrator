# Evidence: test-mcp-client / streamable_http

- client: test-mcp-client (Vitest MCP SDK harness)
- transport: streamable_http
- workflow: submit → wait → logs → artifacts → materialize
- job_id: job_01KY1YDJ76HEYJP6J9DM8DJBP7
- attempt_id: att_01KY1YDMV2B2CAKYQ9RHFWSVHM
- artifact_ids: art_01KY1YDNHDAYACA099APDAS275
- known limitation: not a Fusion/Codex/Claude/Cursor/Antigravity UI client

## Raw call transcript (this run, redacted)

### 2026-07-21T08:59:30.521Z — job_submit

- request: `{"client_request_id":"phase8-smoke-1784624367804-mce8qb","name":"phase8-smoke","source":{"project_root":"[REDACTED_PATH]","cwd":".","additional_roots":[]},"execution":{"shell":"powershell","script":"Write-Output \"phase8-smoke\"; Set-Content -Path out.txt -Value \"phase8-artifact\"","env":{},"timeout_seconds":60,"cancel_grace_seconds":2,"cleanup_timeout_seconds":60,"tty":false,"completion":{"type":"run_to_exit"}},"queue_policy":"local_fallback","risk_level":"safe","artifacts":[{"glob":"out.txt",…`
- response: `{"job_id":"job_01KY1YDJ76HEYJP6J9DM8DJBP7","state":"queued","snapshot_id":"snp_01KY1YDJB46X03DHHH4TG8P39H","content_id":"sha256:ed342a64a35001fcaa3a95def774d2b2e8a1b1ff63e25017c27d414701c64607","snapshot_captured":true,"selected_agent":null,"secret_warnings":[]}`

### 2026-07-21T08:59:31.398Z — job_wait

- request: `{"job_id":"job_01KY1YDJ76HEYJP6J9DM8DJBP7","wait_seconds":60,"include_log_tail_lines":20}`
- response: `{"job":{"id":"job_01KY1YDJ76HEYJP6J9DM8DJBP7","client_id":"phase8-http-smoke","client_request_id":"phase8-smoke-1784624367804-mce8qb","name":"phase8-smoke","state":"completed","outcome":"succeeded","created_at":"2026-07-21T08:59:30.512Z","updated_at":"2026-07-21T08:59:31.278Z","queued_at":"2026-07-21T08:59:30.513Z","started_at":"2026-07-21T08:59:30.561Z","finished_at":"2026-07-21T08:59:31.278Z","agent_id":null,"snapshot_id":"snp_01KY1YDJB46X03DHHH4TG8P39H","exit_code":0,"failure_category":null,"…`

### 2026-07-21T08:59:31.414Z — job_logs

- request: `{"job_id":"job_01KY1YDJ76HEYJP6J9DM8DJBP7","attempt_id":null,"cursor":0,"max_bytes":65536,"streams":["stdout","stderr","events"]}`
- response: `{"job_id":"job_01KY1YDJ76HEYJP6J9DM8DJBP7","attempt_id":"att_01KY1YDMV2B2CAKYQ9RHFWSVHM","events":[{"type":"snapshot_captured","sequence":1,"created_at":"2026-07-21T08:59:30.634Z","job_id":"job_01KY1YDJ76HEYJP6J9DM8DJBP7","attempt_id":"att_01KY1YDMV2B2CAKYQ9RHFWSVHM","snapshot_id":"snp_01KY1YDJB46X03DHHH4TG8P39H","content_id":"sha256:ed342a64a35001fcaa3a95def774d2b2e8a1b1ff63e25017c27d414701c64607"},{"type":"materialized","sequence":2,"created_at":"2026-07-21T08:59:30.648Z","job_id":"job_01KY1YD…`

### 2026-07-21T08:59:31.429Z — job_artifacts

- request: `{"job_id":"job_01KY1YDJ76HEYJP6J9DM8DJBP7"}`
- response: `{"job_id":"job_01KY1YDJ76HEYJP6J9DM8DJBP7","artifacts":[{"id":"art_01KY1YDNHDAYACA099APDAS275","attempt_id":"att_01KY1YDMV2B2CAKYQ9RHFWSVHM","logical_name":"out.txt","size_bytes":17,"sha256":"8256dd877d06464275842c7657de36a3179320907947c8c6d13e7a06609968d0"}],"attempts":["att_01KY1YDMV2B2CAKYQ9RHFWSVHM"],"terminal_attempt_id":"att_01KY1YDMV2B2CAKYQ9RHFWSVHM"}`

### 2026-07-21T08:59:31.464Z — artifact_materialize

- request: `{"artifact_id":"art_01KY1YDNHDAYACA099APDAS275","destination_path":"[REDACTED_PATH]","overwrite":false}`
- response: `{"artifact_id":"art_01KY1YDNHDAYACA099APDAS275","destination_path":"[REDACTED_PATH]","sha256":"8256dd877d06464275842c7657de36a3179320907947c8c6d13e7a06609968d0"}`
