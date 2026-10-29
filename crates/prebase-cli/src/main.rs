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
    about = "PreBase CLI — Local-first Codebase Intelligence & Interactive Network Graph",
    long_about = "PreBase is a local-first codebase intelligence application that analyzes repository\nstructure and renders an interactive, dependency-aware Network Graph in your local browser."
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
    /// Inspect Git history and historical changes (Temporal Graph — Planned for Phase 2)
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
        Some(Commands::Map { path: Some(p) }) => p.clone(),
        Some(Commands::History { path: Some(p) }) => {
            println!("\x1b[33mNote:\x1b[0m Temporal Graph is scheduled for Prompt 2. Launching PreBase Network view.\n");
            p.clone()
        }
        Some(Commands::History { path: None }) => {
            println!("\x1b[33mNote:\x1b[0m Temporal Graph is scheduled for Prompt 2. Launching PreBase Network view.\n");
            args.path.clone().unwrap_or_else(|| PathBuf::from("."))
        }
        _ => args.path.clone().unwrap_or_else(|| PathBuf::from(".")),
    };

    println!("\x1b[1;36mPreBase CLI v0.1.0\x1b[0m — Codebase Intelligence");

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

    // 2. Start local Axum server
    let server = start_server(
        canonical_root.clone(),
        repo_name.clone(),
        repo_id.clone(),
        args.port,
    )
    .await?;

    let url = format!(
        "http://127.0.0.1:{}/?token={}",
        server.port, server.session_token
    );

    println!(
        "\x1b[32m✔\x1b[0m Server running at: \x1b[4;34m{}\x1b[0m",
        url
    );

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
        let analyzer = RepositoryAnalyzer::default();
        match tokio::task::spawn_blocking(move || analyzer.analyze_path(&root_clone)).await {
            Ok(Ok(result)) => {
                let duration = start.elapsed().as_millis();
                println!(
                    "\x1b[32m✔\x1b[0m Indexed \x1b[1m{}\x1b[0m files with \x1b[1m{}\x1b[0m confirmed relationships in {}ms",
                    result.snapshot.nodes.len(),
                    result.snapshot.edges.len(),
                    duration
                );
                state_clone.set_ready(result.snapshot, result.index);
            }
            Ok(Err(err)) => {
                error!("Repository analysis failed: {err}");
                eprintln!("\x1b[31m✖\x1b[0m Repository analysis failed: {err}");
                state_clone.set_failed(&err);
            }
            Err(join_err) => {
                error!("Analysis task panicked: {join_err}");
                state_clone.set_failed("Analysis task panicked");
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
