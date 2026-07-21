# Evidence: test-mcp-client / stdio

- client: test-mcp-client (Vitest MCP SDK harness)
- transport: stdio
- workflow: submit → wait → logs → artifacts → materialize
- job_id: job_01KY1YDNTTYCGGGFE2NNPA3DCQ
- attempt_id: att_01KY1YDRF2Y3MNYQZQ8258ZPWS
- artifact_ids: art_01KY1YDSBZE7KGYB9AA5Y6WD5F
- known limitation: not a Fusion/Codex/Claude/Cursor/Antigravity UI client

## Raw call transcript (this run, redacted)

### 2026-07-21T08:59:34.226Z — job_submit

- request: `{"client_request_id":"phase8-smoke-1784624371542-tbkmq9","name":"phase8-smoke","source":{"project_root":"[REDACTED_PATH]","cwd":".","additional_roots":[]},"execution":{"shell":"powershell","script":"Write-Output \"phase8-smoke\"; Set-Content -Path out.txt -Value \"phase8-artifact\"","env":{},"timeout_seconds":60,"cancel_grace_seconds":2,"cleanup_timeout_seconds":60,"tty":false,"completion":{"type":"run_to_exit"}},"queue_policy":"local_fallback","risk_level":"safe","artifacts":[{"glob":"out.txt",…`
- response: `{"job_id":"job_01KY1YDNTTYCGGGFE2NNPA3DCQ","state":"queued","snapshot_id":"snp_01KY1YDNXF118J28XHSYNZ3CPV","content_id":"sha256:ed342a64a35001fcaa3a95def774d2b2e8a1b1ff63e25017c27d414701c64607","snapshot_captured":true,"selected_agent":null,"secret_warnings":[]}`

### 2026-07-21T08:59:35.305Z — job_wait

- request: `{"job_id":"job_01KY1YDNTTYCGGGFE2NNPA3DCQ","wait_seconds":60,"include_log_tail_lines":20}`
- response: `{"job":{"id":"job_01KY1YDNTTYCGGGFE2NNPA3DCQ","client_id":"phase8-stdio-smoke","client_request_id":"phase8-smoke-1784624371542-tbkmq9","name":"phase8-smoke","state":"completed","outcome":"succeeded","created_at":"2026-07-21T08:59:34.218Z","updated_at":"2026-07-21T08:59:35.172Z","queued_at":"2026-07-21T08:59:34.218Z","started_at":"2026-07-21T08:59:34.310Z","finished_at":"2026-07-21T08:59:35.172Z","agent_id":null,"snapshot_id":"snp_01KY1YDNXF118J28XHSYNZ3CPV","exit_code":0,"failure_category":null,…`

### 2026-07-21T08:59:35.322Z — job_logs

- request: `{"job_id":"job_01KY1YDNTTYCGGGFE2NNPA3DCQ","attempt_id":null,"cursor":0,"max_bytes":65536,"streams":["stdout","stderr","events"]}`
- response: `{"job_id":"job_01KY1YDNTTYCGGGFE2NNPA3DCQ","attempt_id":"att_01KY1YDRF2Y3MNYQZQ8258ZPWS","events":[{"type":"snapshot_captured","sequence":1,"created_at":"2026-07-21T08:59:34.370Z","job_id":"job_01KY1YDNTTYCGGGFE2NNPA3DCQ","attempt_id":"att_01KY1YDRF2Y3MNYQZQ8258ZPWS","snapshot_id":"snp_01KY1YDNXF118J28XHSYNZ3CPV","content_id":"sha256:ed342a64a35001fcaa3a95def774d2b2e8a1b1ff63e25017c27d414701c64607"},{"type":"materialized","sequence":2,"created_at":"2026-07-21T08:59:34.414Z","job_id":"job_01KY1YD…`

### 2026-07-21T08:59:35.329Z — job_artifacts

- request: `{"job_id":"job_01KY1YDNTTYCGGGFE2NNPA3DCQ"}`
- response: `{"job_id":"job_01KY1YDNTTYCGGGFE2NNPA3DCQ","artifacts":[{"id":"art_01KY1YDSBZE7KGYB9AA5Y6WD5F","attempt_id":"att_01KY1YDRF2Y3MNYQZQ8258ZPWS","logical_name":"out.txt","size_bytes":17,"sha256":"8256dd877d06464275842c7657de36a3179320907947c8c6d13e7a06609968d0"}],"attempts":["att_01KY1YDRF2Y3MNYQZQ8258ZPWS"],"terminal_attempt_id":"att_01KY1YDRF2Y3MNYQZQ8258ZPWS"}`

### 2026-07-21T08:59:35.363Z — artifact_materialize

- request: `{"artifact_id":"art_01KY1YDSBZE7KGYB9AA5Y6WD5F","destination_path":"[REDACTED_PATH]","overwrite":false}`
- response: `{"artifact_id":"art_01KY1YDSBZE7KGYB9AA5Y6WD5F","destination_path":"[REDACTED_PATH]","sha256":"8256dd877d06464275842c7657de36a3179320907947c8c6d13e7a06609968d0"}`
