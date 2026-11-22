use serde::Serialize;
use std::io::IsTerminal;
use std::path::Path;

use prebase_parser::RepositoryAnalyzer;

#[derive(Serialize)]
pub struct SearchResultEntry {
    pub path: String,
    pub filename: String,
    pub language: String,
    pub dependencies: usize,
    pub dependents: usize,
    pub score: i32,
}

pub fn run_search(
    canonical_root: &Path,
    query: &str,
    json: bool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let q = query.trim();
    if q.is_empty() {
        eprintln!("Error: Search query cannot be empty");
        std::process::exit(1);
    }

    let analyzer = RepositoryAnalyzer::default();
    let result = analyzer
        .analyze_path(canonical_root)
        .map_err(|e| format!("Repository analysis failed: {e}"))?;

    let q_lower = q.to_lowercase();
    let mut matches: Vec<SearchResultEntry> = Vec::new();

    for node in &result.snapshot.nodes {
        let fn_lower = node.filename.to_lowercase();
        let path_lower = node.relative_path.to_lowercase();

        let score = if fn_lower == q_lower {
            100 // exact filename match
        } else if fn_lower.starts_with(&q_lower) {
            80 // filename prefix match
        } else if fn_lower.contains(&q_lower) {
            60 // filename substring match
        } else if path_lower.contains(&q_lower) {
            40 // path substring match
        } else {
            0
        };

        if score > 0 {
            matches.push(SearchResultEntry {
                path: node.relative_path.clone(),
                filename: node.filename.clone(),
                language: node.language.clone(),
                dependencies: node.direct_dependency_count,
                dependents: node.direct_dependent_count,
                score,
            });
        }
    }

    // Rank by score descending, then path ascending
    matches.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.path.cmp(&b.path)));

    if json {
        println!("{}", serde_json::to_string_pretty(&matches)?);
        return Ok(());
    }

    let use_color = std::env::var("NO_COLOR").is_err() && std::io::stdout().is_terminal();
    let (bold, cyan, gray, green, reset) = if use_color {
        ("\x1b[1m", "\x1b[36m", "\x1b[90m", "\x1b[32m", "\x1b[0m")
    } else {
        ("", "", "", "", "")
    };

    if matches.is_empty() {
        println!("No files matched query '{query}'.");
        return Ok(());
    }

    let count = matches.len();
    eprintln!("{gray}[Found {count} matching file(s) for '{query}']{reset}");

    for entry in matches {
        println!(
            "{green}→{reset} {bold}{:<46}{reset} {cyan}{:<12}{reset} {gray}deps: {:<3} callers: {:<3}{reset}",
            entry.path, entry.language, entry.dependencies, entry.dependents
        );
    }

    Ok(())
}
