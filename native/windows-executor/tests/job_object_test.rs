#![cfg(windows)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use rbo_windows_executor::{execute_request, process_exists, ExecutionRequest, PROTOCOL_VERSION};

#[test]
fn child_and_grandchild_are_killed_on_job_cancel() {
    let script = r#"
$child = Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 600' -PassThru
Start-Sleep -Seconds 1
$grand = Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 600' -PassThru
Set-Content -Path $env:TEMP\rbo-test-pids.txt -Value "$($child.Id),$($grand.Id)"
Start-Sleep -Seconds 600
"#;
    let script_path = std::env::temp_dir().join("rbo-grandchild-test.ps1");
    let pid_file = std::env::temp_dir().join("rbo-test-pids.txt");
    let _ = std::fs::remove_file(&pid_file);
    std::fs::write(&script_path, script).expect("write script");

    let request = ExecutionRequest {
        protocol: PROTOCOL_VERSION,
        attempt_id: "att_test".to_string(),
        command: "powershell.exe".to_string(),
        args: vec![
            "-NoProfile".to_string(),
            "-File".to_string(),
            script_path.to_string_lossy().to_string(),
        ],
        cwd: std::env::temp_dir().to_string_lossy().to_string(),
        env: HashMap::new(),
        timeout_seconds: 30,
        cancel_grace_seconds: 2,
    };

    let cancel = Arc::new(AtomicBool::new(false));
    let cancel_for_timer = cancel.clone();
    thread::spawn(move || {
        // Wait long enough for the script to spawn child+grandchild and write the PID file.
        thread::sleep(Duration::from_secs(5));
        cancel_for_timer.store(true, Ordering::SeqCst);
    });

    let response = execute_request(request, cancel);
    assert!(!response.success);

    assert!(
        pid_file.exists(),
        "PID file was not created — child/grandchild spawn did not run; test cannot prove Job Object kill"
    );
    let contents = std::fs::read_to_string(&pid_file).expect("read pids");
    let pids: Vec<u32> = contents
        .split(',')
        .filter_map(|s| s.trim().parse::<u32>().ok())
        .collect();
    assert_eq!(
        pids.len(),
        2,
        "expected child and grandchild PIDs in {contents}"
    );
    for pid in pids {
        assert!(
            !process_exists(pid),
            "process {pid} still alive after cancel"
        );
    }
    let _ = std::fs::remove_file(pid_file);
    let _ = std::fs::remove_file(script_path);
}
