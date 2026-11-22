use serde::Serialize;
use std::io::IsTerminal;
use std::path::Path;

use prebase_git::{GitEngine, GitError};

#[derive(Serialize)]
pub struct CommitCliEntry {
    pub hash: String,
    pub short_hash: String,
    pub author_name: String,
    pub author_email: String,
    pub timestamp: i64,
    pub summary: String,
}

#[derive(Serialize)]
pub struct HistoryJsonOutput {
    pub branch: String,
    pub is_clean: bool,
    pub total_commits: usize,
    pub commits: Vec<CommitCliEntry>,
}

pub fn run_history_text(
    canonical_root: &Path,
    limit: Option<usize>,
    json: bool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if !canonical_root.join(".git").exists() {
        eprintln!(
            "Error: '{}' is not a Git repository.",
            canonical_root.display()
        );
        std::process::exit(1);
    }

    let git = GitEngine::new(canonical_root.to_path_buf());

    let status = match git.get_status() {
        Ok(s) => {
            if !s.is_git_repo {
                eprintln!(
                    "Error: '{}' is not a Git repository.",
                    canonical_root.display()
                );
                std::process::exit(1);
            }
            s
        }
        Err(GitError::NotAGitRepository(_)) => {
            eprintln!(
                "Error: '{}' is not a Git repository.",
                canonical_root.display()
            );
            std::process::exit(1);
        }
        Err(e) => {
            eprintln!("Error checking git status: {e}");
            std::process::exit(1);
        }
    };

    let page_size = limit.unwrap_or(30).clamp(1, 500);
    let page = git
        .get_history(page_size, None)
        .map_err(|e| format!("Failed to read git history: {e}"))?;

    let entries: Vec<CommitCliEntry> = page
        .commits
        .iter()
        .map(|c| CommitCliEntry {
            hash: c.hash.clone(),
            short_hash: if c.hash.len() >= 7 {
                c.hash[..7].to_string()
            } else {
                c.hash.clone()
            },
            author_name: c.author_name.clone(),
            author_email: c.author_email.clone(),
            timestamp: c.author_timestamp,
            summary: c.summary.clone(),
        })
        .collect();

    let branch_name = status.branch.clone().unwrap_or_else(|| "HEAD".to_string());
    let is_clean = !status.is_dirty;

    if json {
        let output = HistoryJsonOutput {
            branch: branch_name,
            is_clean,
            total_commits: entries.len(),
            commits: entries,
        };
        println!("{}", serde_json::to_string_pretty(&output)?);
        return Ok(());
    }

    let use_color = std::env::var("NO_COLOR").is_err() && std::io::stdout().is_terminal();
    let (bold, cyan, gray, yellow, reset) = if use_color {
        ("\x1b[1m", "\x1b[36m", "\x1b[90m", "\x1b[33m", "\x1b[0m")
    } else {
        ("", "", "", "", "")
    };

    let dirty_desc = if status.is_dirty {
        format!(" {yellow}(dirty working tree){reset}")
    } else {
        String::new()
    };

    eprintln!("{bold}PreBase Git History{reset} — branch {cyan}{branch_name}{reset}{dirty_desc}",);
    eprintln!(
        "{gray}[Showing latest {} commit(s)]{reset}\n",
        entries.len()
    );

    for c in entries {
        println!(
            "{yellow}{:<8}{reset} {bold}{:<50}{reset} {gray}— {} ({}){reset}",
            c.short_hash, c.summary, c.author_name, c.author_email
        );
    }

    Ok(())
}
