use rbo_windows_executor::{
    format_response, parse_request, ExecutionResponse, StartAuthorization, PROTOCOL_VERSION,
};

#[test]
fn test_parse_request_and_format_response() {
    let json_input = r#"{
        "protocol": 3,
        "attempt_id": "att_01J123",
        "command": "powershell.exe",
        "args": ["-Command", "Write-Output 'Hello'"],
        "cwd": "C:\\projects\\app",
        "env": {"FOO": "BAR"},
        "timeout_seconds": 60,
        "cancel_grace_seconds": 10,
        "start_authorization": {
            "kind": "lease",
            "qpc_issued_ms": 100,
            "qpc_deadline_ms": 200,
            "epoch_deadline_ms": 1000
        }
    }"#;

    let req = parse_request(json_input).expect("Failed to parse request");
    assert_eq!(req.protocol, PROTOCOL_VERSION);
    assert_eq!(req.attempt_id, "att_01J123");
    assert_eq!(req.command, "powershell.exe");
    assert_eq!(req.args, vec!["-Command", "Write-Output 'Hello'"]);
    assert_eq!(req.env.get("FOO"), Some(&"BAR".to_string()));
    assert_eq!(req.timeout_seconds, 60.0);
    assert_eq!(req.cancel_grace_seconds, 10.0);
    assert_eq!(
        req.start_authorization,
        StartAuthorization::Lease {
            qpc_issued_ms: 100,
            qpc_deadline_ms: 200,
            epoch_deadline_ms: 1000,
        }
    );

    let resp = ExecutionResponse {
        protocol: PROTOCOL_VERSION,
        attempt_id: req.attempt_id.clone(),
        exit_code: Some(0),
        success: true,
        timed_out: false,
        error_message: None,
    };

    let formatted = format_response(&resp).expect("Failed to format response");
    assert!(formatted.contains("att_01J123"));
    assert!(formatted.contains("\"success\":true"));
    assert!(formatted.contains("\"timed_out\":false"));
    assert!(formatted.contains("\"protocol\":3"));
    assert!(parse_request(&json_input.replace("\"protocol\": 3", "\"protocol\": 2")).is_err());
}

#[test]
fn parses_fractional_seconds_and_rejects_invalid_durations() {
    let request = r#"{
        "protocol": 3,
        "attempt_id": "att_fractional",
        "command": "cmd.exe",
        "args": [],
        "cwd": "C:\\projects\\app",
        "env": {},
        "timeout_seconds": 1.25,
        "cancel_grace_seconds": 0.125,
        "start_authorization": {"kind": "unleased"}
    }"#;

    let parsed = parse_request(request).expect("parse fractional seconds");
    assert_eq!(parsed.timeout_seconds, 1.25);
    assert_eq!(parsed.cancel_grace_seconds, 0.125);
    for invalid in ["0", "-0.5", "1e309"] {
        assert!(parse_request(&request.replace("1.25", invalid)).is_err());
        assert!(parse_request(&request.replace("0.125", invalid)).is_err());
    }
}

#[test]
fn test_parse_request_without_protocol_version_fails() {
    let json_input = r#"{
        "attempt_id": "att_01J123",
        "command": "cmd.exe",
        "args": [],
        "cwd": "C:\\projects\\app",
        "env": {},
        "timeout_seconds": 60,
        "cancel_grace_seconds": 10,
        "start_authorization": {"kind": "unleased"}
    }"#;

    assert!(parse_request(json_input).is_err());
}

#[test]
fn test_parse_request_with_unsupported_protocol_version_fails() {
    let json_input = r#"{
        "protocol": 99,
        "attempt_id": "att_01J123",
        "command": "cmd.exe",
        "args": [],
        "cwd": "C:\\projects\\app",
        "env": {},
        "timeout_seconds": 60,
        "cancel_grace_seconds": 10,
        "start_authorization": {"kind": "unleased"}
    }"#;

    assert!(parse_request(json_input).is_err());
}

#[test]
fn execution_requests_require_explicit_start_authorization() {
    let json_input = r#"{
        "protocol": 3,
        "attempt_id": "att_local",
        "command": "cmd.exe",
        "args": [],
        "cwd": "C:\\projects\\app",
        "env": {},
        "timeout_seconds": 60,
        "cancel_grace_seconds": 10
    }"#;

    assert!(parse_request(json_input).is_err());
}
