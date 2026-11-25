#[cfg(windows)]
pub mod execute;

use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Versioned JSON protocol between the Node.js Agent and this helper (§15.2).
pub const PROTOCOL_VERSION: u32 = 3;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StartAuthorization {
    Unleased,
    Lease {
        qpc_issued_ms: u64,
        qpc_deadline_ms: u64,
        epoch_deadline_ms: u64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecutionRequest {
    pub protocol: u32,
    pub attempt_id: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: std::collections::HashMap<String, String>,
    pub timeout_seconds: f64,
    pub cancel_grace_seconds: f64,
    pub start_authorization: StartAuthorization,
}

impl ExecutionRequest {
    pub(crate) fn durations(&self) -> Result<(Duration, Duration), &'static str> {
        fn positive_duration(seconds: f64) -> Option<Duration> {
            if !seconds.is_finite() || seconds <= 0.0 {
                return None;
            }
            Duration::try_from_secs_f64(seconds)
                .ok()
                .map(|duration| duration.max(Duration::from_nanos(1)))
        }

        Ok((
            positive_duration(self.timeout_seconds)
                .ok_or("timeout_seconds must be a finite, positive duration")?,
            positive_duration(self.cancel_grace_seconds)
                .ok_or("cancel_grace_seconds must be a finite, positive duration")?,
        ))
    }
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
    request.durations().map_err(serde::de::Error::custom)?;
    Ok(request)
}

pub fn format_response(response: &ExecutionResponse) -> Result<String, serde_json::Error> {
    serde_json::to_string(response)
}

#[cfg(windows)]
pub use execute::{execute_request, process_exists, write_control_frame, write_started_frame};
