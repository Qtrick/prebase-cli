use std::io::IsTerminal;
use std::path::Path;

use prebase_core::model::{DependencyPathResult, PathDirection};
use prebase_core::{find_dependency_path, is_safe_relative_path};
use prebase_parser::RepositoryAnalyzer;

pub fn run_path(
    canonical_root: &Path,
    from_arg: &str,
    to_arg: &str,
    json: bool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let clean_from = from_arg.trim().replace('\\', "/");
    let from_trimmed = clean_from.trim_start_matches("./");

    let clean_to = to_arg.trim().replace('\\', "/");
    let to_trimmed = clean_to.trim_start_matches("./");

    let analyzer = RepositoryAnalyzer::default();
    let result = analyzer
        .analyze_path(canonical_root)
        .map_err(|e| format!("Repository analysis failed: {e}"))?;

    let resolve_id = |arg: &str| -> Option<String> {
        if let Some(n) = result
            .snapshot
            .nodes
            .iter()
            .find(|n| n.relative_path == arg || n.id == arg)
        {
            return Some(n.id.clone());
        }
        let matches: Vec<&prebase_core::model::FileNode> = result
            .snapshot
            .nodes
            .iter()
            .filter(|n| n.filename == arg || n.relative_path.ends_with(arg))
            .collect();
        if matches.len() == 1 {
            Some(matches[0].id.clone())
        } else {
            None
        }
    };

    let from_id = match resolve_id(from_trimmed) {
        Some(id) => id,
        None => {
            eprintln!("Error: Starting file '{from_arg}' could not be resolved.");
            std::process::exit(1);
        }
    };

    let to_id = match resolve_id(to_trimmed) {
        Some(id) => id,
        None => {
            eprintln!("Error: Target file '{to_arg}' could not be resolved.");
            std::process::exit(1);
        }
    };

    if !is_safe_relative_path(&from_id) || !is_safe_relative_path(&to_id) {
        eprintln!("Error: Path traversal outside repository boundaries is forbidden.");
        std::process::exit(1);
    }

    let path_result = find_dependency_path(
        &result.index,
        &from_id,
        &to_id,
        PathDirection::Outgoing,
        true,
    );

    if json {
        match &path_result {
            DependencyPathResult::Found(path) => {
                #[derive(serde::Serialize)]
                struct PathSuccessJson<'a> {
                    status: &'static str,
                    found: bool,
                    length: usize,
                    hops: usize,
                    nodes: &'a [String],
                    edges: &'a [prebase_core::model::DependencyEdge],
                    path: &'a prebase_core::model::DependencyPath,
                }
                let out = PathSuccessJson {
                    status: "found",
                    found: true,
                    length: path.hops,
                    hops: path.hops,
                    nodes: &path.nodes,
                    edges: &path.edges,
                    path,
                };
                println!("{}", serde_json::to_string_pretty(&out)?);
            }
            DependencyPathResult::NotFound => {
                #[derive(serde::Serialize)]
                struct PathNotFoundJson {
                    status: &'static str,
                    found: bool,
                    length: usize,
                    hops: usize,
                    nodes: Vec<String>,
                }
                let out = PathNotFoundJson {
                    status: "not_found",
                    found: false,
                    length: 0,
                    hops: 0,
                    nodes: Vec::new(),
                };
                println!("{}", serde_json::to_string_pretty(&out)?);
            }
            _ => {
                println!("{}", serde_json::to_string_pretty(&path_result)?);
            }
        }
        return Ok(());
    }

    let use_color = std::env::var("NO_COLOR").is_err() && std::io::stdout().is_terminal();
    let (bold, cyan, gray, green, yellow, reset) = if use_color {
        (
            "\x1b[1m", "\x1b[36m", "\x1b[90m", "\x1b[32m", "\x1b[33m", "\x1b[0m",
        )
    } else {
        ("", "", "", "", "", "")
    };

    match &path_result {
        DependencyPathResult::Found(path) => {
            println!(
                "{bold}Dependency Path Found{reset} ({cyan}{} hop(s){reset}):",
                path.hops
            );
            println!();
            for (idx, node_id) in path.nodes.iter().enumerate() {
                if idx == 0 {
                    println!("  {green}●{reset} {bold}{node_id}{reset} {gray}(start){reset}");
                } else {
                    let edge = &path.edges[idx - 1];
                    let kind_str = format!("{:?}", edge.relationship_kind);
                    println!("  {gray}│ [{kind_str}]{reset}");
                    if idx == path.nodes.len() - 1 {
                        println!("  {cyan}▼{reset} {bold}{node_id}{reset} {gray}(target){reset}");
                    } else {
                        println!("  {cyan}▼{reset} {node_id}");
                    }
                }
            }
        }
        DependencyPathResult::SameFile { file_id, .. } => {
            println!("{yellow}Start and target are the same file:{reset} {file_id}");
        }
        DependencyPathResult::NotFound => {
            println!("{yellow}No dependency path exists{reset} from '{from_id}' to '{to_id}'.");
            std::process::exit(1);
        }
        DependencyPathResult::MissingEndpoint(missing) => {
            eprintln!("Error: Endpoint not indexed in graph: '{missing}'.");
            std::process::exit(1);
        }
    }

    Ok(())
}
