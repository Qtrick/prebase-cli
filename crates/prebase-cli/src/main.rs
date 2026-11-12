use clap::{Parser, Subcommand};
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tracing::{error, Level};
use tracing_subscriber::FmtSubscriber;

use prebase_core::scanner::RepositoryScanner;
use prebase_parser::RepositoryAnalyzer;
use prebase_server::start_server;

#[derive(Parser, Debug)]
#[command(
    name = "prebase",
    author = "PreBase Contributors",
    version = "0.1.0",
    about = "PreBase CLI — Local-first Codebase Intelligence & Interactive Network/Temporal Graphs",
    long_about = "PreBase is a local-first codebase intelligence application that analyzes repository\nstructure and Git history, rendering interactive Network and Temporal graphs in your local browser."
)]
pub struct CliArgs {
    /// Target repository path to analyze (defaults to current directory)
    #[arg(value_name = "PATH", global = true)]
    pub path: Option<PathBuf>,

    /// Specific port to bind the local server to (defaults to random available port)
    #[arg(long, value_name = "PORT", global = true)]
    pub port: Option<u16>,

    /// Do not automatically open the default web browser
    #[arg(long, global = true)]
    pub no_open: bool,

    /// Disable live filesystem watching and incremental graph synchronization
    #[arg(long, global = true)]
    pub no_watch: bool,

    #[command(subcommand)]
    pub command: Option<Commands>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum)]
pub enum MapViewMode {
    /// 3D Network Graph dependency orb (default)
    #[value(name = "3d")]
    ThreeD,
    /// Contextual 2D relationship view (Stage 2)
    #[value(name = "2d")]
    TwoD,
}

#[derive(Subcommand, Debug, Clone, PartialEq, Eq)]
pub enum Commands {
    /// Open repository directly into the interactive Network Graph
    Map {
        #[arg(value_name = "PATH")]
        path: Option<PathBuf>,

        /// View mode for the network graph (3d or 2d)
        #[arg(long, value_enum, default_value = "3d")]
        view: MapViewMode,

        /// Relative file path to focus in the relationship view or 3D graph
        #[arg(long, value_name = "RELATIVE_PATH")]
        focus: Option<String>,
    },
    /// Inspect Git commit history, ancestry DAG, and changed files (Temporal Graph)
    History {
        #[arg(value_name = "PATH")]
        path: Option<PathBuf>,
    },
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let subscriber = FmtSubscriber::builder()
        .with_max_level(Level::INFO)
        .finish();
    let _ = tracing::subscriber::set_global_default(subscriber);

    let args = CliArgs::parse();

    let target_path = match &args.command {
        Some(Commands::Map { path: Some(p), .. }) => p.clone(),
        Some(Commands::History { path: Some(p) }) => p.clone(),
        Some(Commands::Map { path: None, .. }) | Some(Commands::History { path: None }) => {
            args.path.clone().unwrap_or_else(|| PathBuf::from("."))
        }
        _ => args.path.clone().unwrap_or_else(|| PathBuf::from(".")),
    };

    println!("\x1b[1;36mPreBase CLI v0.1.0\x1b[0m — Codebase Intelligence & Temporal Analysis");

    // 1. Repository discovery
    let canonical_root = match RepositoryScanner::discover_root(&target_path) {
        Ok(root) => root,
        Err(err) => {
            eprintln!(
                "\x1b[1;31mError:\x1b[0m Could not locate repository at '{}': {}",
                target_path.display(),
                err
            );
            std::process::exit(1);
        }
    };

    let repo_name = canonical_root
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("repository")
        .to_string();

    let scanner = RepositoryScanner::new(&canonical_root, Default::default())?;
    let repo_id = scanner.repository_id();

    println!(
        "\x1b[32m✔\x1b[0m Repository detected: \x1b[1m{}\x1b[0m ({})",
        repo_name,
        canonical_root.display()
    );

    // 2. Start local Axum server with optional filesystem watching
    let watch_filesystem = !args.no_watch;
    let mut server = start_server(
        canonical_root.clone(),
        repo_name.clone(),
        repo_id.clone(),
        args.port,
        watch_filesystem,
    )
    .await?;

    let (target_view, target_focus) = match &args.command {
        Some(Commands::History { .. }) => ("temporal", None),
        Some(Commands::Map { view, focus, .. }) => {
            let v = match view {
                MapViewMode::ThreeD => "3d",
                MapViewMode::TwoD => "2d",
            };
            (v, focus.as_deref())
        }
        None => ("3d", None),
    };

    let mut url = format!(
        "http://127.0.0.1:{}/?bootstrap={}&view={}",
        server.port, server.bootstrap_token, target_view
    );
    if let Some(focus_path) = target_focus {
        url.push_str("&focus=");
        url.push_str(&percent_encode_query_param(focus_path));
    }

    println!(
        "\x1b[32m✔\x1b[0m Server running at: \x1b[4;34m{}\x1b[0m",
        url
    );

    if watch_filesystem {
        println!("  \x1b[36mℹ\x1b[0m Live filesystem monitoring enabled (SSE stream active)");
    }

    // 3. Launch browser if not --no-open
    if !args.no_open {
        println!("  Launching default web browser...");
        if let Err(err) = open::that(&url) {
            println!("  \x1b[33mNotice:\x1b[0m Could not open browser automatically: {}. Please visit the link above.", err);
        }
    } else {
        println!("  Browser launch skipped (--no-open).");
    }

    // 4. Background repository indexing
    let state_clone = server.state.clone();
    let root_clone = canonical_root.clone();

    let indexing_handle = tokio::spawn(async move {
        println!("  Indexing source files...");
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

    println!("\nPress \x1b[1mCtrl+C\x1b[0m to shut down PreBase cleanly.\n");

    // 5. Graceful shutdown on SIGINT (Ctrl+C) and SIGTERM (Unix)
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

    // Signal shutdown to shared state so ongoing tasks abandon in-flight work immediately
    server.state.set_shutting_down();

    // Terminate server and release listener
    let _ = server.shutdown_tx.send(());

    // Abort and bounded-wait initial indexing task if still in flight
    indexing_handle.abort();
    let _ = tokio::time::timeout(Duration::from_millis(500), indexing_handle).await;

    // Terminate filesystem watcher cleanly with abort and bounded-wait
    if let Some(mut watcher) = server.watcher_handle {
        let _ = watcher.shutdown_tx.send(());
        if tokio::time::timeout(Duration::from_millis(1000), &mut watcher.task_handle)
            .await
            .is_err()
        {
            watcher.task_handle.abort();
            let _ =
                tokio::time::timeout(Duration::from_millis(200), &mut watcher.task_handle).await;
        }
    }

    // Bounded-wait on HTTP server task with fallback abort
    if tokio::time::timeout(Duration::from_millis(1000), &mut server.server_handle)
        .await
        .is_err()
    {
        server.server_handle.abort();
        let _ = tokio::time::timeout(Duration::from_millis(200), &mut server.server_handle).await;
    }

    println!("PreBase shut down cleanly. Goodbye!");
    Ok(())
}

/// Percent-encode query parameter values according to RFC 3986 (unreserved characters preserved).
pub fn percent_encode_query_param(input: &str) -> String {
    let mut encoded = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => {
                encoded.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn test_cli_map_default_view_is_3d() {
        let args = CliArgs::try_parse_from(["prebase", "map"]).unwrap();
        match args.command {
            Some(Commands::Map { view, focus, .. }) => {
                assert_eq!(view, MapViewMode::ThreeD);
                assert_eq!(focus, None);
            }
            _ => panic!("Expected Commands::Map"),
        }
    }

    #[test]
    fn test_cli_map_explicit_3d_view() {
        let args = CliArgs::try_parse_from(["prebase", "map", "--view", "3d"]).unwrap();
        match args.command {
            Some(Commands::Map { view, focus, .. }) => {
                assert_eq!(view, MapViewMode::ThreeD);
                assert_eq!(focus, None);
            }
            _ => panic!("Expected Commands::Map"),
        }
    }

    #[test]
    fn test_cli_map_explicit_2d_view_parses() {
        let args = CliArgs::try_parse_from(["prebase", "map", "--view", "2d"]).unwrap();
        match args.command {
            Some(Commands::Map { view, focus, .. }) => {
                assert_eq!(view, MapViewMode::TwoD);
                assert_eq!(focus, None);
            }
            _ => panic!("Expected Commands::Map"),
        }
    }

    #[test]
    fn test_cli_map_2d_with_focus_parses() {
        let args =
            CliArgs::try_parse_from(["prebase", "map", "--view", "2d", "--focus", "src/index.ts"])
                .unwrap();
        match args.command {
            Some(Commands::Map { view, focus, .. }) => {
                assert_eq!(view, MapViewMode::TwoD);
                assert_eq!(focus, Some("src/index.ts".to_string()));
            }
            _ => panic!("Expected Commands::Map"),
        }
    }

    #[test]
    fn test_cli_map_focus_spaces_and_unicode() {
        let args = CliArgs::try_parse_from([
            "prebase",
            "map",
            "--view",
            "2d",
            "--focus",
            "src/my folder/file 🚀.ts",
        ])
        .unwrap();
        match args.command {
            Some(Commands::Map { view, focus, .. }) => {
                assert_eq!(view, MapViewMode::TwoD);
                assert_eq!(focus, Some("src/my folder/file 🚀.ts".to_string()));
            }
            _ => panic!("Expected Commands::Map"),
        }
    }

    #[test]
    fn test_cli_map_focus_preserves_leading_and_trailing_whitespace() {
        let raw_focus = "  src/ leading and trailing.ts  ";
        let args =
            CliArgs::try_parse_from(["prebase", "map", "--view", "2d", "--focus", raw_focus])
                .unwrap();
        match args.command {
            Some(Commands::Map { view, focus, .. }) => {
                assert_eq!(view, MapViewMode::TwoD);
                assert_eq!(focus, Some(raw_focus.to_string()));
                let encoded = percent_encode_query_param(focus.as_deref().unwrap());
                assert_eq!(encoded, "%20%20src%2F%20leading%20and%20trailing.ts%20%20");
            }
            _ => panic!("Expected Commands::Map"),
        }
    }

    #[test]
    fn test_cli_map_argument_ordering_with_path() {
        let args1 = CliArgs::try_parse_from(["prebase", "map", "src", "--view", "3d"]).unwrap();
        match args1.command {
            Some(Commands::Map { path, view, focus }) => {
                assert_eq!(path, Some(PathBuf::from("src")));
                assert_eq!(view, MapViewMode::ThreeD);
                assert_eq!(focus, None);
            }
            _ => panic!("Expected Commands::Map"),
        }

        let args2 = CliArgs::try_parse_from([
            "prebase",
            "map",
            "--view",
            "2d",
            "--focus",
            "src/app.ts",
            "my-repo",
        ])
        .unwrap();
        match args2.command {
            Some(Commands::Map { path, view, focus }) => {
                assert_eq!(path, Some(PathBuf::from("my-repo")));
                assert_eq!(view, MapViewMode::TwoD);
                assert_eq!(focus, Some("src/app.ts".to_string()));
            }
            _ => panic!("Expected Commands::Map"),
        }
    }

    #[test]
    fn test_percent_encode_query_param() {
        assert_eq!(percent_encode_query_param("src/index.ts"), "src%2Findex.ts");
        assert_eq!(percent_encode_query_param("hello world"), "hello%20world");
        assert_eq!(
            percent_encode_query_param("component-name_v1.0~alpha"),
            "component-name_v1.0~alpha"
        );
        assert_eq!(
            percent_encode_query_param("path/with spaces/and+symbols?"),
            "path%2Fwith%20spaces%2Fand%2Bsymbols%3F"
        );
    }
}
