use std::collections::HashMap;
use std::ffi::c_void;
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Security::SECURITY_ATTRIBUTES;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows::Win32::System::Pipes::CreatePipe;
use windows::Win32::System::Threading::{
    CreateProcessW, GetExitCodeProcess, ResumeThread, WaitForSingleObject, CREATE_SUSPENDED,
    CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOW,
};

use crate::{ExecutionRequest, ExecutionResponse, PROTOCOL_VERSION};

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

fn write_frame(tag: u8, data: &[u8]) {
    let mut stdout = io::stdout();
    let len = data.len() as u32;
    let _ = stdout.write_all(&[tag]);
    let _ = stdout.write_all(&len.to_le_bytes());
    let _ = stdout.write_all(data);
    let _ = stdout.flush();
}

pub fn write_control_frame(json: &[u8]) {
    write_frame(TAG_CONTROL, json);
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
        let job = CreateJobObjectW(None, PCWSTR::null())?;
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )?;
        Ok(JobHandle(job))
    }
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

fn create_inheritable_pipe() -> windows::core::Result<(HANDLE, HANDLE)> {
    unsafe {
        let mut read = HANDLE::default();
        let mut write = HANDLE::default();
        let mut sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: std::ptr::null_mut(),
            bInheritHandle: true.into(),
        };
        CreatePipe(&mut read, &mut write, Some(&mut sa), 0)?;
        Ok((read, write))
    }
}

fn stream_pipe(handle: isize, tag: u8) {
    let mut file = unsafe { std::fs::File::from_raw_handle(handle as _) };
    let mut buffer = [0u8; 4096];
    loop {
        match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => write_frame(tag, &buffer[..count]),
            Err(_) => break,
        }
    }
}

use std::os::windows::io::FromRawHandle;

pub fn execute_request(request: ExecutionRequest, cancel: Arc<AtomicBool>) -> ExecutionResponse {
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

    let (stdout_read, stdout_write) = match create_inheritable_pipe() {
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
    let (stderr_read, stderr_write) = match create_inheritable_pipe() {
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

    let mut startup_info = STARTUPINFOW::default();
    startup_info.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    startup_info.dwFlags = STARTF_USESTDHANDLES;
    startup_info.hStdOutput = stdout_write;
    startup_info.hStdError = stderr_write;
    startup_info.hStdInput = HANDLE::default();

    let mut process_info = PROCESS_INFORMATION::default();
    let create_result = unsafe {
        CreateProcessW(
            PCWSTR::null(),
            windows::core::PWSTR(command_line.as_mut_ptr()),
            None,
            None,
            true,
            CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
            Some(env_block.as_ptr() as *const c_void),
            PCWSTR(cwd.as_ptr()),
            &startup_info,
            &mut process_info,
        )
    };

    unsafe {
        let _ = CloseHandle(stdout_write);
        let _ = CloseHandle(stderr_write);
    }

    if create_result.is_err() {
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
            error_message: Some(format!("CreateProcessW failed: {:?}", create_result.err())),
        };
    }

    unsafe {
        if AssignProcessToJobObject(job.0, process_info.hProcess).is_err() {
            let _ = TerminateJobObject(job.0, 1);
            let _ = CloseHandle(process_info.hProcess);
            let _ = CloseHandle(process_info.hThread);
            let _ = CloseHandle(stdout_read);
            let _ = CloseHandle(stderr_read);
            return ExecutionResponse {
                protocol: PROTOCOL_VERSION,
                attempt_id: request.attempt_id,
                exit_code: None,
                success: false,
                timed_out: false,
                error_message: Some("AssignProcessToJobObject failed".to_string()),
            };
        }
        let _ = ResumeThread(process_info.hThread);
        let _ = CloseHandle(process_info.hThread);
    }

    let stdout_handle = stdout_read.0 as isize;
    let stderr_handle = stderr_read.0 as isize;
    let stdout_thread = thread::spawn(move || stream_pipe(stdout_handle, TAG_STDOUT));
    let stderr_thread = thread::spawn(move || stream_pipe(stderr_handle, TAG_STDERR));

    let deadline = Instant::now() + Duration::from_secs(request.timeout_seconds);
    let mut timed_out = false;
    loop {
        if cancel.load(Ordering::SeqCst) {
            unsafe {
                let _ = TerminateJobObject(job.0, 1);
            }
            thread::sleep(Duration::from_secs(request.cancel_grace_seconds));
            break;
        }
        if Instant::now() >= deadline {
            timed_out = true;
            unsafe {
                let _ = TerminateJobObject(job.0, 1);
            }
            thread::sleep(Duration::from_secs(request.cancel_grace_seconds));
            break;
        }
        let wait = unsafe { WaitForSingleObject(process_info.hProcess, 200) };
        if wait == WAIT_OBJECT_0 {
            break;
        }
    }

    let _ = stdout_thread.join();
    let _ = stderr_thread.join();

    let mut exit_code: u32 = 0;
    unsafe {
        let _ = GetExitCodeProcess(process_info.hProcess, &mut exit_code);
        let _ = CloseHandle(process_info.hProcess);
    }

    ExecutionResponse {
        protocol: PROTOCOL_VERSION,
        attempt_id: request.attempt_id,
        exit_code: Some(exit_code as i32),
        success: exit_code == 0 && !timed_out && !cancel.load(Ordering::SeqCst),
        timed_out,
        error_message: None,
    }
}
