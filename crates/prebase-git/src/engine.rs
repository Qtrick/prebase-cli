use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tracing::debug;

use crate::error::GitError;
use crate::model::{
    CommitDetails, CommitStats, CommitSummary, FileChange, FileChangeStatus, FileHistoryResult,
    GitStatus, HistoryPage,
};
use crate::topology::assign_topological_lanes;

const GIT_COMMAND_TIMEOUT_SECS: u64 = 10;
const GIT_MAX_OUTPUT_BYTES: usize = 10 * 1024 * 1024; // 10MB

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

    /// Executes a bounded, safe, read-only Git subprocess with execution deadline,
    /// output size limits, and guaranteed child-process cleanup on cancellation.
    fn run_git_cmd(&self, args: &[&str]) -> Result<Vec<u8>, GitError> {
        let mut cmd = Command::new("git");
        cmd.current_dir(&self.root_path)
            .args(args)
            .env("LANG", "C")
            .env("LC_ALL", "C")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(GitError::Io)?;
        let start = Instant::now();
        let timeout = Duration::from_secs(GIT_COMMAND_TIMEOUT_SECS);

        loop {
            match child.try_wait().map_err(GitError::Io)? {
                Some(status) => {
                    let mut stdout = Vec::new();
                    if let Some(mut out) = child.stdout.take() {
                        out.by_ref()
                            .take(GIT_MAX_OUTPUT_BYTES as u64 + 1)
                            .read_to_end(&mut stdout)
                            .map_err(GitError::Io)?;
                    }

                    if stdout.len() > GIT_MAX_OUTPUT_BYTES {
                        return Err(GitError::OutputLimitExceeded {
                            command: format!("git {}", args.join(" ")),
                            max_bytes: GIT_MAX_OUTPUT_BYTES,
                        });
                    }

                    let mut stderr = Vec::new();
                    if let Some(mut err_pipe) = child.stderr.take() {
                        let _ = err_pipe.by_ref().take(64 * 1024).read_to_end(&mut stderr);
                    }

                    if !status.success() {
                        let stderr_str = String::from_utf8_lossy(&stderr).trim().to_string();
                        return Err(GitError::CommandFailed {
                            command: format!("git {}", args.join(" ")),
                            code: status.code(),
                            stderr: stderr_str,
                        });
                    }

                    return Ok(stdout);
                }
                None => {
                    if start.elapsed() > timeout {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(GitError::Timeout {
                            command: format!("git {}", args.join(" ")),
                            duration_secs: GIT_COMMAND_TIMEOUT_SECS,
                        });
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
        }
    }

    fn run_git_str(&self, args: &[&str]) -> Result<String, GitError> {
        let bytes = self.run_git_cmd(args)?;
        String::from_utf8(bytes).map_err(|e| GitError::ParseError(e.to_string()))
    }

    /// Checks if the target directory is inside a valid git repository or git worktree.
    pub fn is_git_repository(&self) -> bool {
        match self.run_git_str(&["rev-parse", "--is-inside-work-tree"]) {
            Ok(out) => out.trim() == "true",
            Err(_) => false,
        }
    }

    /// Checks if target is a Git linked worktree (i.e. `.git` is a pointer file rather than a directory).
    pub fn is_worktree(&self) -> bool {
        let git_meta = self.root_path.join(".git");
        git_meta.is_file()
    }

    /// Retrieves repository status including active branch, head commit, and uncommitted dirty files,
    /// using null-delimited porcelain format to prevent path-escaping and encoding bugs.
    pub fn get_status(&self) -> Result<GitStatus, GitError> {
        if !self.is_git_repository() {
            return Ok(GitStatus {
                is_git_repo: false,
                is_worktree: false,
                branch: None,
                head_commit: None,
                is_dirty: false,
                dirty_files: Vec::new(),
            });
        }

        let is_worktree = self.is_worktree();

        // Branch name or detached HEAD
        let branch = match self.run_git_str(&["branch", "--show-current"]) {
            Ok(b) => {
                let trimmed = b.trim();
                if trimmed.is_empty() {
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

        // Parse dirty files using NUL-delimited porcelain format (-z)
        // Format: XY <path>\0 [orig_path\0]
        let mut dirty_files = Vec::new();
        if let Ok(status_bytes) = self.run_git_cmd(&["status", "--porcelain=v1", "-z", "-uall"]) {
            let mut tokens = status_bytes.split(|&b| b == 0);
            while let Some(tok) = tokens.next() {
                if tok.is_empty() {
                    continue;
                }
                let entry_str = String::from_utf8_lossy(tok);
                if entry_str.len() >= 3 {
                    let status_code = &entry_str[..2];
                    let file_path = entry_str[3..].trim().to_string();

                    // If status is rename (R) or copy (C), next token is original path
                    if status_code.starts_with('R') || status_code.starts_with('C') {
                        let _ = tokens.next(); // consume orig_path
                    }

                    if !file_path.is_empty() {
                        dirty_files.push(file_path);
                    }
                }
            }
        }

        let is_dirty = !dirty_files.is_empty();

        Ok(GitStatus {
            is_git_repo: true,
            is_worktree,
            branch,
            head_commit,
            is_dirty,
            dirty_files,
        })
    }

    /// Retrieves paginated commit history with topological ordering, lane allocation,
    /// and anchor-commit cursor verification for stable history traversal across branch updates.
    pub fn get_history(&self, limit: usize, cursor: Option<&str>) -> Result<HistoryPage, GitError> {
        if !self.is_git_repository() {
            return Err(GitError::NotAGitRepository(self.root_path.clone()));
        }

        // Total commits in current HEAD
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

        let fetch_limit = limit.clamp(1, 200);
        let limit_plus_one_str = (fetch_limit + 1).to_string();

        let mut args: Vec<String> = vec![
            "log".into(),
            "--topo-order".into(),
            "--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%x1e".into(),
            "-n".into(),
            limit_plus_one_str,
        ];

        // Anchor cursor verification
        if let Some(c) = cursor {
            let cursor_str = c.trim();
            if !cursor_str.is_empty() {
                // If cursor is a numeric offset for legacy callers, support it safely
                if let Ok(offset) = cursor_str.parse::<usize>() {
                    if offset > 0 {
                        args.push("--skip".into());
                        args.push(offset.to_string());
                    }
                } else {
                    // Cursor is a commit SHA: verify it is an ancestor of HEAD
                    if !is_valid_sha(cursor_str) {
                        return Err(GitError::InvalidRevision(cursor_str.to_string()));
                    }

                    // Check ancestor relationship to detect branch changes / stale cursors
                    let is_ancestor = self
                        .run_git_cmd(&["merge-base", "--is-ancestor", cursor_str, "HEAD"])
                        .is_ok();

                    if !is_ancestor {
                        return Err(GitError::StaleCursor(cursor_str.to_string()));
                    }

                    // Traverse starting strictly after cursor commit: <cursor>~1
                    let anchor_ref = format!("{cursor_str}~1");
                    // Check if cursor commit has parents (if not, it's root commit, no more history)
                    let parent_check = self.run_git_str(&["rev-parse", &anchor_ref]);
                    if parent_check.is_err() {
                        return Ok(HistoryPage {
                            commits: Vec::new(),
                            next_cursor: None,
                            has_more: false,
                            total_commits,
                        });
                    }

                    args.push(anchor_ref);
                }
            }
        }

        let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        let output_bytes = self.run_git_cmd(&arg_refs)?;

        let mut raw_commits: Vec<CommitSummary> = Vec::new();
        // Parse NUL-delimited records framed by record separator \x1e
        for record_bytes in output_bytes.split(|&b| b == 0x1e) {
            if record_bytes.is_empty() {
                continue;
            }

            let fields: Vec<&[u8]> = record_bytes.split(|&b| b == 0).collect();
            if fields.len() < 6 {
                continue;
            }

            let hash = String::from_utf8_lossy(fields[0]).trim().to_string();
            if hash.is_empty() {
                continue;
            }

            let short_hash = if hash.len() >= 7 {
                hash[..7].to_string()
            } else {
                hash.clone()
            };

            let parents_str = String::from_utf8_lossy(fields[1]);
            let parent_hashes = parents_str
                .split_whitespace()
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty())
                .collect();

            let author_name = String::from_utf8_lossy(fields[2]).trim().to_string();
            let author_email = String::from_utf8_lossy(fields[3]).trim().to_string();
            let timestamp_str = String::from_utf8_lossy(fields[4]);
            let author_timestamp = timestamp_str.trim().parse::<i64>().unwrap_or(0);
            let summary = String::from_utf8_lossy(fields[5]).trim().to_string();

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

        // Anchor cursor is the SHA of the last commit on the returned page
        let next_cursor = if has_more {
            raw_commits.last().map(|c| c.hash.clone())
        } else {
            None
        };

        assign_topological_lanes(&mut raw_commits);

        Ok(HistoryPage {
            commits: raw_commits,
            next_cursor,
            has_more,
            total_commits,
        })
    }

    /// Fetches commit metadata, stats, and changed files with rename tracking.
    /// Handles merge commits with explicit first-parent comparison basis and label.
    pub fn get_commit_details(&self, hash: &str) -> Result<CommitDetails, GitError> {
        let hash = hash.trim();
        if !is_valid_sha(hash) {
            return Err(GitError::CommitNotFound(hash.to_string()));
        }

        // 1. Commit metadata using NUL-delimited format (%x00)
        let meta_bytes = match self.run_git_cmd(&[
            "log",
            "-1",
            "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B",
            hash,
        ]) {
            Ok(bytes) => bytes,
            Err(_) => return Err(GitError::CommitNotFound(hash.to_string())),
        };

        let fields: Vec<&[u8]> = meta_bytes.split(|&b| b == 0).collect();
        if fields.len() < 9 {
            return Err(GitError::ParseError("Incomplete commit metadata".into()));
        }

        let commit_hash = String::from_utf8_lossy(fields[0]).trim().to_string();
        let short_hash = if commit_hash.len() >= 7 {
            commit_hash[..7].to_string()
        } else {
            commit_hash.clone()
        };

        let parents_str = String::from_utf8_lossy(fields[1]);
        let parent_hashes: Vec<String> = parents_str
            .split_whitespace()
            .map(|p| p.trim().to_string())
            .filter(|p| !p.is_empty())
            .collect();

        let author_name = String::from_utf8_lossy(fields[2]).trim().to_string();
        let author_email = String::from_utf8_lossy(fields[3]).trim().to_string();
        let author_date = String::from_utf8_lossy(fields[4]).trim().to_string();
        let committer_name = String::from_utf8_lossy(fields[5]).trim().to_string();
        let committer_email = String::from_utf8_lossy(fields[6]).trim().to_string();
        let committer_date = String::from_utf8_lossy(fields[7]).trim().to_string();
        let message = String::from_utf8_lossy(fields[8]).trim().to_string();

        // 2. Commit stats (insertions, deletions, files_changed)
        let mut stats = CommitStats::default();
        if let Ok(stat_output) = self.run_git_str(&["show", "--shortstat", "--format=", hash]) {
            parse_shortstat(&stat_output, &mut stats);
        }

        // 3. Changed files with diff-tree -z -M
        let parent_ref = format!("{hash}^1");
        let (diff_args, comparison_basis) = if parent_hashes.is_empty() {
            // Root commit: diff against empty tree
            (
                vec![
                    "diff-tree",
                    "-r",
                    "--root",
                    "-M",
                    "--name-status",
                    "-z",
                    hash,
                ],
                None,
            )
        } else if parent_hashes.len() == 1 {
            // Single-parent commit
            (
                vec![
                    "diff-tree",
                    "-r",
                    "-M",
                    "--name-status",
                    "-z",
                    &parent_ref,
                    hash,
                ],
                None,
            )
        } else {
            // Merge commit: diff against first parent by default, and clearly label comparison basis
            let p0_short = if parent_hashes[0].len() >= 7 {
                &parent_hashes[0][..7]
            } else {
                &parent_hashes[0]
            };
            (
                vec![
                    "diff-tree",
                    "-r",
                    "-M",
                    "--name-status",
                    "-z",
                    &parent_ref,
                    hash,
                ],
                Some(format!("First parent ({p0_short})")),
            )
        };

        let diff_bytes = self.run_git_cmd(&diff_args)?;
        let files = parse_diff_tree_null_output(&diff_bytes);

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
            comparison_basis,
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
            "--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%x1e",
            "-n",
            &limit_str,
            "--",
            clean_path,
        ];

        let output_bytes = self.run_git_cmd(&args)?;

        let mut commits: Vec<CommitSummary> = Vec::new();
        for record_bytes in output_bytes.split(|&b| b == 0x1e) {
            if record_bytes.is_empty() {
                continue;
            }

            let fields: Vec<&[u8]> = record_bytes.split(|&b| b == 0).collect();
            if fields.len() < 6 {
                continue;
            }

            let hash = String::from_utf8_lossy(fields[0]).trim().to_string();
            if hash.is_empty() {
                continue;
            }

            let short_hash = if hash.len() >= 7 {
                hash[..7].to_string()
            } else {
                hash.clone()
            };

            let parents_str = String::from_utf8_lossy(fields[1]);
            let parent_hashes = parents_str
                .split_whitespace()
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty())
                .collect();

            let author_name = String::from_utf8_lossy(fields[2]).trim().to_string();
            let author_email = String::from_utf8_lossy(fields[3]).trim().to_string();
            let timestamp_str = String::from_utf8_lossy(fields[4]);
            let author_timestamp = timestamp_str.trim().parse::<i64>().unwrap_or(0);
            let summary = String::from_utf8_lossy(fields[5]).trim().to_string();

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

fn is_valid_sha(s: &str) -> bool {
    (4..=64).contains(&s.len()) && s.chars().all(|c| c.is_ascii_hexdigit())
}

fn parse_shortstat(stat_output: &str, stats: &mut CommitStats) {
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

    let mut idx = 0;
    // Skip initial commit hash if output by diff-tree
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
                debug!("Unrecognized diff-tree status token: {status_token}");
            }
        }
    }

    files
}
