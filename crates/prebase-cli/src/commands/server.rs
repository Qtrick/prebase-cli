use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tracing::{error, Level};
use tracing_subscriber::FmtSubscriber;

use prebase_parser::RepositoryAnalyzer;
use prebase_server::start_server;

use crate::commands::daemon::{remove_session, save_session};

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

#[allow(clippy::too_many_arguments)]
pub async fn run_server(
    canonical_root: PathBuf,
    repo_name: String,
    repo_id: String,
    port: Option<u16>,
    no_open: bool,
    no_watch: bool,
    detach: bool,
    view: &str,
    focus: Option<String>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if detach {
        return run_detached_server(
            &canonical_root,
            port,
            no_open,
            no_watch,
            view,
            focus.as_deref(),
        );
    }

    // Configure tracing exclusively to stderr so stdout is never polluted
    let subscriber = FmtSubscriber::builder()
        .with_max_level(Level::INFO)
        .with_writer(std::io::stderr)
        .finish();
    let _ = tracing::subscriber::set_global_default(subscriber);

    let watch_filesystem = !no_watch;
    let server = start_server(
        canonical_root.clone(),
        repo_name.clone(),
        repo_id.clone(),
        port,
        watch_filesystem,
    )
    .await?;

    let mut url = format!(
        "http://127.0.0.1:{}/?bootstrap={}&view={}",
        server.port, server.bootstrap_token, view
    );
    if let Some(focus_path) = &focus {
        url.push_str("&focus=");
        url.push_str(&percent_encode_query_param(focus_path));
    }

    let pid = std::process::id();
    let _ = save_session(&canonical_root, pid, server.port);

    println!(
        "\x1b[32m✔\x1b[0m Server running at: \x1b[4;34m{}\x1b[0m",
        url
    );

    if watch_filesystem {
        println!("  \x1b[36mℹ\x1b[0m Live filesystem monitoring enabled (SSE stream active)");
    }

    if !no_open {
        println!("  Launching default web browser...");
        if let Err(err) = open::that(&url) {
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
        }
    }
    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c().await?;
        println!("\nReceived shutdown signal. Stopping PreBase server...");
    }

    server.state.set_shutting_down();
    let _ = server.shutdown_tx.send(());
    indexing_handle.abort();
    remove_session(&canonical_root);

    Ok(())
}

fn run_detached_server(
    canonical_root: &Path,
    port: Option<u16>,
    no_open: bool,
    no_watch: bool,
    view: &str,
    focus: Option<&str>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let current_exe = std::env::current_exe()?;
    let prebase_dir = canonical_root.join(".prebase");
    std::fs::create_dir_all(&prebase_dir)?;

    let log_path = prebase_dir.join("server.log");
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&log_path)?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&log_path, std::fs::Permissions::from_mode(0o600));
    }

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
    if no_open {
        cmd.arg("--no-open");
    }
    if no_watch {
        cmd.arg("--no-watch");
    }

    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(log_file.try_clone()?);
    cmd.stderr(log_file);

    let child = cmd.spawn()?;
    let pid = child.id();

    // Poll server.log for startup URL (bounded wait up to 4s)
    let start_wait = Instant::now();
    let mut server_url = None;

    while start_wait.elapsed() < Duration::from_secs(4) {
        if let Ok(content) = std::fs::read_to_string(&log_path) {
            for line in content.lines() {
                if line.contains("Server running at:") {
                    if let Some(part) = line.split("Server running at:").nth(1) {
                        server_url = Some(part.trim().to_string());
                        break;
                    }
                }
            }
        }
        if server_url.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    println!("\x1b[32m✔\x1b[0m PreBase background server started \x1b[1m(PID {pid})\x1b[0m");
    if let Some(url) = server_url {
        println!("  \x1b[36m→\x1b[0m Web interface: \x1b[4;34m{}\x1b[0m", url);
    }
    println!("  \x1b[36m→\x1b[0m Log output:    {}", log_path.display());
    println!("  \x1b[36m→\x1b[0m To stop:       \x1b[1mprebase stop\x1b[0m\n");

    Ok(())
}
