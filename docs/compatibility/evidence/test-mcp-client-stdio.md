# Evidence: test-mcp-client / stdio

- client: test-mcp-client (Vitest MCP SDK harness)
- transport: stdio
- workflow: submit → wait → logs → artifacts → materialize
- job_id: job_01KY213HMFE9WNCWCBCJ7S0AA3
- attempt_id: att_01KY213MCNZVPGM4VMPA06ZAM9
- artifact_ids: art_01KY213N86VXK7RS3HS38502NQ
- known limitation: not a Codex/Claude/Cursor/Antigravity UI client

## Raw call transcript (this run, redacted)

### 2026-07-21T09:46:28.109Z — job_submit

- request: `{"client_request_id":"phase8-smoke-1784627185280-4w8qht","name":"phase8-smoke","source":{"project_root":"[REDACTED_PATH]","cwd":".","additional_roots":[]},"execution":{"shell":"powershell","script":"Write-Output \"phase8-smoke\"; Set-Content -Path out.txt -Value \"phase8-artifact\"","env":{},"timeout_seconds":60,"cancel_grace_seconds":2,"cleanup_timeout_seconds":60,"tty":false,"completion":{"type":"run_to_exit"}},"queue_policy":"local_fallback","risk_level":"safe","artifacts":[{"glob":"out.txt",…`
- response: `{"job_id":"job_01KY213HMFE9WNCWCBCJ7S0AA3","state":"queued","snapshot_id":"snp_01KY213HR43RH2CBQD1THZFXGJ","content_id":"sha256:ed342a64a35001fcaa3a95def774d2b2e8a1b1ff63e25017c27d414701c64607","snapshot_captured":true,"selected_agent":null,"secret_warnings":[]}`

### 2026-07-21T09:46:29.204Z — job_wait

- request: `{"job_id":"job_01KY213HMFE9WNCWCBCJ7S0AA3","wait_seconds":60,"include_log_tail_lines":20}`
- response: `{"job":{"id":"job_01KY213HMFE9WNCWCBCJ7S0AA3","client_id":"phase8-stdio-smoke","client_request_id":"phase8-smoke-1784627185280-4w8qht","name":"phase8-smoke","state":"completed","outcome":"succeeded","created_at":"2026-07-21T09:46:28.105Z","updated_at":"2026-07-21T09:46:29.004Z","queued_at":"2026-07-21T09:46:28.106Z","started_at":"2026-07-21T09:46:28.155Z","finished_at":"2026-07-21T09:46:29.004Z","agent_id":null,"snapshot_id":"snp_01KY213HR43RH2CBQD1THZFXGJ","exit_code":0,"failure_category":null,…`

### 2026-07-21T09:46:29.217Z — job_logs

- request: `{"job_id":"job_01KY213HMFE9WNCWCBCJ7S0AA3","attempt_id":null,"cursor":0,"max_bytes":65536,"streams":["stdout","stderr","events"]}`
- response: `{"job_id":"job_01KY213HMFE9WNCWCBCJ7S0AA3","attempt_id":"att_01KY213MCNZVPGM4VMPA06ZAM9","events":[{"type":"snapshot_captured","sequence":1,"created_at":"2026-07-21T09:46:28.215Z","job_id":"job_01KY213HMFE9WNCWCBCJ7S0AA3","attempt_id":"att_01KY213MCNZVPGM4VMPA06ZAM9","snapshot_id":"snp_01KY213HR43RH2CBQD1THZFXGJ","content_id":"sha256:ed342a64a35001fcaa3a95def774d2b2e8a1b1ff63e25017c27d414701c64607"},{"type":"materialized","sequence":2,"created_at":"2026-07-21T09:46:28.227Z","job_id":"job_01KY213…`

### 2026-07-21T09:46:29.224Z — job_artifacts

- request: `{"job_id":"job_01KY213HMFE9WNCWCBCJ7S0AA3"}`
- response: `{"job_id":"job_01KY213HMFE9WNCWCBCJ7S0AA3","artifacts":[{"id":"art_01KY213N86VXK7RS3HS38502NQ","attempt_id":"att_01KY213MCNZVPGM4VMPA06ZAM9","logical_name":"out.txt","size_bytes":17,"sha256":"8256dd877d06464275842c7657de36a3179320907947c8c6d13e7a06609968d0"}],"attempts":["att_01KY213MCNZVPGM4VMPA06ZAM9"],"terminal_attempt_id":"att_01KY213MCNZVPGM4VMPA06ZAM9"}`

### 2026-07-21T09:46:29.333Z — artifact_materialize

- request: `{"artifact_id":"art_01KY213N86VXK7RS3HS38502NQ","destination_path":"[REDACTED_PATH]","overwrite":false}`
- response: `{"artifact_id":"art_01KY213N86VXK7RS3HS38502NQ","destination_path":"[REDACTED_PATH]","sha256":"8256dd877d06464275842c7657de36a3179320907947c8c6d13e7a06609968d0"}`
