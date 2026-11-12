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

#[derive(Debug, Clone, Default)]
pub struct ScanOutput {
    pub discovered: Vec<DiscoveredFile>,
    pub excluded_count: usize,
    pub traversal_errors: Vec<String>,
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
        let normalized = rel_path.replace('\\', "/");
        let parts: Vec<&str> = normalized.split('/').filter(|p| !p.is_empty()).collect();
        for part in &parts {
            // Compare case-insensitively and trimmed: on macOS/Windows (case-insensitive by
            // default) "NODE_MODULES" and "node_modules" are the same directory,
            // and names with surrounding whitespace must not bypass boundary checks.
            let part_lower = part.to_ascii_lowercase();
            match part_lower.trim() {
                ".git" | "node_modules" | "dist" | "build" | ".build" | ".next" | ".nuxt"
                | "coverage" | "target" | ".reference" | ".cache" | ".turbo" | ".vscode"
                | ".idea" | ".cursor" | ".agents" | ".codex" | ".ssh" | ".aws" | ".gnupg" => {
                    return true
                }
                _ => {}
            }
        }

        let filename = parts.last().copied().unwrap_or(rel_path);
        // Secret names are also matched case-insensitively and trimmed for security:
        // `.ENV` on a case-insensitive filesystem is the same file as `.env`, and
        // files named with leading/trailing spaces (e.g. ` .env`) must be excluded.
        let filename_lower = filename.to_ascii_lowercase();
        let filename_clean = filename_lower.trim();
        if filename_clean.starts_with(".env")
            || filename_clean.ends_with(".pem")
            || filename_clean.ends_with(".key")
            || filename_clean.ends_with(".p12")
            || filename_clean.ends_with(".pfx")
            || filename_clean.starts_with("id_rsa")
            || filename_clean.starts_with("id_dsa")
            || filename_clean.starts_with("id_ecdsa")
            || filename_clean.starts_with("id_ed25519")
            || filename_clean == "identity"
            || filename_clean == "identity.pub"
            || filename_clean == ".netrc"
            || filename_clean == "credentials"
            || filename_clean == "credentials.json"
            // ponytail: align scanner with watcher for PreBase application-owned log outputs
            || filename_clean == "prebase.log"
            || filename_clean == "prebase_server.log"
            || (filename_clean.starts_with("prebase_") && filename_clean.ends_with(".log"))
        {
            return true;
        }

        false
    }

    pub fn scan(&self) -> (Vec<DiscoveredFile>, usize) {
        let output = self.scan_with_cancellation(|| false);
        (output.discovered, output.excluded_count)
    }

    pub fn scan_with_cancellation<F: Fn() -> bool>(&self, is_cancelled: F) -> ScanOutput {
        let mut discovered = Vec::new();
        let mut excluded_count = 0;
        let mut traversal_errors = Vec::new();

        let walker = ignore::WalkBuilder::new(&self.root)
            .hidden(false) // Let us handle hidden files explicitly
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .follow_links(false) // Symlink security: do not blindly follow symlinks
            .build();

        for result in walker {
            if is_cancelled() {
                break;
            }
            let entry = match result {
                Ok(e) => e,
                Err(err) => {
                    warn!("Filesystem traversal error: {err}");
                    traversal_errors.push(err.to_string());
                    continue;
                }
            };

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

            // Symlink and file type security verification
            let symlink_meta = match path.symlink_metadata() {
                Ok(m) => m,
                Err(err) => {
                    warn!("Failed to read symlink metadata for {rel}: {err}");
                    excluded_count += 1;
                    continue;
                }
            };

            // Skip directories immediately
            if symlink_meta.is_dir() {
                continue;
            }

            let effective_size: u64 = if symlink_meta.file_type().is_symlink() {
                // Symlink security verification:
                // 1. Resolve canonical target
                let canonical_target = match path.canonicalize() {
                    Ok(t) => t,
                    Err(err) => {
                        warn!("Skipping broken or unresolvable symlink {rel}: {err}");
                        excluded_count += 1;
                        continue;
                    }
                };

                // 2. Canonical target must remain strictly inside repository root
                if !canonical_target.starts_with(&self.root) {
                    warn!(
                        "Skipping symlink escaping repository root: {rel} -> {}",
                        canonical_target.display()
                    );
                    excluded_count += 1;
                    continue;
                }

                // 3. Target must be a regular file (not directory, socket, device, or FIFO)
                let target_meta = match canonical_target.metadata() {
                    Ok(m) if m.is_file() => m,
                    _ => {
                        warn!(
                            "Skipping symlink pointing to non-regular file: {rel} -> {}",
                            canonical_target.display()
                        );
                        excluded_count += 1;
                        continue;
                    }
                };

                // 4. Target must not be an excluded or secret file
                if let Ok(target_rel) = canonical_target.strip_prefix(&self.root) {
                    let target_rel_str = target_rel.to_string_lossy().replace('\\', "/");
                    if Self::is_excluded_relative_path(&target_rel_str) {
                        warn!(
                            "Skipping symlink pointing to excluded sensitive file: {rel} -> {target_rel_str}"
                        );
                        excluded_count += 1;
                        continue;
                    }
                }

                target_meta.len()
            } else if symlink_meta.is_file() {
                symlink_meta.len()
            } else {
                // Non-regular file (FIFO, socket, block/char device)
                warn!("Skipping non-regular filesystem object: {rel}");
                excluded_count += 1;
                continue;
            };

            if effective_size > self.config.max_file_size_bytes {
                warn!("File {rel} exceeds size limit ({effective_size} bytes), skipping");
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
                size_bytes: effective_size,
                file_kind,
                is_supported_language: is_supported,
            });
        }

        // Deterministic sorting by relative path
        discovered.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));

        ScanOutput {
            discovered,
            excluded_count,
            traversal_errors,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_excluded_relative_path() {
        assert!(RepositoryScanner::is_excluded_relative_path(
            "node_modules/foo/index.js"
        ));
        assert!(RepositoryScanner::is_excluded_relative_path(
            "dist/bundle.js"
        ));
        assert!(RepositoryScanner::is_excluded_relative_path(".git/HEAD"));
        assert!(RepositoryScanner::is_excluded_relative_path(
            "src/.env.local"
        ));
        assert!(RepositoryScanner::is_excluded_relative_path(".env"));
        assert!(RepositoryScanner::is_excluded_relative_path(
            "secrets/key.pem"
        ));
        assert!(RepositoryScanner::is_excluded_relative_path(
            "config/credentials.json"
        ));
        assert!(RepositoryScanner::is_excluded_relative_path(
            ".reference/vscode/src/vs/editor/common/model.ts"
        ));
        assert!(RepositoryScanner::is_excluded_relative_path(
            ".cache/turbopack.bin"
        ));
        assert!(RepositoryScanner::is_excluded_relative_path(
            ".turbo/cache.json"
        ));

        // Modern SSH keys, credentials, and sensitive dot directories
        assert!(RepositoryScanner::is_excluded_relative_path("id_ed25519"));
        assert!(RepositoryScanner::is_excluded_relative_path("id_ecdsa"));
        assert!(RepositoryScanner::is_excluded_relative_path("id_dsa"));
        assert!(RepositoryScanner::is_excluded_relative_path("src/identity"));
        assert!(RepositoryScanner::is_excluded_relative_path(
            "src/identity.pub"
        ));
        assert!(RepositoryScanner::is_excluded_relative_path(
            ".ssh/known_hosts"
        ));
        assert!(RepositoryScanner::is_excluded_relative_path(
            ".aws/credentials"
        ));
        assert!(RepositoryScanner::is_excluded_relative_path(
            ".gnupg/trustdb.gpg"
        ));
        assert!(RepositoryScanner::is_excluded_relative_path(".netrc"));

        // PreBase application-owned runtime logs
        assert!(RepositoryScanner::is_excluded_relative_path("prebase.log"));
        assert!(RepositoryScanner::is_excluded_relative_path(
            "prebase_server.log"
        ));
        assert!(RepositoryScanner::is_excluded_relative_path(
            "prebase_test.log"
        ));
        assert!(RepositoryScanner::is_excluded_relative_path(
            "src/PREBASE.LOG"
        ));

        // Case-insensitive exclusion check (crucial for macOS/Windows default filesystems)
        assert!(RepositoryScanner::is_excluded_relative_path(
            "NODE_MODULES/package/index.js"
        ));
        assert!(RepositoryScanner::is_excluded_relative_path(
            "DIST/bundle.js"
        ));
        assert!(RepositoryScanner::is_excluded_relative_path(
            "SRC/.ENV.PRODUCTION"
        ));
        assert!(RepositoryScanner::is_excluded_relative_path(
            "CERTS/SERVER.PEM"
        ));
        assert!(RepositoryScanner::is_excluded_relative_path(".AWS/CONFIG"));

        // Normal files should not be excluded
        assert!(!RepositoryScanner::is_excluded_relative_path(
            "src/index.ts"
        ));
        assert!(!RepositoryScanner::is_excluded_relative_path(
            "packages/core/src/index.ts"
        ));
        assert!(!RepositoryScanner::is_excluded_relative_path("README.md"));

        // Normalise separators
        assert!(RepositoryScanner::is_excluded_relative_path(
            "node_modules\\foo\\bar.js"
        ));
        assert!(RepositoryScanner::is_excluded_relative_path(
            "/node_modules/pkg/"
        ));
    }

    #[test]
    fn test_scan_enforces_max_file_size_for_regular_files() {
        use std::fs;
        use tempfile::tempdir;

        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("small.ts"), "export const a = 1;").unwrap();
        fs::write(root.join("big.ts"), "x".repeat(200)).unwrap();

        let scanner = RepositoryScanner::new(
            root,
            ScannerConfig {
                max_file_size_bytes: 100,
            },
        )
        .unwrap();
        let (discovered, excluded) = scanner.scan();
        let paths: Vec<String> = discovered.into_iter().map(|f| f.relative_path).collect();

        assert!(paths.contains(&"small.ts".to_string()));
        assert!(!paths.contains(&"big.ts".to_string()));
        assert!(excluded >= 1);
    }

    #[test]
    #[cfg(unix)]
    fn test_symlink_scanning_security() {
        use std::fs;
        use std::os::unix::fs::symlink;
        use tempfile::tempdir;

        let base = tempdir().unwrap();
        let repo_root = base.path().join("repo");
        let outside_dir = base.path().join("outside");
        fs::create_dir_all(repo_root.join("src")).unwrap();
        fs::create_dir_all(&outside_dir).unwrap();

        // 1. Legitimate file
        let main_ts = repo_root.join("src/main.ts");
        fs::write(&main_ts, "console.log('hello');").unwrap();

        // 2. Secret file inside repo
        let secret_file = repo_root.join("src/.env");
        fs::write(&secret_file, "SECRET_KEY=12345").unwrap();

        // 3. File outside repo
        let outside_file = outside_dir.join("private.ts");
        fs::write(&outside_file, "const sensitiveData = 'classified';").unwrap();

        // 4. Symlink escaping repo
        symlink(&outside_file, repo_root.join("src/escape.ts")).unwrap();

        // 5. Symlink to secret file inside repo
        symlink(&secret_file, repo_root.join("src/secret_link.ts")).unwrap();

        // 6. Valid internal symlink
        symlink(&main_ts, repo_root.join("src/valid_alias.ts")).unwrap();

        // 7. Broken symlink
        symlink(
            repo_root.join("src/nonexistent.ts"),
            repo_root.join("src/broken.ts"),
        )
        .unwrap();

        // 8. Directory symlink escaping repo
        symlink(&outside_dir, repo_root.join("src/outside_dir_link")).unwrap();

        // 9. Internal directory symlink inside repo (must be skipped as non-regular file)
        let internal_subdir = repo_root.join("src/components");
        fs::create_dir_all(&internal_subdir).unwrap();
        fs::write(
            internal_subdir.join("Button.tsx"),
            "export const Button = () => null;",
        )
        .unwrap();
        symlink(&internal_subdir, repo_root.join("src/components_link")).unwrap();

        // 10. Multi-hop valid symlink inside repo: hop2 -> hop1 -> main.ts
        symlink(&main_ts, repo_root.join("src/hop1.ts")).unwrap();
        symlink(repo_root.join("src/hop1.ts"), repo_root.join("src/hop2.ts")).unwrap();

        // 11. Circular symlink loop: cycle_a <-> cycle_b (must not hang or panic; must be excluded)
        let loop_a = repo_root.join("src/loop_a.ts");
        let loop_b = repo_root.join("src/loop_b.ts");
        symlink(&loop_b, &loop_a).unwrap();
        symlink(&loop_a, &loop_b).unwrap();

        let scanner = RepositoryScanner::new(&repo_root, ScannerConfig::default()).unwrap();
        let (discovered, excluded_count) = scanner.scan();

        let rel_paths: Vec<String> = discovered.into_iter().map(|f| f.relative_path).collect();

        // Must include legitimate files and valid internal symlinks (including multi-hop)
        assert!(rel_paths.contains(&"src/main.ts".to_string()));
        assert!(rel_paths.contains(&"src/valid_alias.ts".to_string()));
        assert!(rel_paths.contains(&"src/hop1.ts".to_string()));
        assert!(rel_paths.contains(&"src/hop2.ts".to_string()));
        assert!(rel_paths.contains(&"src/components/Button.tsx".to_string()));

        // Must strictly exclude escaping symlink, secret symlink, broken symlink, dir symlinks,
        // circular symlinks, and secret file
        assert!(!rel_paths.contains(&"src/escape.ts".to_string()));
        assert!(!rel_paths.contains(&"src/secret_link.ts".to_string()));
        assert!(!rel_paths.contains(&"src/broken.ts".to_string()));
        assert!(!rel_paths.contains(&"src/outside_dir_link".to_string()));
        assert!(!rel_paths.contains(&"src/components_link".to_string()));
        assert!(!rel_paths.contains(&"src/loop_a.ts".to_string()));
        assert!(!rel_paths.contains(&"src/loop_b.ts".to_string()));
        assert!(!rel_paths.contains(&"src/.env".to_string()));

        assert!(excluded_count >= 6);
    }
}
