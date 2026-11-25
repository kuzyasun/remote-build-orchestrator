#![cfg(windows)]

use std::collections::HashMap;
use std::fs;
use std::io::{self, Read, Write};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rbo_windows_executor::{
    execute_request, ExecutionRequest, ExecutionResponse, StartAuthorization, PROTOCOL_VERSION,
};
use windows::Win32::Foundation::{HANDLE, WAIT_EVENT, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
use windows::Win32::System::Threading::{
    OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
};

#[test]
#[ignore = "subprocess fixture for the output drain test"]
fn background_output_fixture() {
    const WORKER: &str = "RBO_TEST_OUTPUT_DRAIN_WORKER";
    if std::env::var_os(WORKER).is_some() {
        thread::sleep(Duration::from_secs(6));
        return;
    }

    // The Job Object owns this background worker after the root finishes.
    let _worker = Command::new(std::env::current_exe().expect("locate fixture executable"))
        .args([
            "--ignored",
            "--exact",
            "background_output_fixture",
            "--nocapture",
        ])
        .env(WORKER, "1")
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("start background output fixture");
}

#[test]
fn root_exit_preserves_success_with_background_output() {
    let request = ExecutionRequest {
        protocol: PROTOCOL_VERSION,
        attempt_id: "att_output_drain".to_string(),
        command: std::env::current_exe()
            .expect("locate fixture executable")
            .to_string_lossy()
            .into_owned(),
        args: [
            "--ignored",
            "--exact",
            "background_output_fixture",
            "--nocapture",
        ]
        .map(str::to_string)
        .into(),
        cwd: std::env::current_dir()
            .expect("get test working directory")
            .to_string_lossy()
            .into_owned(),
        env: HashMap::new(),
        timeout_seconds: 15.0,
        cancel_grace_seconds: 0.25,
        start_authorization: StartAuthorization::Unleased,
    };
    let started = Instant::now();
    let response = execute_request(
        request,
        Arc::new(AtomicBool::new(false)),
        || Ok(|| Ok(())),
        || Ok(()),
    );

    assert_eq!(response.exit_code, Some(0));
    assert!(response.success, "{response:?}");
    assert!(!response.timed_out);
    assert!(started.elapsed() < Duration::from_secs(4));
}

const CANCEL_FIXTURE_ROLE: &str = "RBO_TEST_CANCEL_FIXTURE_ROLE";
const CANCEL_FIXTURE_ARGS: [&str; 4] =
    ["--ignored", "--exact", "job_cancel_fixture", "--nocapture"];

#[test]
#[ignore = "subprocess fixture for the Job Object cancellation test"]
fn job_cancel_fixture() {
    let Ok(role) = std::env::var(CANCEL_FIXTURE_ROLE) else {
        return;
    };
    let next_role = match role.as_str() {
        "root" => Some("child"),
        "child" => Some("grandchild"),
        "grandchild" => None,
        _ => panic!("unknown cancellation fixture role {role}"),
    };
    if let Some(next_role) = next_role {
        Command::new(std::env::current_exe().expect("locate fixture executable"))
            .args(CANCEL_FIXTURE_ARGS)
            .env(CANCEL_FIXTURE_ROLE, next_role)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("start descendant fixture");
    }
    let pending = format!("{role}.tmp");
    fs::write(&pending, std::process::id().to_string()).expect("write fixture PID");
    fs::rename(pending, format!("{role}.pid")).expect("announce fixture ready");

    // Bound the lifetime of a fixture even when the parent test cannot open its handle.
    thread::sleep(Duration::from_secs(45));
    panic!("cancellation fixture {role} survived");
}

struct FixtureDirectory(PathBuf);

impl FixtureDirectory {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "rbo-job-object-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("read fixture creation time")
                .as_nanos()
        ));
        fs::create_dir(&dir).expect("create unique temp dir");
        Self(dir)
    }

    fn request(&self) -> ExecutionRequest {
        ExecutionRequest {
            protocol: PROTOCOL_VERSION,
            attempt_id: "att_test".to_string(),
            command: std::env::current_exe()
                .expect("locate fixture executable")
                .to_string_lossy()
                .into_owned(),
            args: CANCEL_FIXTURE_ARGS.map(str::to_string).into(),
            cwd: self.0.to_string_lossy().into_owned(),
            env: HashMap::from([(CANCEL_FIXTURE_ROLE.into(), "root".into())]),
            timeout_seconds: 30.0,
            cancel_grace_seconds: 0.25,
            start_authorization: StartAuthorization::Unleased,
        }
    }
}

impl Drop for FixtureDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct FixtureProcess {
    pid: u32,
    handle: OwnedHandle,
}

impl FixtureProcess {
    fn await_ready(work_dir: &Path, role: &str, deadline: Instant) -> io::Result<Self> {
        let pid_file = work_dir.join(format!("{role}.pid"));
        let pid = loop {
            match fs::read_to_string(&pid_file) {
                Ok(contents) => break contents.parse::<u32>().map_err(io::Error::other)?,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    if Instant::now() >= deadline {
                        return Err(io::Error::other(format!("fixture {role} was not ready")));
                    }
                    thread::sleep(Duration::from_millis(20));
                }
                Err(error) => return Err(error),
            }
        };
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_TERMINATE, false, pid) }
            .map_err(io::Error::other)?;
        let process = Self {
            pid,
            handle: unsafe { OwnedHandle::from_raw_handle(handle.0) },
        };
        if process.wait(0) != WAIT_TIMEOUT {
            return Err(io::Error::other(format!(
                "fixture {role} ({pid}) was not alive before cancellation"
            )));
        }
        Ok(process)
    }

    fn wait(&self, milliseconds: u32) -> WAIT_EVENT {
        unsafe { WaitForSingleObject(HANDLE(self.handle.as_raw_handle()), milliseconds) }
    }
}

impl Drop for FixtureProcess {
    fn drop(&mut self) {
        if self.wait(0) == WAIT_TIMEOUT {
            let _ = unsafe { TerminateProcess(HANDLE(self.handle.as_raw_handle()), 1) };
            let _ = self.wait(1000);
        }
    }
}

#[test]
fn child_and_grandchild_are_killed_on_job_cancel() {
    let work_dir = FixtureDirectory::new();
    let request = work_dir.request();

    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_for_job = cancel.clone();
    let execution = thread::spawn(move || {
        execute_request(request, cancel_for_job, || Ok(|| Ok(())), || Ok(()))
    });
    let readiness_deadline = Instant::now() + Duration::from_secs(10);
    let processes = ["root", "child", "grandchild"]
        .map(|role| FixtureProcess::await_ready(&work_dir.0, role, readiness_deadline));
    cancel.store(true, Ordering::SeqCst);
    let response = execution.join().expect("join Job Object execution");
    assert!(!response.success && !response.timed_out, "{response:?}");

    assert_processes_stop(processes);
}

fn assert_processes_stop(processes: [io::Result<FixtureProcess>; 3]) {
    // Windows can finish terminating each process asynchronously after cancelling its job.
    let exit_deadline = Instant::now() + Duration::from_secs(5);
    for (role, process) in ["root", "child", "grandchild"].into_iter().zip(processes) {
        let process = process.unwrap_or_else(|error| panic!("could not observe {role}: {error}"));
        let remaining = exit_deadline.saturating_duration_since(Instant::now());
        assert_eq!(
            process.wait(remaining.as_millis() as u32),
            WAIT_OBJECT_0,
            "{role} process {} did not signal termination after cancel",
            process.pid
        );
    }
}

struct HelperProcess(Child);

impl HelperProcess {
    fn start() -> Self {
        Self(
            Command::new(env!("CARGO_BIN_EXE_rbo-windows-executor"))
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .expect("start helper"),
        )
    }

    fn send(&mut self, request: &ExecutionRequest, suffix: &str) {
        let json = serde_json::to_string(request).expect("serialize job request");
        self.0
            .stdin
            .as_mut()
            .unwrap()
            .write_all(format!("{json}\n{suffix}").as_bytes())
            .expect("send job request");
    }

    fn await_exit(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = self.0.try_wait().expect("check helper exit status") {
                assert!(status.success(), "helper exited with {status}");
                break;
            }
            assert!(Instant::now() < deadline, "helper did not exit");
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn response(&mut self) -> (bool, ExecutionResponse) {
        self.await_exit();
        let mut data = Vec::new();
        self.0
            .stdout
            .take()
            .unwrap()
            .read_to_end(&mut data)
            .unwrap();
        let mut frames = data.as_slice();
        let mut started = false;
        while frames.len() >= 5 {
            let length = u32::from_le_bytes(frames[1..5].try_into().unwrap()) as usize;
            let payload = &frames[5..5 + length];
            if frames[0] == 3 {
                return (
                    started,
                    serde_json::from_slice(payload).expect("parse final response"),
                );
            }
            if frames[0] == 4 {
                assert!(payload.is_empty());
                assert!(!started, "helper confirmed startup twice");
                started = true;
            }
            frames = &frames[5 + length..];
        }
        panic!("missing helper response");
    }
}

impl Drop for HelperProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn closing_stdin_before_a_request_exits_the_helper() {
    let mut helper = HelperProcess::start();
    drop(helper.0.stdin.take());
    helper.await_exit();
}

#[test]
fn closing_stdin_cancels_the_helper_owned_process_tree() {
    let work_dir = FixtureDirectory::new();
    let mut helper = HelperProcess::start();
    helper.send(&work_dir.request(), "");
    let readiness_deadline = Instant::now() + Duration::from_secs(10);
    let processes = ["root", "child", "grandchild"]
        .map(|role| FixtureProcess::await_ready(&work_dir.0, role, readiness_deadline));

    drop(helper.0.stdin.take());
    assert_processes_stop(processes);
    let (started, response) = helper.response();
    assert!(started, "helper did not confirm fixture startup");
    assert!(!response.success && !response.timed_out, "{response:?}");
}

#[test]
fn queued_cancellation_prevents_the_child_from_starting() {
    let work_dir = FixtureDirectory::new();
    let mut helper = HelperProcess::start();
    helper.send(&work_dir.request(), "CANCEL\n");

    let (started, response) = helper.response();
    assert!(!started, "helper confirmed a cancelled start");
    assert_eq!(
        response.error_message.as_deref(),
        Some("Job start cancelled")
    );
    assert!(!work_dir.0.join("root.pid").exists());
}

#[test]
fn expired_authorization_prevents_a_delayed_helper_from_starting() {
    let work_dir = FixtureDirectory::new();
    let mut request = work_dir.request();
    request.start_authorization = StartAuthorization::Lease {
        qpc_issued_ms: 0,
        qpc_deadline_ms: 0,
        epoch_deadline_ms: u64::MAX,
    };
    let mut helper = HelperProcess::start();
    helper.send(&request, "");

    let (started, response) = helper.response();
    assert!(!started, "helper confirmed an expired start");
    assert_eq!(
        response.error_message.as_deref(),
        Some("Job start authorization expired")
    );
    assert!(!work_dir.0.join("root.pid").exists());
}

#[test]
fn lease_expiry_while_the_child_is_suspended_prevents_start() {
    let work_dir = FixtureDirectory::new();
    let mut request = work_dir.request();
    let mut counter = 0;
    let mut frequency = 0;
    unsafe {
        QueryPerformanceFrequency(&mut frequency).unwrap();
        QueryPerformanceCounter(&mut counter).unwrap();
    }
    let issued_ms = (counter as u128 * 1_000 / frequency as u128) as u64;
    request.start_authorization = StartAuthorization::Lease {
        qpc_issued_ms: issued_ms,
        qpc_deadline_ms: issued_ms + 1_000,
        epoch_deadline_ms: u64::MAX,
    };

    let mut suspended = false;
    let response = execute_request(
        request,
        Arc::new(AtomicBool::new(false)),
        || {
            suspended = true;
            thread::sleep(Duration::from_secs(1));
            Ok(|| panic!("probed after the launch lease expired"))
        },
        || panic!("reported an expired start"),
    );
    assert!(
        suspended,
        "expected the Job Object to own a suspended child"
    );
    assert_eq!(
        response.error_message.as_deref(),
        Some("Job start authorization expired")
    );
    assert!(!work_dir.0.join("root.pid").exists());
}

#[test]
fn the_final_control_probe_can_still_deny_a_suspended_start() {
    let work_dir = FixtureDirectory::new();
    let response = execute_request(
        work_dir.request(),
        Arc::new(AtomicBool::new(false)),
        || Ok(|| Err("Control pipe closed".into())),
        || panic!("reported a start after control-pipe denial"),
    );
    assert_eq!(
        response.error_message.as_deref(),
        Some("Control pipe closed")
    );
    assert!(!work_dir.0.join("root.pid").exists());
}
