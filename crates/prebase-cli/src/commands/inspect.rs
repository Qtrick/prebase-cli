use serde::Serialize;
use std::io::IsTerminal;
use std::path::Path;

use prebase_core::is_safe_relative_path;
use prebase_parser::RepositoryAnalyzer;

#[derive(Serialize)]
pub struct InspectJsonOutput {
    pub file: FileDetail,
    pub area_id: String,
    pub dependencies: Vec<DependencyDetail>,
    pub dependents: Vec<DependentDetail>,
    pub is_in_cycle: bool,
}

#[derive(Serialize)]
pub struct FileDetail {
    pub path: String,
    pub filename: String,
    pub language: String,
    pub size_bytes: u64,
    pub status: String,
}

#[derive(Serialize)]
pub struct DependencyDetail {
    pub path: String,
    pub kind: String,
}

#[derive(Serialize)]
pub struct DependentDetail {
    pub path: String,
    pub kind: String,
}

pub fn run_inspect(
    canonical_root: &Path,
    target_arg: &str,
    json: bool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let clean_target = target_arg.trim().replace('\\', "/");
    let trimmed = clean_target.trim_start_matches("./");

    let analyzer = RepositoryAnalyzer::default();
    let result = analyzer
        .analyze_path(canonical_root)
        .map_err(|e| format!("Repository analysis failed: {e}"))?;

    // Find node: exact path match first
    let exact_match = result
        .snapshot
        .nodes
        .iter()
        .find(|n| n.relative_path == trimmed || n.id == trimmed);

    let node = if let Some(n) = exact_match {
        n
    } else {
        // Disambiguate by basename or partial suffix
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
            eprintln!("Error: Ambiguous file query '{target_arg}'. Multiple matches found:");
            for m in &matches {
                eprintln!("  • {}", m.relative_path);
            }
            eprintln!("Please specify the full relative path.");
            std::process::exit(1);
        } else {
            matches[0]
        }
    };

    // Safe path guard
    if !is_safe_relative_path(&node.relative_path) {
        eprintln!("Error: File path is unsafe or escapes repository root.");
        std::process::exit(1);
    }

    let area_id = prebase_core::insights::get_area_id_for_path(&node.relative_path);

    // Get outgoing dependencies and incoming dependents from snapshot edges
    let mut dependencies: Vec<DependencyDetail> = Vec::new();
    let mut dependents: Vec<DependentDetail> = Vec::new();

    for edge in &result.snapshot.edges {
        if edge.resolution_status == prebase_core::model::ResolutionStatus::ResolvedInternal {
            if edge.source_file_id == node.id {
                dependencies.push(DependencyDetail {
                    path: edge.target_file_id.clone(),
                    kind: format!("{:?}", edge.relationship_kind),
                });
            } else if edge.target_file_id == node.id {
                dependents.push(DependentDetail {
                    path: edge.source_file_id.clone(),
                    kind: format!("{:?}", edge.relationship_kind),
                });
            }
        }
    }

    dependencies.sort_by(|a, b| a.path.cmp(&b.path));
    dependents.sort_by(|a, b| a.path.cmp(&b.path));

    let is_in_cycle = result
        .snapshot
        .insights
        .as_ref()
        .map(|ins| ins.cycle_groups.iter().any(|c| c.files.contains(&node.id)))
        .unwrap_or(false);

    if json {
        let output = InspectJsonOutput {
            file: FileDetail {
                path: node.relative_path.clone(),
                filename: node.filename.clone(),
                language: node.language.clone(),
                size_bytes: node.size_bytes,
                status: format!("{:?}", node.analysis_status),
            },
            area_id,
            dependencies,
            dependents,
            is_in_cycle,
        };
        println!("{}", serde_json::to_string_pretty(&output)?);
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

    println!(
        "{cyan}File:{reset}             {bold}{}{reset}",
        node.relative_path
    );
    println!("{gray}{}{reset}", "─".repeat(50));
    println!("  {cyan}Area:{reset}         {bold}{area_id}{reset}");
    println!("  {cyan}Language:{reset}     {}", node.language);
    println!("  {cyan}Size:{reset}         {} bytes", node.size_bytes);
    println!("  {cyan}Status:{reset}       {:?}", node.analysis_status);
    if is_in_cycle {
        println!("  {yellow}⚠ Part of a dependency cycle group{reset}");
    }
    println!();

    println!(
        "{cyan}Direct Dependencies ({}) — files this module imports:{reset}",
        dependencies.len()
    );
    if dependencies.is_empty() {
        println!("  {gray}(none){reset}");
    } else {
        for dep in &dependencies {
            let kind_badge = if dep.kind == "TypeOnly" {
                format!("{gray}[type]{reset}")
            } else {
                String::new()
            };
            println!("  {green}→{reset} {:<45} {kind_badge}", dep.path);
        }
    }
    println!();

    println!(
        "{cyan}Direct Dependents ({}) — files importing this module:{reset}",
        dependents.len()
    );
    if dependents.is_empty() {
        println!("  {gray}(none){reset}");
    } else {
        for dep in &dependents {
            let kind_badge = if dep.kind == "TypeOnly" {
                format!("{gray}[type]{reset}")
            } else {
                String::new()
            };
            println!("  {green}←{reset} {:<45} {kind_badge}", dep.path);
        }
    }

    Ok(())
}
