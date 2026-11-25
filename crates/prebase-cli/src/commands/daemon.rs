use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const MAX_LOCAL_HTTP_RESPONSE_BYTES: usize = 64 * 1024;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DaemonSession {
    pub pid: u32,
    pub port: u16,
    pub root_path: String,
    #[serde(default)]
    pub repo_id: String,
    pub startup_time: u64,
    #[serde(default)]
    pub watch_filesystem: bool,
    #[serde(default)]
    pub session_token: String,
}

#[derive(Deserialize, Debug)]
#[allow(dead_code)]
pub struct NavigateResult {
    pub delivered: bool,
    pub acknowledged: bool,
    pub active_clients: usize,
    pub client_id: Option<String>,
    pub request_id: Option<String>,
}

#[derive(Deserialize, Debug)]
struct MintBootstrapResult {
    bootstrap_token: String,
}

#[derive(Deserialize, Debug)]
#[allow(dead_code)]
struct ServerIdentityResult {
    pid: u32,
    port: u16,
    repository_id: String,
    canonical_root: String,
}

#[derive(Deserialize, Debug)]
#[allow(dead_code)]
struct ServerShutdownResult {
    shutting_down: bool,
    pid: u32,
}

pub fn get_session_file(repo_root: &Path) -> PathBuf {
    repo_root.join(".prebase").join("server.json")
}

pub fn get_lock_file(repo_root: &Path) -> PathBuf {
    repo_root.join(".prebase").join("server.lock")
}

fn reject_if_symlink(path: &Path) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if let Ok(meta) = fs::symlink_metadata(path) {
        if meta.file_type().is_symlink() {
            return Err(format!("Refusing to follow symlink at '{}'", path.display()).into());
        }
    }
    Ok(())
}

pub fn ensure_prebase_dir(
    repo_root: &Path,
) -> Result<PathBuf, Box<dyn std::error::Error + Send + Sync>> {
    let prebase_dir = repo_root.join(".prebase");
    reject_if_symlink(&prebase_dir)?;
    fs::create_dir_all(&prebase_dir)?;
    reject_if_symlink(&prebase_dir)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&prebase_dir, fs::Permissions::from_mode(0o700))?;
    }

    // Ensure .prebase directory is ignored by git without following symlinks
    let gitignore_file = prebase_dir.join(".gitignore");
    let mut gitignore_opts = OpenOptions::new();
    gitignore_opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        gitignore_opts.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    if let Ok(mut file) = gitignore_opts.open(&gitignore_file) {
        let _ = file.write_all(b"*\n");
    }

    Ok(prebase_dir)
}

pub fn open_secure_log_file(
    repo_root: &Path,
) -> Result<(PathBuf, fs::File), Box<dyn std::error::Error + Send + Sync>> {
    let prebase_dir = ensure_prebase_dir(repo_root)?;
    let log_path = prebase_dir.join("server.log");
    reject_if_symlink(&log_path)?;

    let mut opts = OpenOptions::new();
    opts.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }

    let file = opts.open(&log_path)?;
    Ok((log_path, file))
}

pub fn save_session(
    repo_root: &Path,
    pid: u32,
    port: u16,
    repo_id: &str,
    watch_filesystem: bool,
    session_token: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let prebase_dir = ensure_prebase_dir(repo_root)?;

    let session = DaemonSession {
        pid,
        port,
        root_path: repo_root.display().to_string(),
        repo_id: repo_id.to_string(),
        startup_time: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        watch_filesystem,
        session_token: session_token.to_string(),
    };

    let session_file = get_session_file(repo_root);
    reject_if_symlink(&session_file)?;
    let json = serde_json::to_string_pretty(&session)?;

    // Atomic 0600 write via unique temporary file + sync_all + rename
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let tmp_path = prebase_dir.join(format!("server.json.tmp.{pid}.{nanos}"));

    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }

    let write_res = (|| -> std::io::Result<()> {
        let mut file = opts.open(&tmp_path)?;
        file.write_all(json.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp_path, &session_file)?;
        Ok(())
    })();

    if let Err(err) = write_res {
        let _ = fs::remove_file(&tmp_path);
        return Err(err.into());
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&session_file, fs::Permissions::from_mode(0o600))?;
    }

    Ok(())
}

pub fn read_session(repo_root: &Path) -> Option<DaemonSession> {
    let prebase_dir = repo_root.join(".prebase");
    if reject_if_symlink(&prebase_dir).is_err() {
        return None;
    }
    let session_file = get_session_file(repo_root);
    if reject_if_symlink(&session_file).is_err() {
        return None;
    }

    let mut opts = OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW);
    }

    let mut file = opts.open(&session_file).ok()?;
    let mut content = String::new();
    file.read_to_string(&mut content).ok()?;
    serde_json::from_str(&content).ok()
}

pub fn remove_session(repo_root: &Path) {
    let session_file = get_session_file(repo_root);
    if reject_if_symlink(&session_file).is_ok() {
        let _ = fs::remove_file(session_file);
    }
}

/// Remove `server.json` under startup lock only if it still matches our `(pid, port)`
/// so a shutting-down instance never deletes a newer instance's session file.
pub fn remove_session_if_owned(repo_root: &Path, pid: u32, port: u16) {
    let _lock = acquire_startup_lock(repo_root).ok();
    if let Some(current) = read_session(repo_root) {
        if current.pid == pid && current.port == port {
            remove_session(repo_root);
        }
    }
}

pub struct StartupLockGuard {
    #[cfg(unix)]
    file: fs::File,
    #[cfg(not(unix))]
    lock_path: PathBuf,
}

impl Drop for StartupLockGuard {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            use std::os::unix::io::AsRawFd;
            unsafe {
                libc::flock(self.file.as_raw_fd(), libc::LOCK_UN);
            }
        }
        #[cfg(not(unix))]
        {
            let _ = fs::remove_file(&self.lock_path);
        }
    }
}

/// Acquire a repository-scoped exclusive startup lock (`.prebase/server.lock`)
/// with bounded wait to coordinate concurrent `prebase` invocations.
pub fn acquire_startup_lock(
    repo_root: &Path,
) -> Result<StartupLockGuard, Box<dyn std::error::Error + Send + Sync>> {
    ensure_prebase_dir(repo_root)?;
    let lock_path = get_lock_file(repo_root);
    let deadline = Instant::now() + Duration::from_secs(10);

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        use std::os::unix::io::AsRawFd;

        reject_if_symlink(&lock_path)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&lock_path)?;

        loop {
            let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
            if rc == 0 {
                return Ok(StartupLockGuard { file });
            }
            let err = std::io::Error::last_os_error();
            if err.raw_os_error() != Some(libc::EWOULDBLOCK)
                && err.raw_os_error() != Some(libc::EAGAIN)
            {
                return Err(err.into());
            }
            if Instant::now() >= deadline {
                return Err("Timed out waiting for PreBase startup lock".into());
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    #[cfg(not(unix))]
    {
        loop {
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&lock_path)
            {
                Ok(mut f) => {
                    let _ = write!(f, "{}", std::process::id());
                    return Ok(StartupLockGuard { lock_path });
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    if let Ok(meta) = fs::metadata(&lock_path) {
                        if let Ok(modified) = meta.modified() {
                            if modified.elapsed().unwrap_or_default() > Duration::from_secs(30) {
                                let _ = fs::remove_file(&lock_path);
                                continue;
                            }
                        }
                    }
                    if Instant::now() >= deadline {
                        return Err("Timed out waiting for PreBase startup lock".into());
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
                Err(e) => return Err(e.into()),
            }
        }
    }
}

async fn local_http_request(
    port: u16,
    method: &str,
    path: &str,
    session_token: &str,
    body: Option<&str>,
    timeout_dur: Duration,
) -> Result<(u16, String), Box<dyn std::error::Error + Send + Sync>> {
    tokio::time::timeout(timeout_dur, async move {
        let addr = format!("127.0.0.1:{port}");
        let mut stream = TcpStream::connect(&addr).await?;
        let payload = body.unwrap_or("");
        let mut req = format!(
            "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Prebase-Session: {session_token}\r\nConnection: close\r\n"
        );
        if body.is_some() {
            req.push_str("Content-Type: application/json\r\n");
            req.push_str(&format!("Content-Length: {}\r\n", payload.len()));
        }
        req.push_str("\r\n");
        if body.is_some() {
            req.push_str(payload);
        }

        stream.write_all(req.as_bytes()).await?;
        stream.flush().await?;

        let mut buf = Vec::new();
        stream
            .take(MAX_LOCAL_HTTP_RESPONSE_BYTES as u64)
            .read_to_end(&mut buf)
            .await?;
        let raw = String::from_utf8_lossy(&buf);

        let (head, resp_body) = raw
            .split_once("\r\n\r\n")
            .ok_or("Malformed HTTP response from local PreBase server")?;

        let status_line = head.lines().next().ok_or("Missing HTTP status line")?;
        let status_code: u16 = status_line
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse().ok())
            .ok_or("Invalid HTTP status code")?;

        Ok((status_code, resp_body.to_string()))
    })
    .await?
}

/// Verify that a stored session corresponds to a live, authenticated PreBase server
/// for the exact `expected_repo_id`, `repo_root`, `pid`, and `port`, protecting against
/// stale files and PID reuse.
pub async fn validate_live_session(
    repo_root: &Path,
    expected_repo_id: &str,
) -> Option<DaemonSession> {
    let session = read_session(repo_root)?;

    if session.session_token.is_empty()
        || session.repo_id != expected_repo_id
        || session.root_path != repo_root.display().to_string()
        || !is_prebase_process(session.pid)
    {
        remove_session(repo_root);
        return None;
    }

    match local_http_request(
        session.port,
        "GET",
        "/api/v1/server/identity",
        &session.session_token,
        None,
        Duration::from_millis(800),
    )
    .await
    {
        Ok((200, body)) => {
            if let Ok(id) = serde_json::from_str::<ServerIdentityResult>(&body) {
                if id.repository_id == expected_repo_id
                    && id.canonical_root == repo_root.display().to_string()
                    && id.pid == session.pid
                    && id.port == session.port
                {
                    return Some(session);
                }
            }
            remove_session(repo_root);
            None
        }
        _ => {
            remove_session(repo_root);
            None
        }
    }
}

pub async fn navigate_existing_workspace(
    session: &DaemonSession,
    view: &str,
    focus: Option<&str>,
) -> Result<NavigateResult, Box<dyn std::error::Error + Send + Sync>> {
    let body = serde_json::json!({
        "view": view,
        "focus": focus,
        "timeout_ms": 1500,
    })
    .to_string();

    let (status, resp_body) = local_http_request(
        session.port,
        "POST",
        "/api/v1/workspace/navigate",
        &session.session_token,
        Some(&body),
        Duration::from_millis(4500),
    )
    .await?;

    if status != 200 {
        return Err(format!("Workspace navigation failed (HTTP {status}): {resp_body}").into());
    }

    Ok(serde_json::from_str(&resp_body)?)
}

pub async fn mint_bootstrap_token(
    session: &DaemonSession,
    mark_launch_pending: bool,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let body = serde_json::json!({
        "mark_launch_pending": mark_launch_pending,
    })
    .to_string();
    let (status, resp_body) = local_http_request(
        session.port,
        "POST",
        "/api/v1/auth/bootstrap",
        &session.session_token,
        Some(&body),
        Duration::from_millis(1000),
    )
    .await?;

    if status != 200 {
        return Err(format!("Failed to mint bootstrap token (HTTP {status}): {resp_body}").into());
    }

    let parsed: MintBootstrapResult = serde_json::from_str(&resp_body)?;
    Ok(parsed.bootstrap_token)
}

async fn request_authenticated_shutdown(
    session: &DaemonSession,
) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    let (status, resp_body) = local_http_request(
        session.port,
        "POST",
        "/api/v1/server/shutdown",
        &session.session_token,
        Some("{}"),
        Duration::from_millis(1500),
    )
    .await?;

    if status != 200 {
        return Err(format!("Server shutdown failed (HTTP {status}): {resp_body}").into());
    }

    let parsed: ServerShutdownResult = serde_json::from_str(&resp_body)?;
    Ok(parsed.shutting_down)
}

fn is_valid_pid(pid: u32) -> bool {
    pid > 0 && pid <= i32::MAX as u32
}

#[cfg(unix)]
pub fn is_process_running(pid: u32) -> bool {
    if !is_valid_pid(pid) {
        return false;
    }
    let res = unsafe { libc::kill(pid as libc::pid_t, 0) };
    res == 0
}

#[cfg(unix)]
fn has_process_exited(pid: u32) -> bool {
    if !is_process_running(pid) {
        return true;
    }
    // On macOS/Unix, kill(pid, 0) returns 0 for zombie ('Z') processes that have already
    // terminated and released all resources while awaiting parent/init reaping.
    if let Ok(output) = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "stat="])
        .output()
    {
        if !output.status.success() {
            return true;
        }
        let stat = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return stat.is_empty() || stat.starts_with('Z');
    }
    false
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
    false
}

#[cfg(not(unix))]
pub fn is_process_running(pid: u32) -> bool {
    is_valid_pid(pid)
}

#[cfg(not(unix))]
pub fn is_prebase_process(pid: u32) -> bool {
    is_valid_pid(pid)
}

#[cfg(unix)]
pub fn terminate_process(pid: u32) -> bool {
    if !is_valid_pid(pid) {
        return false;
    }
    let res = unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
    res == 0
}

#[cfg(not(unix))]
pub fn terminate_process(_pid: u32) -> bool {
    false
}

pub async fn run_status(
    canonical_root: &Path,
    repo_id: &str,
    json: bool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let _lock = acquire_startup_lock(canonical_root)?;
    let session = validate_live_session(canonical_root, repo_id).await;
    let is_active = session.is_some();

    if json {
        // Redact session_token from JSON status output
        let safe_session = session.as_ref().map(|s| {
            serde_json::json!({
                "pid": s.pid,
                "port": s.port,
                "root_path": s.root_path,
                "repo_id": s.repo_id,
                "startup_time": s.startup_time,
                "watch_filesystem": s.watch_filesystem,
            })
        });
        let out = serde_json::json!({
            "active": is_active,
            "session": safe_session,
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

pub async fn run_stop(
    canonical_root: &Path,
    repo_id: &str,
    json: bool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let lock = acquire_startup_lock(canonical_root)?;
    let session_opt = validate_live_session(canonical_root, repo_id).await;
    // Release startup lock before waiting for the server process to exit so
    // the server's own `remove_session_if_owned()` cannot deadlock on `server.lock`.
    drop(lock);

    match session_opt {
        Some(s) => {
            let shutdown_ok = matches!(request_authenticated_shutdown(&s).await, Ok(true));

            #[cfg(unix)]
            let stopped = {
                let mut exited = false;
                for _ in 0..20 {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    if has_process_exited(s.pid) {
                        exited = true;
                        break;
                    }
                }
                // Fallback SIGTERM only if authenticated process is still alive
                if !exited && terminate_process(s.pid) {
                    for _ in 0..20 {
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        if has_process_exited(s.pid) {
                            exited = true;
                            break;
                        }
                    }
                }
                exited
            };

            #[cfg(not(unix))]
            let stopped = {
                let mut exited = false;
                if shutdown_ok {
                    for _ in 0..20 {
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        let still_up = local_http_request(
                            s.port,
                            "GET",
                            "/api/v1/server/identity",
                            &s.session_token,
                            None,
                            Duration::from_millis(200),
                        )
                        .await
                        .is_ok();
                        if !still_up {
                            exited = true;
                            break;
                        }
                    }
                }
                exited
            };

            #[cfg(unix)]
            let _ = shutdown_ok;

            if !stopped {
                if json {
                    println!(
                        "{}",
                        serde_json::json!({ "stopped": false, "pid": s.pid, "reason": "Server process did not exit" })
                    );
                } else {
                    eprintln!("Error: Failed to stop PreBase server (PID {}).", s.pid);
                }
                return Err(format!("PreBase server (PID {}) did not exit", s.pid).into());
            }

            remove_session_if_owned(canonical_root, s.pid, s.port);
            if json {
                println!("{}", serde_json::json!({ "stopped": true, "pid": s.pid }));
            } else {
                println!("Stopped PreBase server (PID {}).", s.pid);
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

#[cfg(test)]
mod tests {
    use super::*;
    use prebase_server::start_server;

    #[test]
    fn test_save_session_atomic_0600_and_lock() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();

        let guard = acquire_startup_lock(&root).unwrap();
        save_session(&root, 12345, 8888, "repo-1", true, "secret-tok").unwrap();
        drop(guard);

        let session_file = get_session_file(&root);
        assert!(session_file.exists());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&session_file).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "server.json must have 0600 permissions");
            let dir_mode = fs::metadata(root.join(".prebase"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(dir_mode, 0o700, ".prebase dir must have 0700 permissions");
        }

        let loaded = read_session(&root).unwrap();
        assert_eq!(loaded.pid, 12345);
        assert_eq!(loaded.port, 8888);
        assert_eq!(loaded.repo_id, "repo-1");
        assert_eq!(loaded.session_token, "secret-tok");
        assert!(loaded.watch_filesystem);

        // remove_session_if_owned does not remove if pid/port mismatch
        remove_session_if_owned(&root, 99999, 8888);
        assert!(get_session_file(&root).exists());
        remove_session_if_owned(&root, 12345, 8888);
        assert!(!get_session_file(&root).exists());
    }

    #[tokio::test]
    async fn test_validate_live_session_and_multi_repo_isolation() {
        let temp_a = tempfile::tempdir().unwrap();
        let temp_b = tempfile::tempdir().unwrap();
        let root_a = temp_a.path().canonicalize().unwrap();
        let root_b = temp_b.path().canonicalize().unwrap();

        let server_a = start_server(
            root_a.clone(),
            "repo-a".into(),
            "repo-id-a".into(),
            None,
            false,
        )
        .await
        .unwrap();

        // Save stale session (dead PID) -> validate_live_session cleans it up
        save_session(
            &root_a,
            999_999_999,
            server_a.port,
            "repo-id-a",
            false,
            &server_a.session_token,
        )
        .unwrap();
        assert!(validate_live_session(&root_a, "repo-id-a").await.is_none());
        assert!(!get_session_file(&root_a).exists());

        // Multi-repo isolation: repo-b pointing at repo-a must reject and clean up!
        save_session(
            &root_b,
            std::process::id(),
            server_a.port,
            "repo-id-a",
            false,
            &server_a.session_token,
        )
        .unwrap();
        assert!(validate_live_session(&root_b, "repo-id-b").await.is_none());
        assert!(!get_session_file(&root_b).exists());

        // Test mint_bootstrap_token and navigate_existing_workspace against live server_a
        let session = DaemonSession {
            pid: std::process::id(),
            port: server_a.port,
            root_path: root_a.display().to_string(),
            repo_id: "repo-id-a".into(),
            startup_time: 0,
            watch_filesystem: false,
            session_token: server_a.session_token.clone(),
        };
        let boot = mint_bootstrap_token(&session, false).await.unwrap();
        assert!(!boot.is_empty());

        let nav = navigate_existing_workspace(&session, "2d", Some("src/main.rs"))
            .await
            .unwrap();
        assert!(!nav.acknowledged);
        assert_eq!(nav.active_clients, 0);

        let _ = server_a.shutdown_tx.send(());
    }

    #[cfg(unix)]
    #[test]
    fn test_symlink_protection_and_pid_guard() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let target = temp.path().join("outside");
        fs::create_dir_all(&target).unwrap();

        // Symlinked .prebase directory must be rejected
        std::os::unix::fs::symlink(&target, root.join(".prebase")).unwrap();
        assert!(ensure_prebase_dir(&root).is_err());
        assert!(read_session(&root).is_none());

        // PID sign/group guard
        assert!(!is_process_running(0));
        assert!(!is_process_running(u32::MAX));
        assert!(!terminate_process(0));
        assert!(!terminate_process(u32::MAX));
    }
}
