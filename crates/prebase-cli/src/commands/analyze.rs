use serde::Serialize;
use std::collections::HashMap;
use std::io::IsTerminal;
use std::path::Path;

use prebase_core::insights::compute_architectural_insights;
use prebase_parser::RepositoryAnalyzer;

#[derive(Serialize)]
pub struct AnalyzeJsonOutput {
    pub repository: RepositoryMeta,
    pub summary: AnalyzeSummary,
    pub languages: Vec<LanguageStat>,
    pub areas: Vec<AreaStat>,
    pub entry_candidates: Vec<EntryCandidateStat>,
    pub cycle_count: usize,
}

#[derive(Serialize)]
pub struct RepositoryMeta {
    pub name: String,
    pub root: String,
}

#[derive(Serialize)]
pub struct AnalyzeSummary {
    pub discovered_files: usize,
    pub analyzed_files: usize,
    pub unsupported_files: usize,
    pub connections: usize,
    pub areas: usize,
    pub duration_ms: u128,
}

#[derive(Serialize)]
pub struct LanguageStat {
    pub language: String,
    pub file_count: usize,
}

#[derive(Serialize)]
pub struct AreaStat {
    pub id: String,
    pub file_count: usize,
}

#[derive(Serialize)]
pub struct EntryCandidateStat {
    pub file_path: String,
    pub reason: String,
}

pub fn run_analyze(
    canonical_root: &Path,
    repo_name: &str,
    json: bool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let analyzer = RepositoryAnalyzer::default();
    let result = analyzer
        .analyze_path(canonical_root)
        .map_err(|e| format!("Repository analysis failed: {e}"))?;

    let discovered_count = result.snapshot.nodes.len();
    let analyzed_count = result
        .snapshot
        .nodes
        .iter()
        .filter(|n| n.analysis_status == prebase_core::model::NodeAnalysisStatus::Analyzed)
        .count();
    let unsupported_count = discovered_count.saturating_sub(analyzed_count);
    let edge_count = result.snapshot.edges.len();

    // Group files by language
    let mut lang_counts: HashMap<String, usize> = HashMap::new();
    for node in &result.snapshot.nodes {
        if node.analysis_status == prebase_core::model::NodeAnalysisStatus::Analyzed {
            *lang_counts.entry(node.language.clone()).or_default() += 1;
        }
    }
    let mut languages: Vec<LanguageStat> = lang_counts
        .into_iter()
        .map(|(language, file_count)| LanguageStat {
            language,
            file_count,
        })
        .collect();
    languages.sort_by_key(|a| std::cmp::Reverse(a.file_count));

    // Group files by architectural area
    let mut area_counts: HashMap<String, usize> = HashMap::new();
    for node in &result.snapshot.nodes {
        let area_id = prebase_core::insights::get_area_id_for_path(&node.relative_path);
        *area_counts.entry(area_id).or_default() += 1;
    }
    let mut areas: Vec<AreaStat> = area_counts
        .into_iter()
        .map(|(id, file_count)| AreaStat { id, file_count })
        .collect();
    areas.sort_by_key(|a| std::cmp::Reverse(a.file_count));

    let insights = result.snapshot.insights.clone().unwrap_or_else(|| {
        compute_architectural_insights(
            &result.snapshot.nodes,
            &result.snapshot.edges,
            &result.snapshot.coverage,
            &result.snapshot.issues,
        )
    });

    let mut entry_candidates: Vec<EntryCandidateStat> = Vec::new();

    // 1. Rust crate roots and entry points
    for node in &result.snapshot.nodes {
        if node.relative_path.ends_with("/lib.rs") || node.relative_path == "src/lib.rs" {
            entry_candidates.push(EntryCandidateStat {
                file_path: node.relative_path.clone(),
                reason: "Library Crate Root".to_string(),
            });
        } else if node.relative_path.ends_with("/main.rs") || node.relative_path == "src/main.rs" {
            entry_candidates.push(EntryCandidateStat {
                file_path: node.relative_path.clone(),
                reason: "Binary Main Entrypoint".to_string(),
            });
        } else if node.relative_path.ends_with("/index.ts")
            || node.relative_path.ends_with("/index.tsx")
            || node.relative_path.ends_with("/main.tsx")
            || node.relative_path.ends_with("/App.tsx")
        {
            entry_candidates.push(EntryCandidateStat {
                file_path: node.relative_path.clone(),
                reason: "TypeScript Application / Module Entry".to_string(),
            });
        }
        if entry_candidates.len() >= 4 {
            break;
        }
    }

    // 2. Add top depended file if space
    for dep_file in &insights.highly_depended_files {
        if entry_candidates.len() >= 5 {
            break;
        }
        if !entry_candidates
            .iter()
            .any(|c| c.file_path == dep_file.file_id)
        {
            entry_candidates.push(EntryCandidateStat {
                file_path: dep_file.file_id.clone(),
                reason: format!(
                    "Core dependency imported by {} indexed files",
                    dep_file.dependent_count
                ),
            });
        }
    }

    let cycle_count = insights.cycle_groups.len();

    if json {
        let output = AnalyzeJsonOutput {
            repository: RepositoryMeta {
                name: repo_name.to_string(),
                root: canonical_root.display().to_string(),
            },
            summary: AnalyzeSummary {
                discovered_files: discovered_count,
                analyzed_files: analyzed_count,
                unsupported_files: unsupported_count,
                connections: edge_count,
                areas: areas.len(),
                duration_ms: result.duration_ms,
            },
            languages,
            areas,
            entry_candidates,
            cycle_count,
        };
        println!("{}", serde_json::to_string_pretty(&output)?);
        return Ok(());
    }

    let use_color = std::env::var("NO_COLOR").is_err() && std::io::stdout().is_terminal();
    let (bold, cyan, green, yellow, reset) = if use_color {
        ("\x1b[1m", "\x1b[36m", "\x1b[32m", "\x1b[33m", "\x1b[0m")
    } else {
        ("", "", "", "", "")
    };

    println!("{bold}PreBase Repository Intelligence{reset}");
    println!(
        "Repository: {bold}{repo_name}{reset} ({})",
        canonical_root.display()
    );
    println!();
    println!("{cyan}Summary:{reset}");
    println!("  Discovered Files:    {bold}{discovered_count}{reset}");
    println!("  Analyzed Sources:    {bold}{analyzed_count}{reset}");
    if unsupported_count > 0 {
        println!("  Unsupported Files:   {unsupported_count} (docs, media, binary, or non-indexed configs)");
    }
    println!("  Confirmed Links:     {bold}{edge_count}{reset} internal dependency edges");
    println!("  Architectural Areas: {bold}{}{reset}", areas.len());
    if cycle_count > 0 {
        println!("  Dependency Cycles:   {yellow}{cycle_count} detected{reset}");
    }
    println!("  Analysis Time:       {}ms", result.duration_ms);
    println!();

    if !languages.is_empty() {
        println!("{cyan}Languages:{reset}");
        for lang in &languages {
            println!("  {:<18} {:>5} files", lang.language, lang.file_count);
        }
        println!();
    }

    if !areas.is_empty() {
        println!(
            "{cyan}Architectural Areas (Top 10 of {}):{reset}",
            areas.len()
        );
        for area in areas.iter().take(10) {
            println!("  {:<26} {:>4} files", area.id, area.file_count);
        }
        if areas.len() > 10 {
            println!("  ... and {} more areas", areas.len() - 10);
        }
        println!();
    }

    if !entry_candidates.is_empty() {
        println!("{cyan}Suggested Starting Points:{reset}");
        for cand in &entry_candidates {
            println!(
                "  {green}→{reset} {bold}{}{reset} ({})",
                cand.file_path, cand.reason
            );
        }
        println!();
    }

    Ok(())
}
