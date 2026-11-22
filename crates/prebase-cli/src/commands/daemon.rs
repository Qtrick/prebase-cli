use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Debug)]
pub struct DaemonSession {
    pub pid: u32,
    pub port: u16,
    pub root_path: String,
    pub startup_time: u64,
}

pub fn get_session_file(repo_root: &Path) -> PathBuf {
    repo_root.join(".prebase").join("server.json")
}

pub fn save_session(
    repo_root: &Path,
    pid: u32,
    port: u16,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let prebase_dir = repo_root.join(".prebase");
    fs::create_dir_all(&prebase_dir)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&prebase_dir, fs::Permissions::from_mode(0o700));
    }

    let session = DaemonSession {
        pid,
        port,
        root_path: repo_root.display().to_string(),
        startup_time: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    };

    let session_file = get_session_file(repo_root);
    let json = serde_json::to_string_pretty(&session)?;
    fs::write(&session_file, json)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&session_file, fs::Permissions::from_mode(0o600));
    }

    // Ensure .prebase directory is ignored by git if located inside a repository
    let gitignore_file = prebase_dir.join(".gitignore");
    if !gitignore_file.exists() {
        let _ = fs::write(&gitignore_file, "*\n");
    }

    Ok(())
}

pub fn read_session(repo_root: &Path) -> Option<DaemonSession> {
    let session_file = get_session_file(repo_root);
    if !session_file.exists() {
        return None;
    }
    let content = fs::read_to_string(&session_file).ok()?;
    serde_json::from_str(&content).ok()
}

pub fn remove_session(repo_root: &Path) {
    let session_file = get_session_file(repo_root);
    let _ = fs::remove_file(session_file);
}

#[cfg(unix)]
pub fn is_process_running(pid: u32) -> bool {
    let res = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if res == 0 {
        return true;
    }
    // Check ESRCH (process does not exist) vs EPERM (exists but different user)
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(unix)]
pub fn is_prebase_process(pid: u32) -> bool {
    if !is_process_running(pid) {
        return false;
    }
    // Verify process command name to defend against PID reuse
    if let Ok(output) = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
    {
        if output.status.success() {
            let comm = String::from_utf8_lossy(&output.stdout).to_lowercase();
            return comm.contains("prebase");
        }
    }
    // Fallback to is_process_running if ps cannot be queried
    true
}

#[cfg(not(unix))]
pub fn is_process_running(_pid: u32) -> bool {
    true
}

#[cfg(not(unix))]
pub fn is_prebase_process(pid: u32) -> bool {
    is_process_running(pid)
}

#[cfg(unix)]
pub fn terminate_process(pid: u32) -> bool {
    let res = unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
    res == 0
}

#[cfg(not(unix))]
pub fn terminate_process(_pid: u32) -> bool {
    false
}

pub fn run_status(
    canonical_root: &Path,
    json: bool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let session_opt = read_session(canonical_root);

    let (is_active, session) = match session_opt {
        Some(s) if is_prebase_process(s.pid) => (true, Some(s)),
        Some(_) => {
            // Stale session file
            remove_session(canonical_root);
            (false, None)
        }
        None => (false, None),
    };

    if json {
        let out = serde_json::json!({
            "active": is_active,
            "session": session,
        });
        println!("{}", serde_json::to_string_pretty(&out)?);
        return Ok(());
    }

    if let Some(s) = session {
        println!("PreBase background server is ACTIVE.");
        println!("  PID:  {}", s.pid);
        println!("  Port: {}", s.port);
        println!("  Root: {}", s.root_path);
    } else {
        println!(
            "No active PreBase background server for '{}'.",
            canonical_root.display()
        );
    }

    Ok(())
}

pub fn run_stop(
    canonical_root: &Path,
    json: bool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let session_opt = read_session(canonical_root);

    match session_opt {
        Some(s) => {
            if is_prebase_process(s.pid) {
                let success = terminate_process(s.pid);
                if success {
                    // Bounded wait up to 2 seconds for process to exit
                    for _ in 0..20 {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                        if !is_process_running(s.pid) {
                            break;
                        }
                    }
                }
                remove_session(canonical_root);
                if json {
                    println!("{}", serde_json::json!({ "stopped": true, "pid": s.pid }));
                } else {
                    println!("Stopped PreBase server (PID {}).", s.pid);
                }
            } else {
                remove_session(canonical_root);
                if json {
                    println!(
                        "{}",
                        serde_json::json!({ "stopped": false, "reason": "Process was not running" })
                    );
                } else {
                    println!("PreBase server was not running. Removed stale session file.");
                }
            }
        }
        None => {
            if json {
                println!(
                    "{}",
                    serde_json::json!({ "stopped": false, "reason": "No active session" })
                );
            } else {
                println!(
                    "No active PreBase session found for '{}'.",
                    canonical_root.display()
                );
            }
        }
    }

    Ok(())
}
