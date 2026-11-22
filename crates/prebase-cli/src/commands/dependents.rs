use serde::Serialize;
use std::collections::{HashSet, VecDeque};
use std::io::IsTerminal;
use std::path::Path;

use prebase_core::is_safe_relative_path;
use prebase_parser::RepositoryAnalyzer;

#[derive(Serialize)]
pub struct DependentItem {
    pub path: String,
    pub depth: usize,
    pub kind: String,
}

#[derive(Serialize)]
pub struct DependentsJsonOutput {
    pub target: String,
    pub transitive: bool,
    pub dependents: Vec<DependentItem>,
}

pub fn run_dependents(
    canonical_root: &Path,
    target_arg: &str,
    transitive: bool,
    max_depth: Option<usize>,
    json: bool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let clean_target = target_arg.trim().replace('\\', "/");
    let trimmed = clean_target.trim_start_matches("./");

    let analyzer = RepositoryAnalyzer::default();
    let result = analyzer
        .analyze_path(canonical_root)
        .map_err(|e| format!("Repository analysis failed: {e}"))?;

    let exact_match = result
        .snapshot
        .nodes
        .iter()
        .find(|n| n.relative_path == trimmed || n.id == trimmed);

    let node = if let Some(n) = exact_match {
        n
    } else {
        let matches: Vec<&prebase_core::model::FileNode> = result
            .snapshot
            .nodes
            .iter()
            .filter(|n| n.filename == trimmed || n.relative_path.ends_with(trimmed))
            .collect();

        if matches.is_empty() {
            eprintln!("Error: File '{target_arg}' not found in repository index.");
            std::process::exit(1);
        } else if matches.len() > 1 {
            eprintln!("Error: Ambiguous file query '{target_arg}'. Matches:");
            for m in &matches {
                eprintln!("  • {}", m.relative_path);
            }
            std::process::exit(1);
        } else {
            matches[0]
        }
    };

    if !is_safe_relative_path(&node.relative_path) {
        eprintln!("Error: File path is unsafe or escapes repository root.");
        std::process::exit(1);
    }

    let limit_depth = if !transitive {
        1
    } else {
        max_depth.unwrap_or(usize::MAX)
    };

    // BFS backward along edges: target <- source (who imports target?)
    let mut visited: HashSet<String> = HashSet::new();
    let mut queue: VecDeque<(String, usize)> = VecDeque::new();
    visited.insert(node.id.clone());
    queue.push_back((node.id.clone(), 0));

    let mut dependents: Vec<DependentItem> = Vec::new();

    while let Some((curr_id, curr_depth)) = queue.pop_front() {
        if curr_depth >= limit_depth {
            continue;
        }

        for edge in &result.snapshot.edges {
            if edge.resolution_status == prebase_core::model::ResolutionStatus::ResolvedInternal
                && edge.target_file_id == curr_id
            {
                let source_id = &edge.source_file_id;
                let is_new = visited.insert(source_id.clone());
                if is_new {
                    dependents.push(DependentItem {
                        path: source_id.clone(),
                        depth: curr_depth + 1,
                        kind: format!("{:?}", edge.relationship_kind),
                    });
                    queue.push_back((source_id.clone(), curr_depth + 1));
                }
            }
        }
    }

    dependents.sort_by(|a, b| a.depth.cmp(&b.depth).then_with(|| a.path.cmp(&b.path)));

    if json {
        let output = DependentsJsonOutput {
            target: node.relative_path.clone(),
            transitive,
            dependents,
        };
        println!("{}", serde_json::to_string_pretty(&output)?);
        return Ok(());
    }

    let use_color = std::env::var("NO_COLOR").is_err() && std::io::stdout().is_terminal();
    let (bold, cyan, gray, green, reset) = if use_color {
        ("\x1b[1m", "\x1b[36m", "\x1b[90m", "\x1b[32m", "\x1b[0m")
    } else {
        ("", "", "", "", "")
    };

    let mode_str = if transitive {
        "Transitive Dependents"
    } else {
        "Direct Dependents"
    };
    println!(
        "{bold}{}{reset} — {cyan}{mode_str}{reset} ({})",
        node.relative_path,
        dependents.len()
    );

    if dependents.is_empty() {
        println!("  {gray}(none){reset}");
    } else {
        for dep in dependents {
            let indent = "  ".repeat(dep.depth);
            let depth_badge = if transitive {
                format!("{gray}[L{}]{reset} ", dep.depth)
            } else {
                String::new()
            };
            println!("{indent}{green}←{reset} {depth_badge}{}", dep.path);
        }
    }

    Ok(())
}
