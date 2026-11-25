use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tracing::{error, Level};
use tracing_subscriber::FmtSubscriber;

use prebase_parser::RepositoryAnalyzer;
use prebase_server::start_server;

use crate::commands::daemon::{
    acquire_startup_lock, mint_bootstrap_token, navigate_existing_workspace, open_secure_log_file,
    remove_session_if_owned, save_session, validate_live_session, DaemonSession,
};

fn percent_encode_query_param(value: &str) -> String {
    let mut out = String::with_capacity(value.len() * 3);
    for b in value.bytes() {
        match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push_str(&format!("%{:02X}", b));
            }
        }
    }
    out
}

fn build_bootstrap_url(
    port: u16,
    bootstrap_token: &str,
    view: &str,
    focus: Option<&str>,
) -> String {
    let mut url = format!(
        "http://127.0.0.1:{}/?bootstrap={}&view={}",
        port, bootstrap_token, view
    );
    if let Some(focus_path) = focus {
        url.push_str("&focus=");
        url.push_str(&percent_encode_query_param(focus_path));
    }
    url
}

fn open_browser_url(url: &str) -> std::io::Result<()> {
    if std::env::var_os("PREBASE_NO_OS_OPEN").is_some() {
        return Ok(());
    }
    open::that(url)
}

fn is_session_compatible(session: &DaemonSession, port: Option<u16>, no_watch: bool) -> bool {
    let port_ok = port.is_none() || port == Some(session.port);
    let watch_ok = session.watch_filesystem == !no_watch;
    port_ok && watch_ok
}

async fn reuse_existing_server(
    session: &DaemonSession,
    no_open: bool,
    new_window: bool,
    view: &str,
    focus: Option<&str>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if no_open {
        println!(
            "\x1b[32m✔\x1b[0m Reusing existing PreBase server at \x1b[4;34mhttp://127.0.0.1:{}/\x1b[0m (PID {})",
            session.port, session.pid
        );
        println!("  Browser launch skipped (--no-open).");
        return Ok(());
    }

    if !new_window {
        if let Ok(nav) = navigate_existing_workspace(session, view, focus).await {
            if nav.acknowledged {
                if let Some(f) = focus {
                    println!(
                        "\x1b[32m✔\x1b[0m Reused existing PreBase workspace at \x1b[4;34mhttp://127.0.0.1:{}/\x1b[0m (view: {}, focus: {})",
                        session.port, view, f
                    );
                } else {
                    println!(
                        "\x1b[32m✔\x1b[0m Reused existing PreBase workspace at \x1b[4;34mhttp://127.0.0.1:{}/\x1b[0m (view: {})",
                        session.port, view
                    );
                }
                return Ok(());
            }
        }
    }

    let bootstrap_token = mint_bootstrap_token(session, !new_window).await?;
    let url = build_bootstrap_url(session.port, &bootstrap_token, view, focus);
    if new_window {
        println!(
            "\x1b[32m✔\x1b[0m Reusing existing PreBase server (PID {}) — opening new browser tab at: \x1b[4;34m{}\x1b[0m",
            session.pid, url
        );
    } else {
        println!(
            "\x1b[32m✔\x1b[0m Reusing existing PreBase server (PID {}, no active browser tab) — opening: \x1b[4;34m{}\x1b[0m",
            session.pid, url
        );
    }

    if let Err(err) = open_browser_url(&url) {
        println!(
            "  \x1b[33mNotice:\x1b[0m Could not open browser automatically: {}. Please visit the link above.",
            err
        );
    }

    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn run_server(
    canonical_root: PathBuf,
    repo_name: String,
    repo_id: String,
    port: Option<u16>,
    no_open: bool,
    no_watch: bool,
    detach: bool,
    new_window: bool,
    view: &str,
    focus: Option<String>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if detach {
        let lock_guard = acquire_startup_lock(&canonical_root)?;
        if let Some(session) = validate_live_session(&canonical_root, &repo_id).await {
            if is_session_compatible(&session, port, no_watch) {
                drop(lock_guard);
                return reuse_existing_server(
                    &session,
                    no_open,
                    new_window,
                    view,
                    focus.as_deref(),
                )
                .await;
            }
            drop(lock_guard);
            return Err(format!(
                "PreBase server is already running for this repository on port {} (PID {}) with incompatible options (watch_filesystem={}). Run 'prebase stop' first.",
                session.port, session.pid, session.watch_filesystem
            )
            .into());
        }
        drop(lock_guard);
        return run_detached_server(
            &canonical_root,
            &repo_id,
            port,
            no_open,
            no_watch,
            new_window,
            view,
            focus.as_deref(),
        )
        .await;
    }

    // Configure tracing exclusively to stderr so stdout is never polluted
    let subscriber = FmtSubscriber::builder()
        .with_max_level(Level::INFO)
        .with_writer(std::io::stderr)
        .finish();
    let _ = tracing::subscriber::set_global_default(subscriber);

    let lock_guard = acquire_startup_lock(&canonical_root)?;
    if let Some(session) = validate_live_session(&canonical_root, &repo_id).await {
        if is_session_compatible(&session, port, no_watch) {
            drop(lock_guard);
            return reuse_existing_server(&session, no_open, new_window, view, focus.as_deref())
                .await;
        }
        drop(lock_guard);
        return Err(format!(
            "PreBase server is already running for this repository on port {} (PID {}) with incompatible options (watch_filesystem={}). Run 'prebase stop' first.",
            session.port, session.pid, session.watch_filesystem
        )
        .into());
    }

    let watch_filesystem = !no_watch;
    let server = start_server(
        canonical_root.clone(),
        repo_name.clone(),
        repo_id.clone(),
        port,
        watch_filesystem,
    )
    .await?;

    let url = build_bootstrap_url(server.port, &server.bootstrap_token, view, focus.as_deref());

    let pid = std::process::id();
    save_session(
        &canonical_root,
        pid,
        server.port,
        &repo_id,
        watch_filesystem,
        &server.session_token,
    )?;
    if !no_open {
        server.state.mark_launch_pending(Duration::from_secs(3));
    }
    drop(lock_guard);

    let is_detached_child = std::env::var_os("PREBASE_DETACHED_CHILD").is_some();
    if no_open && is_detached_child {
        println!(
            "\x1b[32m✔\x1b[0m Server running at: \x1b[4;34mhttp://127.0.0.1:{}/\x1b[0m",
            server.port
        );
    } else {
        println!(
            "\x1b[32m✔\x1b[0m Server running at: \x1b[4;34m{}\x1b[0m",
            url
        );
    }

    if watch_filesystem {
        println!("  \x1b[36mℹ\x1b[0m Live filesystem monitoring enabled (SSE stream active)");
    }

    if !no_open {
        println!("  Launching default web browser...");
        if let Err(err) = open_browser_url(&url) {
            println!("  \x1b[33mNotice:\x1b[0m Could not open browser automatically: {}. Please visit the link above.", err);
        }
    } else {
        println!("  Browser launch skipped (--no-open).");
    }

    let state_clone = server.state.clone();
    let root_clone = canonical_root.clone();

    let indexing_handle = tokio::spawn(async move {
        state_clone.set_status(prebase_core::model::IndexingStatus::Scanning);
        state_clone.set_analyzing(true);
        let start = Instant::now();
        let initial_gen = state_clone.get_next_generation();
        let analyzer = RepositoryAnalyzer::default();
        let state_cancel = state_clone.clone();
        match tokio::task::spawn_blocking(move || {
            analyzer.analyze_path_cancellable(&root_clone, move || state_cancel.is_shutting_down())
        })
        .await
        {
            Ok(Ok(result)) => {
                let duration = start.elapsed().as_millis() as u64;
                let node_count = result.snapshot.nodes.len();
                let edge_count = result.snapshot.edges.len();
                let publish_res = state_clone.publish_network(
                    result.snapshot,
                    result.index,
                    vec![],
                    Some(initial_gen),
                );
                state_clone.set_analyzing(false);
                if publish_res.is_ok() {
                    state_clone.set_analysis_duration(duration);
                    println!(
                        "\x1b[32m✔\x1b[0m Indexed \x1b[1m{}\x1b[0m files with \x1b[1m{}\x1b[0m confirmed relationships in {}ms",
                        node_count,
                        edge_count,
                        duration
                    );
                }
            }
            Ok(Err(err)) => {
                state_clone.set_analyzing(false);
                if !state_clone.is_shutting_down() {
                    error!("Repository analysis failed: {err}");
                    eprintln!("\x1b[31m✖\x1b[0m Repository analysis failed: {err}");
                    if state_clone.current_generation() == initial_gen {
                        state_clone.set_failed(&err);
                    }
                }
            }
            Err(join_err) => {
                state_clone.set_analyzing(false);
                if !state_clone.is_shutting_down() {
                    error!("Analysis task panicked: {join_err}");
                    if state_clone.current_generation() == initial_gen {
                        state_clone.set_failed(&join_err.to_string());
                    }
                }
            }
        }
    });

    println!("\n\x1b[1;36mPreBase server active in foreground.\x1b[0m");
    println!("  • This terminal is occupied by the server process.");
    println!("  • Press \x1b[1mCtrl+C\x1b[0m to shut down PreBase cleanly.");
    println!("  • To run CLI commands, open another terminal window or use \x1b[1mprebase map --detach\x1b[0m.\n");

    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut sigterm = signal(SignalKind::terminate())?;
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                println!("\nReceived SIGINT (Ctrl+C). Stopping PreBase server...");
            }
            _ = sigterm.recv() => {
                println!("\nReceived SIGTERM. Stopping PreBase server...");
            }
            _ = server.state.shutdown_notify.notified() => {
                println!("\nReceived authenticated shutdown request. Stopping PreBase server...");
            }
        }
    }
    #[cfg(not(unix))]
    {
        tokio::select! {
            res = tokio::signal::ctrl_c() => {
                res?;
                println!("\nReceived shutdown signal. Stopping PreBase server...");
            }
            _ = server.state.shutdown_notify.notified() => {
                println!("\nReceived authenticated shutdown request. Stopping PreBase server...");
            }
        }
    }

    server.state.set_shutting_down();
    let _ = server.shutdown_tx.send(());
    if let Some(watcher) = server.watcher_handle {
        let _ = watcher.shutdown_tx.send(());
        let _ = tokio::time::timeout(Duration::from_millis(500), watcher.task_handle).await;
    }
    let _ = tokio::time::timeout(Duration::from_millis(500), server.server_handle).await;
    indexing_handle.abort();
    let _ = tokio::time::timeout(Duration::from_millis(200), indexing_handle).await;
    remove_session_if_owned(&canonical_root, pid, server.port);
    use std::io::Write;
    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();
    std::process::exit(0);
}

#[allow(clippy::too_many_arguments)]
async fn run_detached_server(
    canonical_root: &Path,
    repo_id: &str,
    port: Option<u16>,
    no_open: bool,
    no_watch: bool,
    new_window: bool,
    view: &str,
    focus: Option<&str>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let current_exe = std::env::current_exe()?;
    let (log_path, log_file) = open_secure_log_file(canonical_root)?;

    let mut cmd = std::process::Command::new(current_exe);
    cmd.arg(canonical_root);
    if view == "temporal" {
        cmd.arg("history");
    } else {
        cmd.arg("map");
        cmd.arg("--view").arg(view);
    }
    if let Some(f) = focus {
        cmd.arg("--focus").arg(f);
    }
    if let Some(p) = port {
        cmd.arg("--port").arg(p.to_string());
    }
    // Always pass --no-open and PREBASE_DETACHED_CHILD=1 to detached child so bootstrap tokens
    // are never persisted in server.log; the parent mints a fresh token after verifying readiness.
    cmd.env("PREBASE_DETACHED_CHILD", "1");
    cmd.arg("--no-open");
    if no_watch {
        cmd.arg("--no-watch");
    }

    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(log_file.try_clone()?);
    cmd.stderr(log_file);

    let mut child = cmd.spawn()?;
    let pid = child.id();

    let start_wait = Instant::now();
    let mut ready_session = None;
    while start_wait.elapsed() < Duration::from_secs(5) {
        if let Some(status) = child.try_wait()? {
            // If another concurrent invocation won the startup lock and this child reused it
            // cleanly with --no-open (exit code 0), reuse that live session rather than failing.
            if status.success() {
                if let Some(session) = validate_live_session(canonical_root, repo_id).await {
                    if is_session_compatible(&session, port, no_watch) {
                        return reuse_existing_server(&session, no_open, new_window, view, focus)
                            .await;
                    }
                }
            }
            return Err(format!(
                "Detached PreBase server (PID {pid}) exited early with status {status}. See {}",
                log_path.display()
            )
            .into());
        }
        if let Some(session) = validate_live_session(canonical_root, repo_id).await {
            if session.pid == pid {
                ready_session = Some(session);
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    let session = ready_session.ok_or_else(|| {
        format!(
            "Timed out waiting for detached PreBase server (PID {pid}) to become ready. See {}",
            log_path.display()
        )
    })?;

    println!("\x1b[32m✔\x1b[0m PreBase background server started \x1b[1m(PID {pid})\x1b[0m");
    println!(
        "  \x1b[36m→\x1b[0m Web interface: \x1b[4;34mhttp://127.0.0.1:{}/\x1b[0m",
        session.port
    );
    println!("  \x1b[36m→\x1b[0m Log output:    {}", log_path.display());
    println!("  \x1b[36m→\x1b[0m To stop:       \x1b[1mprebase stop\x1b[0m\n");

    if !no_open {
        reuse_existing_server(&session, false, new_window, view, focus).await?;
    }

    Ok(())
}
