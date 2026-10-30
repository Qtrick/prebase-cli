use clap::{Parser, Subcommand};
use std::path::PathBuf;
use std::time::Instant;
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

#[derive(Subcommand, Debug, Clone, PartialEq, Eq)]
pub enum Commands {
    /// Open repository directly into the interactive Network Graph
    Map {
        #[arg(value_name = "PATH")]
        path: Option<PathBuf>,
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

    let is_history_command = matches!(args.command, Some(Commands::History { .. }));

    let target_path = match &args.command {
        Some(Commands::Map { path: Some(p) }) => p.clone(),
        Some(Commands::History { path: Some(p) }) => p.clone(),
        Some(Commands::History { path: None }) => {
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
    let server = start_server(
        canonical_root.clone(),
        repo_name.clone(),
        repo_id.clone(),
        args.port,
        watch_filesystem,
    )
    .await?;

    let default_view = if is_history_command {
        "temporal"
    } else {
        "network"
    };

    let url = format!(
        "http://127.0.0.1:{}/?bootstrap={}&view={}",
        server.port, server.bootstrap_token, default_view
    );

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

    tokio::spawn(async move {
        println!("  Indexing source files...");
        let start = Instant::now();
        let initial_gen = state_clone.get_next_generation();
        let analyzer = RepositoryAnalyzer::default();
        match tokio::task::spawn_blocking(move || analyzer.analyze_path(&root_clone)).await {
            Ok(Ok(result)) => {
                let duration = start.elapsed().as_millis();
                let node_count = result.snapshot.nodes.len();
                let edge_count = result.snapshot.edges.len();
                let publish_res = state_clone.publish_network(
                    result.snapshot,
                    result.index,
                    vec![],
                    Some(initial_gen),
                );
                if publish_res.is_ok() {
                    println!(
                        "\x1b[32m✔\x1b[0m Indexed \x1b[1m{}\x1b[0m files with \x1b[1m{}\x1b[0m confirmed relationships in {}ms",
                        node_count,
                        edge_count,
                        duration
                    );
                }
            }
            Ok(Err(err)) => {
                error!("Repository analysis failed: {err}");
                eprintln!("\x1b[31m✖\x1b[0m Repository analysis failed: {err}");
                if state_clone.current_generation() == initial_gen {
                    state_clone.set_failed(&err);
                }
            }
            Err(join_err) => {
                error!("Analysis task panicked: {join_err}");
                if state_clone.current_generation() == initial_gen {
                    state_clone.set_failed("Analysis task panicked");
                }
            }
        }
    });

    println!("\nPress \x1b[1mCtrl+C\x1b[0m to shut down PreBase cleanly.\n");

    // 5. Graceful shutdown on Ctrl+C
    tokio::signal::ctrl_c().await?;
    println!("\nReceived shutdown signal. Stopping PreBase server...");

    let _ = server.shutdown_tx.send(());
    let _ = server.server_handle.await;

    println!("PreBase shut down cleanly. Goodbye!");
    Ok(())
}
