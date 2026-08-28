#[cfg(windows)]
fn main() {
    use std::io::BufRead;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    use rbo_windows_executor::{
        execute_request, format_response, parse_request, write_control_frame,
    };

    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_flag = cancel.clone();
    let stdin_lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let lines_for_reader = stdin_lines.clone();

    // Keep reading stdin after the JSON request so a later CANCEL line can flip the flag.
    thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut reader = stdin.lock();
        let mut line = String::new();
        let mut got_request = false;
        while reader.read_line(&mut line).is_ok() {
            let trimmed = line.trim().to_string();
            if trimmed == "CANCEL" {
                cancel_flag.store(true, Ordering::SeqCst);
                break;
            }
            if !trimmed.is_empty() && !got_request {
                lines_for_reader.lock().unwrap().push(trimmed);
                got_request = true;
            }
            line.clear();
        }
    });

    let request_json = loop {
        let lines = stdin_lines.lock().unwrap();
        if let Some(first) = lines.first() {
            break first.clone();
        }
        drop(lines);
        thread::sleep(Duration::from_millis(10));
    };

    let request = match parse_request(&request_json) {
        Ok(request) => request,
        Err(error) => {
            eprintln!("invalid request: {error}");
            std::process::exit(2);
        }
    };

    let response = execute_request(request, cancel);
    let json = format_response(&response).unwrap_or_else(|_| "{}".to_string());
    write_control_frame(json.as_bytes());
}

#[cfg(not(windows))]
fn main() {
    eprintln!("rbo-windows-executor is only supported on Windows.");
    std::process::exit(1);
}
