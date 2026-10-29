use std::path::{Path, PathBuf};
use std::process::Command;
use tracing::debug;

use crate::error::GitError;
use crate::model::{
    CommitDetails, CommitStats, CommitSummary, FileChange, FileChangeStatus, FileHistoryResult,
    GitStatus, HistoryPage,
};
use crate::topology::assign_topological_lanes;

#[derive(Debug, Clone)]
pub struct GitEngine {
    root_path: PathBuf,
}

impl GitEngine {
    pub fn new(root_path: PathBuf) -> Self {
        Self { root_path }
    }

    pub fn root_path(&self) -> &Path {
        &self.root_path
    }

    fn run_git_cmd(&self, args: &[&str]) -> Result<Vec<u8>, GitError> {
        let mut cmd = Command::new("git");
        cmd.current_dir(&self.root_path)
            .args(args)
            .env("LANG", "C")
            .env("LC_ALL", "C");

        let output = cmd.output().map_err(GitError::Io)?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(GitError::CommandFailed {
                command: format!("git {}", args.join(" ")),
                code: output.status.code(),
                stderr,
            });
        }

        Ok(output.stdout)
    }

    fn run_git_str(&self, args: &[&str]) -> Result<String, GitError> {
        let bytes = self.run_git_cmd(args)?;
        String::from_utf8(bytes).map_err(|e| GitError::ParseError(e.to_string()))
    }

    /// Checks if the target directory is inside a valid git repository.
    pub fn is_git_repository(&self) -> bool {
        match self.run_git_str(&["rev-parse", "--is-inside-work-tree"]) {
            Ok(out) => out.trim() == "true",
            Err(_) => false,
        }
    }

    /// Retrieves repository status including active branch, head commit, and uncommitted dirty files.
    pub fn get_status(&self) -> Result<GitStatus, GitError> {
        if !self.is_git_repository() {
            return Ok(GitStatus {
                is_git_repo: false,
                branch: None,
                head_commit: None,
                is_dirty: false,
                dirty_files: Vec::new(),
            });
        }

        // Branch name
        let branch = match self.run_git_str(&["branch", "--show-current"]) {
            Ok(b) => {
                let trimmed = b.trim();
                if trimmed.is_empty() {
                    // Check if detached HEAD
                    match self.run_git_str(&["rev-parse", "--short", "HEAD"]) {
                        Ok(head) => Some(format!("HEAD (detached at {})", head.trim())),
                        Err(_) => None,
                    }
                } else {
                    Some(trimmed.to_string())
                }
            }
            Err(_) => None,
        };

        // Head commit hash
        let head_commit = match self.run_git_str(&["rev-parse", "HEAD"]) {
            Ok(h) => {
                let trimmed = h.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(trimmed.to_string())
                }
            }
            Err(_) => None,
        };

        // Dirty files
        let dirty_files = match self.run_git_str(&["status", "--porcelain", "-uall"]) {
            Ok(out) => out
                .lines()
                .filter_map(|line| {
                    if line.len() > 3 {
                        Some(line[3..].trim().to_string())
                    } else {
                        None
                    }
                })
                .collect(),
            Err(_) => Vec::new(),
        };

        let is_dirty = !dirty_files.is_empty();

        Ok(GitStatus {
            is_git_repo: true,
            branch,
            head_commit,
            is_dirty,
            dirty_files,
        })
    }

    /// Retrieves paginated commit history with topological ordering and lane allocation.
    pub fn get_history(&self, limit: usize, cursor: Option<&str>) -> Result<HistoryPage, GitError> {
        if !self.is_git_repository() {
            return Err(GitError::NotAGitRepository(self.root_path.clone()));
        }

        // Check total commits count
        let total_commits = match self.run_git_str(&["rev-list", "--count", "HEAD"]) {
            Ok(out) => out.trim().parse::<usize>().ok(),
            Err(_) => Some(0),
        };

        if total_commits == Some(0) {
            return Ok(HistoryPage {
                commits: Vec::new(),
                next_cursor: None,
                has_more: false,
                total_commits: Some(0),
            });
        }

        let fetch_limit = limit.clamp(1, 500);
        let skip_offset = cursor.and_then(|c| c.parse::<usize>().ok()).unwrap_or(0);

        let skip_str = skip_offset.to_string();
        let limit_plus_one_str = (fetch_limit + 1).to_string();

        let mut args = vec![
            "log",
            "--topo-order",
            "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1e",
            "-n",
            &limit_plus_one_str,
        ];

        if skip_offset > 0 {
            args.push("--skip");
            args.push(&skip_str);
        }

        let output_bytes = self.run_git_cmd(&args)?;
        let raw_str = String::from_utf8_lossy(&output_bytes);

        let mut raw_commits: Vec<CommitSummary> = Vec::new();
        for record in raw_str.split('\x1e') {
            let record = record.trim();
            if record.is_empty() {
                continue;
            }

            let fields: Vec<&str> = record.split('\x1f').collect();
            if fields.len() < 6 {
                continue;
            }

            let hash = fields[0].trim().to_string();
            let short_hash = if hash.len() >= 7 {
                hash[..7].to_string()
            } else {
                hash.clone()
            };

            let parent_hashes = fields[1]
                .split_whitespace()
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty())
                .collect();

            let author_name = fields[2].trim().to_string();
            let author_email = fields[3].trim().to_string();
            let author_timestamp = fields[4].trim().parse::<i64>().unwrap_or(0);
            let summary = fields[5].trim().to_string();

            raw_commits.push(CommitSummary {
                hash,
                short_hash,
                parent_hashes,
                author_name,
                author_email,
                author_timestamp,
                summary,
                lane: 0,
            });
        }

        let has_more = raw_commits.len() > fetch_limit;
        if has_more {
            raw_commits.truncate(fetch_limit);
        }

        let next_cursor = if has_more {
            Some((skip_offset + fetch_limit).to_string())
        } else {
            None
        };

        // Assign topological lanes
        assign_topological_lanes(&mut raw_commits);

        Ok(HistoryPage {
            commits: raw_commits,
            next_cursor,
            has_more,
            total_commits,
        })
    }

    /// Fetches details for a specific commit, including parent ancestry, commit metadata, stats, and changed files with rename awareness.
    pub fn get_commit_details(&self, hash: &str) -> Result<CommitDetails, GitError> {
        let hash = hash.trim();
        if hash.is_empty() || !hash.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err(GitError::CommitNotFound(hash.to_string()));
        }

        // 1. Commit metadata
        let meta_raw = match self.run_git_str(&[
            "log",
            "-1",
            "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI%x1f%B",
            hash,
        ]) {
            Ok(out) => out,
            Err(_) => return Err(GitError::CommitNotFound(hash.to_string())),
        };

        let fields: Vec<&str> = meta_raw.split('\x1f').collect();
        if fields.len() < 9 {
            return Err(GitError::ParseError("Incomplete commit metadata".into()));
        }

        let commit_hash = fields[0].trim().to_string();
        let short_hash = if commit_hash.len() >= 7 {
            commit_hash[..7].to_string()
        } else {
            commit_hash.clone()
        };

        let parent_hashes: Vec<String> = fields[1]
            .split_whitespace()
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .collect();

        let author_name = fields[2].trim().to_string();
        let author_email = fields[3].trim().to_string();
        let author_date = fields[4].trim().to_string();
        let committer_name = fields[5].trim().to_string();
        let committer_email = fields[6].trim().to_string();
        let committer_date = fields[7].trim().to_string();
        let message = fields[8].trim().to_string();

        // 2. Commit stats (insertions, deletions, files_changed)
        let mut stats = CommitStats::default();
        if let Ok(stat_output) = self.run_git_str(&["show", "--shortstat", "--format=", hash]) {
            parse_shortstat(&stat_output, &mut stats);
        }

        // 3. Changed files with diff-tree -z -M
        // If it's a root commit (no parents), diff against empty tree or use --root
        let diff_args = if parent_hashes.is_empty() {
            vec![
                "diff-tree",
                "-r",
                "--root",
                "-M",
                "--name-status",
                "-z",
                hash,
            ]
        } else {
            vec!["diff-tree", "-r", "-M", "--name-status", "-z", hash]
        };

        let diff_bytes = self.run_git_cmd(&diff_args)?;
        let files = parse_diff_tree_null_output(&diff_bytes);

        // Update stats files_changed if empty
        if stats.files_changed == 0 && !files.is_empty() {
            stats.files_changed = files.len();
        }

        Ok(CommitDetails {
            hash: commit_hash,
            short_hash,
            parent_hashes,
            author_name,
            author_email,
            author_date,
            committer_name,
            committer_email,
            committer_date,
            message,
            stats,
            files,
        })
    }

    /// Fetches the commit history that touched a specific file path (supports renames via --follow).
    pub fn get_file_history(
        &self,
        file_path: &str,
        limit: usize,
    ) -> Result<FileHistoryResult, GitError> {
        let clean_path = file_path.trim_start_matches('/').trim_start_matches('\\');
        let fetch_limit = limit.clamp(1, 200);
        let limit_str = fetch_limit.to_string();

        let args = [
            "log",
            "--follow",
            "--topo-order",
            "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1e",
            "-n",
            &limit_str,
            "--",
            clean_path,
        ];

        let output_bytes = self.run_git_cmd(&args)?;
        let raw_str = String::from_utf8_lossy(&output_bytes);

        let mut commits: Vec<CommitSummary> = Vec::new();
        for record in raw_str.split('\x1e') {
            let record = record.trim();
            if record.is_empty() {
                continue;
            }

            let fields: Vec<&str> = record.split('\x1f').collect();
            if fields.len() < 6 {
                continue;
            }

            let hash = fields[0].trim().to_string();
            let short_hash = if hash.len() >= 7 {
                hash[..7].to_string()
            } else {
                hash.clone()
            };

            let parent_hashes = fields[1]
                .split_whitespace()
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty())
                .collect();

            let author_name = fields[2].trim().to_string();
            let author_email = fields[3].trim().to_string();
            let author_timestamp = fields[4].trim().parse::<i64>().unwrap_or(0);
            let summary = fields[5].trim().to_string();

            commits.push(CommitSummary {
                hash,
                short_hash,
                parent_hashes,
                author_name,
                author_email,
                author_timestamp,
                summary,
                lane: 0,
            });
        }

        assign_topological_lanes(&mut commits);

        Ok(FileHistoryResult {
            file_path: clean_path.to_string(),
            commits,
        })
    }
}

fn parse_shortstat(stat_output: &str, stats: &mut CommitStats) {
    // Example: " 2 files changed, 10 insertions(+), 3 deletions(-)"
    for part in stat_output.split(',') {
        let part = part.trim();
        if part.contains("file") {
            if let Some(num) = part.split_whitespace().next().and_then(|s| s.parse().ok()) {
                stats.files_changed = num;
            }
        } else if part.contains("insertion") {
            if let Some(num) = part.split_whitespace().next().and_then(|s| s.parse().ok()) {
                stats.insertions = num;
            }
        } else if part.contains("deletion") {
            if let Some(num) = part.split_whitespace().next().and_then(|s| s.parse().ok()) {
                stats.deletions = num;
            }
        }
    }
}

fn parse_diff_tree_null_output(bytes: &[u8]) -> Vec<FileChange> {
    let mut files = Vec::new();
    let tokens: Vec<&[u8]> = bytes
        .split(|&b| b == 0)
        .filter(|tok| !tok.is_empty())
        .collect();

    if tokens.is_empty() {
        return files;
    }

    // Token 0 is the commit hash if printed at the beginning
    let mut idx = 0;
    if tokens[0].len() >= 40 && tokens[0].iter().all(|c| c.is_ascii_hexdigit()) {
        idx = 1;
    }

    while idx < tokens.len() {
        let status_token = String::from_utf8_lossy(tokens[idx]).trim().to_string();
        idx += 1;

        if status_token.is_empty() {
            continue;
        }

        let first_char = status_token.chars().next().unwrap_or(' ');
        match first_char {
            'A' => {
                if idx < tokens.len() {
                    let path = String::from_utf8_lossy(tokens[idx]).to_string();
                    idx += 1;
                    files.push(FileChange {
                        path,
                        old_path: None,
                        status: FileChangeStatus::Added,
                        similarity: None,
                    });
                }
            }
            'M' => {
                if idx < tokens.len() {
                    let path = String::from_utf8_lossy(tokens[idx]).to_string();
                    idx += 1;
                    files.push(FileChange {
                        path,
                        old_path: None,
                        status: FileChangeStatus::Modified,
                        similarity: None,
                    });
                }
            }
            'D' => {
                if idx < tokens.len() {
                    let path = String::from_utf8_lossy(tokens[idx]).to_string();
                    idx += 1;
                    files.push(FileChange {
                        path,
                        old_path: None,
                        status: FileChangeStatus::Deleted,
                        similarity: None,
                    });
                }
            }
            'R' => {
                let similarity = status_token[1..].parse::<u32>().ok();
                if idx + 1 < tokens.len() {
                    let old_path = String::from_utf8_lossy(tokens[idx]).to_string();
                    let new_path = String::from_utf8_lossy(tokens[idx + 1]).to_string();
                    idx += 2;
                    files.push(FileChange {
                        path: new_path,
                        old_path: Some(old_path),
                        status: FileChangeStatus::Renamed,
                        similarity,
                    });
                }
            }
            'C' => {
                let similarity = status_token[1..].parse::<u32>().ok();
                if idx + 1 < tokens.len() {
                    let old_path = String::from_utf8_lossy(tokens[idx]).to_string();
                    let new_path = String::from_utf8_lossy(tokens[idx + 1]).to_string();
                    idx += 2;
                    files.push(FileChange {
                        path: new_path,
                        old_path: Some(old_path),
                        status: FileChangeStatus::Copied,
                        similarity,
                    });
                }
            }
            _ => {
                // Unknown or unexpected token, skip to keep parsing resilient
                debug!("Unrecognized status token: {status_token}");
            }
        }
    }

    files
}
