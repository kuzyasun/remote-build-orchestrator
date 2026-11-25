use std::collections::HashMap;
use std::ffi::c_void;
use std::io::{self, Read, Write};
use std::mem::{size_of, size_of_val};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{
    CloseHandle, SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows::Win32::Security::SECURITY_ATTRIBUTES;
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_READ, FILE_SHARE_READ, FILE_SHARE_WRITE,
    OPEN_EXISTING,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::JobObjects::{
    CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
    TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
use windows::Win32::System::Pipes::CreatePipe;
use windows::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
    InitializeProcThreadAttributeList, ResumeThread, UpdateProcThreadAttribute,
    WaitForSingleObject, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
    EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION,
    PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_JOB_LIST, STARTF_USESTDHANDLES,
    STARTUPINFOEXW,
};

use crate::{ExecutionRequest, ExecutionResponse, StartAuthorization, PROTOCOL_VERSION};

fn to_wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn build_command_line(command: &str, args: &[String]) -> Vec<u16> {
    let mut line = String::new();
    line.push('"');
    line.push_str(command);
    line.push('"');
    for arg in args {
        line.push(' ');
        if arg.contains(' ') || arg.contains('"') {
            line.push('"');
            for ch in arg.chars() {
                if ch == '"' {
                    line.push('\\');
                }
                line.push(ch);
            }
            line.push('"');
        } else {
            line.push_str(arg);
        }
    }
    to_wide(&line)
}

fn build_env_block(env: &HashMap<String, String>) -> Vec<u16> {
    let mut block = Vec::new();
    for (key, value) in env {
        let entry = format!("{key}={value}");
        block.extend(entry.encode_utf16());
        block.push(0);
    }
    block.push(0);
    block
}

const TAG_STDOUT: u8 = 0x01;
const TAG_STDERR: u8 = 0x02;
pub const TAG_CONTROL: u8 = 0x03;
const TAG_STARTED: u8 = 0x04;

fn write_frame(tag: u8, data: &[u8], drain_stopped: Option<&AtomicBool>) -> io::Result<()> {
    let mut stdout = io::stdout().lock();
    if drain_stopped.is_some_and(|stopped| stopped.load(Ordering::SeqCst)) {
        return Ok(());
    }
    let len = data.len() as u32;
    stdout.write_all(&[tag])?;
    stdout.write_all(&len.to_le_bytes())?;
    stdout.write_all(data)?;
    stdout.flush()
}

pub fn write_control_frame(json: &[u8]) {
    let _ = write_frame(TAG_CONTROL, json, None);
}

pub fn write_started_frame() -> io::Result<()> {
    write_frame(TAG_STARTED, &[], None)
}

struct JobHandle(HANDLE);

impl Drop for JobHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

fn create_kill_on_close_job() -> windows::core::Result<JobHandle> {
    unsafe {
        let job = JobHandle(CreateJobObjectW(None, PCWSTR::null())?);
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )?;
        Ok(job)
    }
}

struct ProcessAttributes {
    pointer: LPPROC_THREAD_ATTRIBUTE_LIST,
    _storage: Vec<usize>,
}

impl ProcessAttributes {
    fn new(count: u32) -> windows::core::Result<Self> {
        let mut bytes = 0;
        // A null list returns ERROR_INSUFFICIENT_BUFFER and the required size.
        let _ =
            unsafe { InitializeProcThreadAttributeList(Default::default(), count, 0, &mut bytes) };
        if bytes == 0 {
            return Err(windows::core::Error::from_win32());
        }
        // Word-aligned storage remains at a stable address for the list's lifetime.
        let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())];
        let pointer = LPPROC_THREAD_ATTRIBUTE_LIST(storage.as_mut_ptr().cast());
        unsafe {
            InitializeProcThreadAttributeList(pointer, count, 0, &mut bytes)?;
        }
        Ok(Self {
            pointer,
            _storage: storage,
        })
    }
}

impl Drop for ProcessAttributes {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.pointer);
        }
    }
}

fn create_suspended_child(
    command_line: &mut [u16],
    cwd: &[u16],
    env_block: &[u16],
    job: &JobHandle,
    handles: [HANDLE; 3],
) -> windows::core::Result<PROCESS_INFORMATION> {
    // Keep the values in scope until after DeleteProcThreadAttributeList.
    let jobs = [job.0];
    let attributes = ProcessAttributes::new(2)?;
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    [
        startup.StartupInfo.hStdInput,
        startup.StartupInfo.hStdOutput,
        startup.StartupInfo.hStdError,
    ] = handles;
    startup.lpAttributeList = attributes.pointer;
    let mut process = PROCESS_INFORMATION::default();
    unsafe {
        UpdateProcThreadAttribute(
            attributes.pointer,
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            Some(handles.as_ptr().cast()),
            size_of_val(&handles),
            None,
            None,
        )?;
        // The process belongs to the kill-on-close job as soon as Windows creates it.
        UpdateProcThreadAttribute(
            attributes.pointer,
            0,
            PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
            Some(jobs.as_ptr().cast()),
            size_of_val(&jobs),
            None,
            None,
        )?;
        CreateProcessW(
            PCWSTR::null(),
            windows::core::PWSTR(command_line.as_mut_ptr()),
            None,
            None,
            true,
            CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
            Some(env_block.as_ptr().cast()),
            PCWSTR(cwd.as_ptr()),
            &startup.StartupInfo,
            &mut process,
        )?;
    }
    Ok(process)
}

pub fn process_exists(pid: u32) -> bool {
    unsafe {
        let snapshot = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            Ok(handle) => handle,
            Err(_) => return false,
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snapshot, &mut entry).is_err() {
            let _ = CloseHandle(snapshot);
            return false;
        }
        loop {
            if entry.th32ProcessID == pid {
                let _ = CloseHandle(snapshot);
                return true;
            }
            if Process32NextW(snapshot, &mut entry).is_err() {
                break;
            }
        }
        let _ = CloseHandle(snapshot);
        false
    }
}

/// Create a stdout/stderr pipe. The child inherits only the write end; the parent
/// keeps a non-inheritable read end. Leaving both ends inheritable breaks `cmd.exe`
/// `FOR /F` (used by tools like `flutter.bat`) because nested processes inherit the
/// read end and corrupt redirected console I/O.
fn create_output_pipe() -> windows::core::Result<(HANDLE, HANDLE)> {
    unsafe {
        let mut read = HANDLE::default();
        let mut write = HANDLE::default();
        let mut sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: std::ptr::null_mut(),
            bInheritHandle: true.into(),
        };
        CreatePipe(&mut read, &mut write, Some(&mut sa), 0)?;
        if let Err(error) = SetHandleInformation(read, HANDLE_FLAG_INHERIT.0, Default::default()) {
            let _ = CloseHandle(read);
            let _ = CloseHandle(write);
            return Err(error);
        }
        Ok((read, write))
    }
}

fn open_nul_stdin() -> windows::core::Result<HANDLE> {
    unsafe {
        let sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: std::ptr::null_mut(),
            bInheritHandle: true.into(),
        };
        CreateFileW(
            w!("NUL"),
            FILE_GENERIC_READ.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            Some(&sa),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            None,
        )
    }
}

fn stream_pipe(handle: isize, tag: u8, drain_stopped: Arc<AtomicBool>) {
    let mut file = unsafe { std::fs::File::from_raw_handle(handle as _) };
    let mut buffer = [0u8; 4096];
    while !drain_stopped.load(Ordering::SeqCst) {
        match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                if write_frame(tag, &buffer[..count], Some(&drain_stopped)).is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
}

use std::os::windows::io::FromRawHandle;

fn ensure_start_authorized(
    authorization: &StartAuthorization,
    cancel: &AtomicBool,
) -> Result<(), String> {
    if cancel.load(Ordering::SeqCst) {
        return Err("Job start cancelled".into());
    }
    if let StartAuthorization::Lease {
        qpc_issued_ms,
        qpc_deadline_ms,
        epoch_deadline_ms,
    } = *authorization
    {
        let mut counter = 0;
        let mut frequency = 0;
        unsafe {
            QueryPerformanceFrequency(&mut frequency)
                .and_then(|_| QueryPerformanceCounter(&mut counter))
                .map_err(|error| format!("Could not read Windows executor lease clock: {error}"))?;
        }
        if counter < 0 || frequency <= 0 {
            return Err("Invalid Windows executor lease clock".into());
        }
        // Node's Windows hrtime uses QPC scaled to nanoseconds. Round the
        // native clock up to whole milliseconds and the issued deadline down.
        let qpc_now_ms = (counter as u128 * 1_000).div_ceil(frequency as u128);
        let epoch_now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| format!("Invalid Windows executor wall clock: {error}"))?
            .as_millis();
        if qpc_now_ms < u128::from(qpc_issued_ms) {
            return Err("Windows executor lease clock does not match the Agent clock".into());
        }
        if qpc_now_ms >= u128::from(qpc_deadline_ms)
            || epoch_now_ms >= u128::from(epoch_deadline_ms)
        {
            return Err("Job start authorization expired".into());
        }
    }
    Ok(())
}

pub fn execute_request<Probe>(
    request: ExecutionRequest,
    cancel: Arc<AtomicBool>,
    prepare_control_pipe: impl FnOnce() -> Result<Probe, String>,
    on_started: impl FnOnce() -> io::Result<()>,
) -> ExecutionResponse
where
    Probe: FnOnce() -> Result<(), String>,
{
    let (timeout, grace) = match request.durations() {
        Ok(durations) => durations,
        Err(error) => {
            return ExecutionResponse {
                protocol: PROTOCOL_VERSION,
                attempt_id: request.attempt_id,
                exit_code: None,
                success: false,
                timed_out: false,
                error_message: Some(error.to_string()),
            };
        }
    };

    if let Err(error) = ensure_start_authorized(&request.start_authorization, &cancel) {
        return ExecutionResponse {
            protocol: PROTOCOL_VERSION,
            attempt_id: request.attempt_id,
            exit_code: None,
            success: false,
            timed_out: false,
            error_message: Some(error),
        };
    }

    let job = match create_kill_on_close_job() {
        Ok(job) => job,
        Err(error) => {
            return ExecutionResponse {
                protocol: PROTOCOL_VERSION,
                attempt_id: request.attempt_id,
                exit_code: None,
                success: false,
                timed_out: false,
                error_message: Some(format!("Failed to create job object: {error}")),
            };
        }
    };

    let mut env = request.env.clone();
    for (key, value) in std::env::vars() {
        env.entry(key).or_insert(value);
    }
    let env_block = build_env_block(&env);
    let mut command_line = build_command_line(&request.command, &request.args);
    let cwd = to_wide(&request.cwd);

    let (stdout_read, stdout_write) = match create_output_pipe() {
        Ok(pair) => pair,
        Err(error) => {
            return ExecutionResponse {
                protocol: PROTOCOL_VERSION,
                attempt_id: request.attempt_id,
                exit_code: None,
                success: false,
                timed_out: false,
                error_message: Some(format!("Failed to create stdout pipe: {error}")),
            };
        }
    };
    let (stderr_read, stderr_write) = match create_output_pipe() {
        Ok(pair) => pair,
        Err(error) => {
            unsafe {
                let _ = CloseHandle(stdout_read);
                let _ = CloseHandle(stdout_write);
            }
            return ExecutionResponse {
                protocol: PROTOCOL_VERSION,
                attempt_id: request.attempt_id,
                exit_code: None,
                success: false,
                timed_out: false,
                error_message: Some(format!("Failed to create stderr pipe: {error}")),
            };
        }
    };
    let stdin_nul = match open_nul_stdin() {
        Ok(handle) => handle,
        Err(error) => {
            unsafe {
                let _ = CloseHandle(stdout_read);
                let _ = CloseHandle(stdout_write);
                let _ = CloseHandle(stderr_read);
                let _ = CloseHandle(stderr_write);
            }
            return ExecutionResponse {
                protocol: PROTOCOL_VERSION,
                attempt_id: request.attempt_id,
                exit_code: None,
                success: false,
                timed_out: false,
                error_message: Some(format!("Failed to open NUL for stdin: {error}")),
            };
        }
    };

    let create_result = create_suspended_child(
        &mut command_line,
        &cwd,
        &env_block,
        &job,
        [stdin_nul, stdout_write, stderr_write],
    );

    unsafe {
        let _ = CloseHandle(stdout_write);
        let _ = CloseHandle(stderr_write);
        let _ = CloseHandle(stdin_nul);
    }

    let process_info = match create_result {
        Ok(info) => info,
        Err(error) => {
            unsafe {
                let _ = CloseHandle(stdout_read);
                let _ = CloseHandle(stderr_read);
            }
            return ExecutionResponse {
                protocol: PROTOCOL_VERSION,
                attempt_id: request.attempt_id,
                exit_code: None,
                success: false,
                timed_out: false,
                error_message: Some(format!(
                    "Failed to create the child in its Job Object: {error}"
                )),
            };
        }
    };

    let start_result = (|| {
        let probe_control_pipe = prepare_control_pipe()?;
        ensure_start_authorized(&request.start_authorization, &cancel)?;
        if cancel.load(Ordering::SeqCst) {
            return Err("Job start cancelled".into());
        }
        probe_control_pipe()?;
        if unsafe { ResumeThread(process_info.hThread) } != 1 {
            return Err("ResumeThread failed to start the child process".into());
        }
        on_started().map_err(|error| format!("Could not report job start to Agent: {error}"))
    })();
    unsafe {
        let _ = CloseHandle(process_info.hThread);
    }
    if let Err(error) = start_result {
        // Closing the Job Object also terminates a child that never resumed.
        drop(job);
        unsafe {
            let _ = CloseHandle(process_info.hProcess);
            let _ = CloseHandle(stdout_read);
            let _ = CloseHandle(stderr_read);
        }
        return ExecutionResponse {
            protocol: PROTOCOL_VERSION,
            attempt_id: request.attempt_id,
            exit_code: None,
            success: false,
            timed_out: false,
            error_message: Some(error),
        };
    }

    let stdout_handle = stdout_read.0 as isize;
    let stderr_handle = stderr_read.0 as isize;
    let drain_stopped = Arc::new(AtomicBool::new(false));
    let stdout_stop = drain_stopped.clone();
    let stderr_stop = drain_stopped.clone();
    let stdout_thread = thread::spawn(move || stream_pipe(stdout_handle, TAG_STDOUT, stdout_stop));
    let stderr_thread = thread::spawn(move || stream_pipe(stderr_handle, TAG_STDERR, stderr_stop));

    let outputs_drained = || stdout_thread.is_finished() && stderr_thread.is_finished();
    let poll_interval = Duration::from_millis(25);
    let start = Instant::now();
    let mut timed_out = false;
    let mut error_message = None;
    let root_exited = loop {
        if cancel.load(Ordering::SeqCst) {
            break false;
        }
        let remaining = timeout.saturating_sub(start.elapsed());
        if remaining.is_zero() {
            timed_out = true;
            break false;
        }
        let wait_ms = poll_interval.min(remaining).as_millis().max(1) as u32;
        match unsafe { WaitForSingleObject(process_info.hProcess, wait_ms) } {
            WAIT_OBJECT_0 => break true,
            WAIT_TIMEOUT => {}
            _ => {
                error_message = Some("Failed to wait for the root process".to_string());
                break false;
            }
        }
    };

    if root_exited {
        // Give inherited output pipes a short drain window. A descendant that
        // keeps a pipe open cannot extend execution or change the root result.
        let exit_at = Instant::now();
        while !outputs_drained() && !cancel.load(Ordering::SeqCst) {
            let remaining = grace.saturating_sub(exit_at.elapsed());
            if remaining.is_zero() {
                break;
            }
            thread::sleep(poll_interval.min(remaining));
        }
    } else if let Err(error) = unsafe { TerminateJobObject(job.0, 1) } {
        error_message = Some(format!("Failed to terminate job object: {error}"));
    }
    // Close the kill-on-close handle before the final drain, even if explicit
    // termination failed or a surviving descendant holds no output handles.
    drop(job);
    let drain_start = Instant::now();
    while !outputs_drained() {
        let remaining = grace.saturating_sub(drain_start.elapsed());
        if remaining.is_zero() {
            drain_stopped.store(true, Ordering::SeqCst);
            error_message
                .get_or_insert_with(|| "Job output did not close after termination".into());
            break;
        }
        thread::sleep(poll_interval.min(remaining));
    }
    if stdout_thread.is_finished() {
        let _ = stdout_thread.join();
    }
    if stderr_thread.is_finished() {
        let _ = stderr_thread.join();
    }

    let mut exit_code: u32 = 0;
    let exit_code = unsafe {
        let exit_code = (WaitForSingleObject(process_info.hProcess, 0) == WAIT_OBJECT_0
            && GetExitCodeProcess(process_info.hProcess, &mut exit_code).is_ok())
        .then_some(exit_code as i32);
        let _ = CloseHandle(process_info.hProcess);
        exit_code
    };

    ExecutionResponse {
        protocol: PROTOCOL_VERSION,
        attempt_id: request.attempt_id,
        exit_code,
        success: root_exited && exit_code == Some(0),
        timed_out,
        error_message,
    }
}
