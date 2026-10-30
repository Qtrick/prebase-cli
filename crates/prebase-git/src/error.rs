use std::path::PathBuf;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum GitError {
    #[error("Not a git repository: {0}")]
    NotAGitRepository(PathBuf),

    #[error("Empty git repository: no commits found")]
    EmptyRepository,

    #[error("Git command '{command}' timed out after {duration_secs} seconds")]
    Timeout { command: String, duration_secs: u64 },

    #[error("Git command '{command}' exceeded maximum allowed output limit of {max_bytes} bytes")]
    OutputLimitExceeded { command: String, max_bytes: usize },

    #[error("History cursor '{0}' is stale (HEAD branched or commit is no longer an ancestor)")]
    StaleCursor(String),

    #[error("Invalid revision identifier: {0}")]
    InvalidRevision(String),

    #[error("Git command '{command}' failed (code {code:?}): {stderr}")]
    CommandFailed {
        command: String,
        code: Option<i32>,
        stderr: String,
    },

    #[error("Commit not found: {0}")]
    CommitNotFound(String),

    #[error("File not found in history: {0}")]
    FileNotFound(String),

    #[error("Failed to parse git output: {0}")]
    ParseError(String),

    #[error("I/O error executing git: {0}")]
    Io(#[from] std::io::Error),
}
