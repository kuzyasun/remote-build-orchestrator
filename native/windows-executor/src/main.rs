#[cfg(windows)]
mod artifact_publication;

#[cfg(windows)]
fn main() {
    if std::env::args_os().nth(1).as_deref() == Some("--publish-artifact-v1".as_ref()) {
        artifact_publication::run();
        return;
    }
    if let Err(error) = run_job() {
        eprintln!("{error}");
        std::process::exit(2);
    }
}

#[cfg(windows)]
fn run_job() -> Result<(), String> {
    use std::fs::File;
    use std::io::{self, BufRead, BufReader, Read};
    use std::os::windows::io::FromRawHandle;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc};
    use std::thread;

    use rbo_windows_executor::{
        execute_request, format_response, parse_request, write_control_frame, write_started_frame,
    };
    use windows::Win32::Foundation::{SetHandleInformation, HANDLE_FLAG_INHERIT};
    use windows::Win32::System::Console::{GetStdHandle, STD_INPUT_HANDLE};
    use windows::Win32::System::Pipes::PeekNamedPipe;

    let input = unsafe { GetStdHandle(STD_INPUT_HANDLE) }
        .map_err(|error| format!("Could not open Agent control pipe: {error}"))?;
    if input.is_invalid() {
        return Err("Missing Agent control pipe".into());
    }
    let mut reader = BufReader::new(unsafe { File::from_raw_handle(input.0) });
    unsafe { SetHandleInformation(input, HANDLE_FLAG_INHERIT.0, Default::default()) }
        .map_err(|error| format!("Could not protect Agent control pipe: {error}"))?;
    let mut request_json = String::new();
    if reader
        .read_line(&mut request_json)
        .map_err(|error| format!("Could not read Agent execution request: {error}"))?
        == 0
    {
        return Ok(());
    }
    if !request_json.ends_with('\n') {
        return Err("Agent control pipe closed before the complete execution request".into());
    }
    let request =
        parse_request(&request_json).map_err(|error| format!("invalid request: {error}"))?;
    let cancel = Arc::new(AtomicBool::new(false));
    let (enable_reader, wait_for_resume) = mpsc::sync_channel(1);
    let response = execute_request(
        request,
        cancel.clone(),
        || {
            let buffered_cancel = !reader.buffer().is_empty();
            thread::Builder::new()
                .spawn(move || {
                    // Keep synchronous ReadFile off the pipe during the final peek.
                    if wait_for_resume.recv().is_ok() {
                        // A control byte, EOF or any read error revokes the job.
                        let _ = reader.read(&mut [0]);
                        cancel.store(true, Ordering::SeqCst);
                    }
                })
                .map_err(|error| format!("Could not monitor Agent control pipe: {error}"))?;
            Ok(move || {
                if buffered_cancel {
                    return Err("Job start cancelled".into());
                }
                let mut available = 0;
                unsafe { PeekNamedPipe(input, None, 0, None, Some(&mut available), None) }
                    .map_err(|error| {
                        format!("Agent control pipe closed before job start: {error}")
                    })?;
                if available != 0 {
                    return Err("Job start cancelled".into());
                }
                Ok(())
            })
        },
        move || {
            enable_reader
                .send(())
                .map_err(|_| io::Error::other("Agent control pipe monitor stopped"))?;
            write_started_frame()
        },
    );
    let json = format_response(&response).unwrap_or_else(|_| "{}".to_string());
    write_control_frame(json.as_bytes());
    Ok(())
}

#[cfg(not(windows))]
fn main() {
    eprintln!("rbo-windows-executor is only supported on Windows.");
    std::process::exit(1);
}
