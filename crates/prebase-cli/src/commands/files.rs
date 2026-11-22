use serde::Serialize;
use std::io::IsTerminal;
use std::path::Path;

use prebase_parser::RepositoryAnalyzer;

#[derive(Serialize)]
pub struct FileListEntry {
    pub path: String,
    pub language: String,
    pub status: String,
    pub size_bytes: u64,
}

pub fn run_files(
    canonical_root: &Path,
    language_filter: Option<&str>,
    json: bool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let analyzer = RepositoryAnalyzer::default();
    let result = analyzer
        .analyze_path(canonical_root)
        .map_err(|e| format!("Repository analysis failed: {e}"))?;

    let filter_lower = language_filter.map(|l| l.to_lowercase());

    let mut filtered_nodes: Vec<&prebase_core::model::FileNode> = result
        .snapshot
        .nodes
        .iter()
        .filter(|n| {
            if let Some(target_lang) = &filter_lower {
                n.language.to_lowercase() == *target_lang
            } else {
                true
            }
        })
        .collect();

    filtered_nodes.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));

    if json {
        let entries: Vec<FileListEntry> = filtered_nodes
            .iter()
            .map(|n| FileListEntry {
                path: n.relative_path.clone(),
                language: n.language.clone(),
                status: format!("{:?}", n.analysis_status),
                size_bytes: n.size_bytes,
            })
            .collect();
        println!("{}", serde_json::to_string_pretty(&entries)?);
        return Ok(());
    }

    let use_color = std::env::var("NO_COLOR").is_err() && std::io::stdout().is_terminal();
    let (cyan, gray, reset) = if use_color {
        ("\x1b[36m", "\x1b[90m", "\x1b[0m")
    } else {
        ("", "", "")
    };

    if filtered_nodes.is_empty() {
        if let Some(lang) = language_filter {
            println!("No files matched language filter '{lang}'.");
        } else {
            println!("No files discovered in repository.");
        }
        return Ok(());
    }

    let count = filtered_nodes.len();
    if let Some(lang) = language_filter {
        eprintln!("{gray}[{count} files matching language '{lang}']{reset}");
    } else {
        eprintln!("{gray}[{count} repository files]{reset}");
    }

    for node in filtered_nodes {
        let status_desc =
            if node.analysis_status == prebase_core::model::NodeAnalysisStatus::Analyzed {
                ""
            } else {
                " (unsupported)"
            };
        println!(
            "{:<50} {cyan}{:<12}{reset} {gray}{:7}B{reset}{status_desc}",
            node.relative_path, node.language, node.size_bytes
        );
    }

    Ok(())
}
