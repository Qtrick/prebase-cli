use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use thiserror::Error;
use tracing::warn;

use crate::model::FileKind;

#[derive(Error, Debug)]
pub enum ScanError {
    #[error("Path does not exist: {0}")]
    PathNotFound(PathBuf),
    #[error("Target is not a directory: {0}")]
    NotADirectory(PathBuf),
    #[error("Failed to canonicalize path {0}: {1}")]
    CanonicalizeFailed(PathBuf, std::io::Error),
    #[error("Filesystem IO error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone)]
pub struct DiscoveredFile {
    pub absolute_path: PathBuf,
    pub relative_path: String,
    pub filename: String,
    pub extension: String,
    pub size_bytes: u64,
    pub file_kind: FileKind,
    pub is_supported_language: bool,
}

#[derive(Debug, Clone)]
pub struct ScannerConfig {
    pub max_file_size_bytes: u64,
}

impl Default for ScannerConfig {
    fn default() -> Self {
        Self {
            max_file_size_bytes: 2 * 1024 * 1024, // 2MB
        }
    }
}

pub struct RepositoryScanner {
    root: PathBuf,
    config: ScannerConfig,
}

impl RepositoryScanner {
    pub fn new(target_path: &Path, config: ScannerConfig) -> Result<Self, ScanError> {
        let root = Self::discover_root(target_path)?;
        Ok(Self { root, config })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn repository_id(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(self.root.to_string_lossy().as_bytes());
        let hash = hex::encode(hasher.finalize());
        let repo_name = self.repository_name();
        format!("{repo_name}-{hash:.8}")
    }

    pub fn repository_name(&self) -> String {
        self.root
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("repository")
            .to_string()
    }

    pub fn discover_root(start: &Path) -> Result<PathBuf, ScanError> {
        if !start.exists() {
            return Err(ScanError::PathNotFound(start.to_path_buf()));
        }
        let canonical = start
            .canonicalize()
            .map_err(|e| ScanError::CanonicalizeFailed(start.to_path_buf(), e))?;

        if !canonical.is_dir() {
            return Err(ScanError::NotADirectory(canonical));
        }

        // If target directory has its own .git, use it
        if canonical.join(".git").exists() {
            return Ok(canonical);
        }

        // If invoked with an explicit path argument other than "." or current working directory,
        // respect the explicit path as the target repository root.
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let canonical_cwd = cwd.canonicalize().unwrap_or(cwd);

        if canonical != canonical_cwd {
            return Ok(canonical);
        }

        // Otherwise, when invoked in current dir, walk up to find the enclosing git repository
        let mut current = canonical.as_path();
        while let Some(parent) = current.parent() {
            if current.join(".git").exists() {
                return Ok(current.to_path_buf());
            }
            current = parent;
        }

        Ok(canonical)
    }

    pub fn is_excluded_relative_path(rel_path: &str) -> bool {
        let parts: Vec<&str> = rel_path.split('/').collect();
        for part in &parts {
            match *part {
                ".git" | "node_modules" | "dist" | "build" | ".build" | ".next" | ".nuxt"
                | "coverage" | "target" | ".reference" | ".cache" | ".turbo" | ".vscode"
                | ".idea" | ".cursor" | ".agents" | ".codex" => return true,
                _ => {}
            }
        }

        let filename = parts.last().copied().unwrap_or(rel_path);
        // Exclude secret files
        if filename.starts_with(".env")
            || filename.ends_with(".pem")
            || filename.ends_with(".key")
            || filename.ends_with(".p12")
            || filename.ends_with(".pfx")
            || filename.starts_with("id_rsa")
            || filename == "credentials.json"
        {
            return true;
        }

        false
    }

    pub fn scan(&self) -> (Vec<DiscoveredFile>, usize) {
        let mut discovered = Vec::new();
        let mut excluded_count = 0;

        let walker = ignore::WalkBuilder::new(&self.root)
            .hidden(false) // Let us handle hidden files explicitly
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .follow_links(false) // Symlink security: do not blindly follow symlinks
            .build();

        for entry in walker.flatten() {
            let path = entry.path();
            if path == self.root || path.is_dir() {
                continue;
            }

            // Normalise relative path
            let rel = match path.strip_prefix(&self.root) {
                Ok(r) => r.to_string_lossy().replace('\\', "/"),
                Err(_) => continue,
            };

            if Self::is_excluded_relative_path(&rel) {
                excluded_count += 1;
                continue;
            }

            // Check file size
            let metadata = match path.metadata() {
                Ok(m) => m,
                Err(err) => {
                    warn!("Failed to read metadata for {rel}: {err}");
                    excluded_count += 1;
                    continue;
                }
            };

            let size = metadata.len();
            if size > self.config.max_file_size_bytes {
                warn!("File {rel} exceeds size limit ({size} bytes), skipping");
                excluded_count += 1;
                continue;
            }

            let filename = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();

            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| format!(".{}", e.to_lowercase()))
                .unwrap_or_default();

            let is_supported = matches!(
                ext.as_str(),
                ".js" | ".jsx" | ".ts" | ".tsx" | ".mjs" | ".cjs" | ".mts" | ".cts"
            );

            let file_kind =
                if rel.contains(".test.") || rel.contains(".spec.") || rel.contains("__tests__") {
                    FileKind::Test
                } else if matches!(ext.as_str(), ".json" | ".yaml" | ".yml" | ".toml") {
                    FileKind::Config
                } else if matches!(ext.as_str(), ".md" | ".txt") {
                    FileKind::Doc
                } else if is_supported {
                    FileKind::Source
                } else {
                    FileKind::Other
                };

            discovered.push(DiscoveredFile {
                absolute_path: path.to_path_buf(),
                relative_path: rel,
                filename,
                extension: ext,
                size_bytes: size,
                file_kind,
                is_supported_language: is_supported,
            });
        }

        // Deterministic sorting by relative path
        discovered.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));

        (discovered, excluded_count)
    }
}
