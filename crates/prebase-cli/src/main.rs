use clap::{Parser, Subcommand};
use std::path::PathBuf;

use prebase_core::scanner::RepositoryScanner;

mod commands;

use commands::analyze::run_analyze;
use commands::daemon::{run_status, run_stop};
use commands::dependents::run_dependents;
use commands::deps::run_deps;
use commands::files::run_files;
use commands::history::run_history_text;
use commands::inspect::run_inspect;
use commands::path::run_path;
use commands::search::run_search;
use commands::server::run_server;

#[derive(Parser, Debug)]
#[command(
    name = "prebase",
    author = "PreBase Contributors",
    version = env!("CARGO_PKG_VERSION"),
    about = "PreBase CLI — Local-first Codebase Intelligence & Interactive Network/Temporal Graphs",
    long_about = "PreBase CLI — Local-first Codebase Intelligence & Interactive Network/Temporal Graphs\n\nPreBase is a local-first codebase intelligence tool that analyzes repository\nstructure, confirmed dependency relationships, and Git history both in the terminal\nand in your local browser."
)]
pub struct CliArgs {
    /// Target repository path to analyze (defaults to current directory)
    #[arg(value_name = "PATH", global = true)]
    pub path: Option<PathBuf>,

    /// Output results as structured machine-readable JSON
    #[arg(long, global = true)]
    pub json: bool,

    /// Specific port to bind the local server to (defaults to random available port)
    #[arg(long, value_name = "PORT", global = true)]
    pub port: Option<u16>,

    /// Do not automatically open the default web browser
    #[arg(long, global = true)]
    pub no_open: bool,

    /// Disable live filesystem watching and graph synchronization
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

impl MapViewMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            MapViewMode::ThreeD => "3d",
            MapViewMode::TwoD => "2d",
        }
    }
}

#[derive(Subcommand, Debug, Clone, PartialEq, Eq)]
pub enum Commands {
    /// Launch the interactive Network Graph web interface
    Map {
        #[arg(value_name = "PATH")]
        path: Option<PathBuf>,

        /// View mode for the network graph (3d or 2d)
        #[arg(long, value_enum, default_value = "3d")]
        view: MapViewMode,

        /// Relative file path to focus in the relationship view or 3D graph
        #[arg(long, value_name = "RELATIVE_PATH")]
        focus: Option<String>,

        /// Run the web server in the background and return control to the shell
        #[arg(long)]
        detach: bool,
    },
    /// Inspect Git commit history, ancestry DAG, and changed files
    History {
        #[arg(value_name = "PATH")]
        path: Option<PathBuf>,

        /// Print commit history directly in the terminal without launching a browser
        #[arg(long)]
        text: bool,

        /// Limit the number of commits displayed in terminal history
        #[arg(long, value_name = "COUNT")]
        limit: Option<usize>,
    },
    /// One-shot repository architecture analysis, language stats, and key areas
    Analyze {
        #[arg(value_name = "PATH")]
        path: Option<PathBuf>,
    },
    /// List discovered and analyzed repository files
    Files {
        #[arg(value_name = "PATH")]
        path: Option<PathBuf>,

        /// Filter files by programming language (e.g. rust, typescript, python)
        #[arg(long, value_name = "LANG")]
        language: Option<String>,
    },
    /// Search files by filename or relative path
    Search {
        /// Search keyword or substring
        #[arg(value_name = "QUERY")]
        query: String,

        #[arg(value_name = "PATH")]
        path: Option<PathBuf>,
    },
    /// Inspect detailed file intelligence, dependencies, dependents, and area
    Inspect {
        /// Relative file path to inspect (e.g. src/main.rs)
        #[arg(value_name = "FILE")]
        file: String,

        #[arg(value_name = "PATH")]
        path: Option<PathBuf>,
    },
    /// List outgoing dependencies (files imported by the target module)
    Deps {
        /// Target file path
        #[arg(value_name = "FILE")]
        file: String,

        #[arg(value_name = "PATH")]
        path: Option<PathBuf>,

        /// Recursively traverse transitive dependencies
        #[arg(long)]
        transitive: bool,

        /// Maximum depth for transitive dependency traversal
        #[arg(long, value_name = "DEPTH")]
        depth: Option<usize>,
    },
    /// List incoming dependents (files that import the target module)
    Dependents {
        /// Target file path
        #[arg(value_name = "FILE")]
        file: String,

        #[arg(value_name = "PATH")]
        path: Option<PathBuf>,

        /// Recursively traverse transitive callers / dependents
        #[arg(long)]
        transitive: bool,

        /// Maximum depth for transitive dependent traversal
        #[arg(long, value_name = "DEPTH")]
        depth: Option<usize>,
    },
    /// Find the shortest directed dependency path between two files
    Path {
        /// Starting file path
        #[arg(value_name = "FROM_FILE")]
        from: String,

        /// Target file path
        #[arg(value_name = "TO_FILE")]
        to: String,

        #[arg(value_name = "PATH")]
        path: Option<PathBuf>,
    },
    /// Check the status of a background PreBase web server
    Status {
        #[arg(value_name = "PATH")]
        path: Option<PathBuf>,
    },
    /// Stop an active background PreBase web server
    Stop {
        #[arg(value_name = "PATH")]
        path: Option<PathBuf>,
    },
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let args = CliArgs::parse();

    let target_path = match &args.command {
        Some(Commands::Map { path: Some(p), .. })
        | Some(Commands::History { path: Some(p), .. })
        | Some(Commands::Analyze { path: Some(p) })
        | Some(Commands::Files { path: Some(p), .. })
        | Some(Commands::Search { path: Some(p), .. })
        | Some(Commands::Inspect { path: Some(p), .. })
        | Some(Commands::Deps { path: Some(p), .. })
        | Some(Commands::Dependents { path: Some(p), .. })
        | Some(Commands::Path { path: Some(p), .. })
        | Some(Commands::Status { path: Some(p) })
        | Some(Commands::Stop { path: Some(p) }) => p.clone(),
        _ => args.path.clone().unwrap_or_else(|| PathBuf::from(".")),
    };

    let canonical_root = match RepositoryScanner::discover_root(&target_path) {
        Ok(root) => root,
        Err(err) => {
            eprintln!(
                "Error: Could not locate repository at '{}': {}",
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

    match args.command {
        Some(Commands::Analyze { .. }) => {
            run_analyze(&canonical_root, &repo_name, args.json)?;
        }
        Some(Commands::Files { language, .. }) => {
            run_files(&canonical_root, language.as_deref(), args.json)?;
        }
        Some(Commands::Search { query, .. }) => {
            run_search(&canonical_root, &query, args.json)?;
        }
        Some(Commands::Inspect { file, .. }) => {
            run_inspect(&canonical_root, &file, args.json)?;
        }
        Some(Commands::Deps {
            file,
            transitive,
            depth,
            ..
        }) => {
            run_deps(&canonical_root, &file, transitive, depth, args.json)?;
        }
        Some(Commands::Dependents {
            file,
            transitive,
            depth,
            ..
        }) => {
            run_dependents(&canonical_root, &file, transitive, depth, args.json)?;
        }
        Some(Commands::Path { from, to, .. }) => {
            run_path(&canonical_root, &from, &to, args.json)?;
        }
        Some(Commands::History { text, limit, .. }) => {
            if text || args.json {
                run_history_text(&canonical_root, limit, args.json)?;
            } else {
                run_server(
                    canonical_root,
                    repo_name,
                    repo_id,
                    args.port,
                    args.no_open,
                    args.no_watch,
                    false,
                    "temporal",
                    None,
                )
                .await?;
            }
        }
        Some(Commands::Status { .. }) => {
            run_status(&canonical_root, args.json)?;
        }
        Some(Commands::Stop { .. }) => {
            run_stop(&canonical_root, args.json)?;
        }
        Some(Commands::Map {
            view,
            focus,
            detach,
            ..
        }) => {
            run_server(
                canonical_root,
                repo_name,
                repo_id,
                args.port,
                args.no_open,
                args.no_watch,
                detach,
                view.as_str(),
                focus,
            )
            .await?;
        }
        None => {
            // Default: launch interactive 3D map
            run_server(
                canonical_root,
                repo_name,
                repo_id,
                args.port,
                args.no_open,
                args.no_watch,
                false,
                "3d",
                None,
            )
            .await?;
        }
    }

    Ok(())
}
