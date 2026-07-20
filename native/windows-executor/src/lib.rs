use serde::{Deserialize, Serialize};

/// Versioned JSON protocol between the Node.js Agent and this helper (§15.2).
pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecutionRequest {
    pub protocol: u32,
    pub attempt_id: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: std::collections::HashMap<String, String>,
    pub timeout_seconds: u64,
    pub cancel_grace_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecutionResponse {
    pub protocol: u32,
    pub attempt_id: String,
    /// None when the process was terminated before producing an exit code.
    pub exit_code: Option<i32>,
    pub success: bool,
    pub timed_out: bool,
    pub error_message: Option<String>,
}

pub fn parse_request(json_str: &str) -> Result<ExecutionRequest, serde_json::Error> {
    let request: ExecutionRequest = serde_json::from_str(json_str)?;
    if request.protocol != PROTOCOL_VERSION {
        return Err(serde::de::Error::custom(format!(
            "unsupported protocol version {} (supported: {})",
            request.protocol, PROTOCOL_VERSION
        )));
    }
    Ok(request)
}

pub fn format_response(response: &ExecutionResponse) -> Result<String, serde_json::Error> {
    serde_json::to_string(response)
}
