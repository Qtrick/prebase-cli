use std::io::Read;
use std::path::{Path, PathBuf};
use thiserror::Error;
use tracing::warn;

use crate::scanner::RepositoryScanner;

#[cfg(target_os = "macos")]
const O_NONBLOCK: i32 = 0x0004;

#[cfg(any(target_os = "linux", target_os = "android"))]
const O_NONBLOCK: i32 = 0o4000;

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "android")))]
const O_NONBLOCK: i32 = 0x0004;

#[derive(Error, Debug)]
pub enum SafeReadError {
    #[error("Path is invalid, empty, or attempts directory traversal")]
    InvalidPath,
    #[error("File not found: {0}")]
    NotFound(String),
    #[error("Path escapes repository root: {0}")]
    EscapesRoot(String),
    #[error("Access to excluded or sensitive file is forbidden: {0}")]
    Forbidden(String),
    #[error("Target is not a regular file: {0}")]
    NotARegularFile(String),
    #[error("File exceeds maximum allowed size ({actual} bytes > {max} bytes)")]
    ExceedsLimit { actual: u64, max: u64 },
    #[error("File contains invalid UTF-8")]
    InvalidUtf8,
    #[error("Filesystem IO error: {0}")]
    Io(#[from] std::io::Error),
}

/// Validates that a path is a safe relative path within the repository root:
/// - Rejects empty paths.
/// - Rejects absolute paths (starting with `/`, `\`, or Windows drive prefixes).
/// - Rejects path traversal (`..` components).
/// - Rejects null bytes (`\0`).
/// - Normalizes separators (`\` to `/`).
/// - Permits legitimate filenames containing adjacent periods, e.g. `src/component..ts`.
pub fn is_safe_relative_path(path_str: &str) -> bool {
    let trimmed_start = path_str.trim_start();
    if path_str.trim().is_empty()
        || trimmed_start.starts_with('/')
        || trimmed_start.starts_with('\\')
        || path_str.contains('\0')
    {
        return false;
    }
    // Check for Windows drive prefix uniformly across all operating systems (e.g. "C:", "d:/", etc.)
    if trimmed_start.len() >= 2
        && trimmed_start.as_bytes()[0].is_ascii_alphabetic()
        && trimmed_start.as_bytes()[1] == b':'
    {
        return false;
    }
    // Normalize backslashes to forward slashes for cross-platform component parsing
    let normalized = path_str.replace('\\', "/");
    let path = std::path::Path::new(&normalized);
    if path.is_absolute() {
        return false;
    }
    for component in path.components() {
        match component {
            std::path::Component::Normal(_) | std::path::Component::CurDir => {}
            std::path::Component::ParentDir
            | std::path::Component::RootDir
            | std::path::Component::Prefix(_) => return false,
        }
    }
    true
}

#[cfg(target_os = "macos")]
fn get_fd_path(fd: std::os::unix::io::RawFd) -> Option<PathBuf> {
    extern "C" {
        fn fcntl(fd: i32, cmd: i32, ...) -> i32;
    }
    const F_GETPATH: i32 = 50;
    let mut buf = vec![0u8; 1024];
    let res = unsafe { fcntl(fd, F_GETPATH, buf.as_mut_ptr()) };
    if res != -1 {
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        let s = std::str::from_utf8(&buf[..len]).ok()?;
        Some(PathBuf::from(s))
    } else {
        None
    }
}

#[cfg(target_os = "linux")]
fn get_fd_path(fd: std::os::unix::io::RawFd) -> Option<PathBuf> {
    std::fs::read_link(format!("/proc/self/fd/{fd}")).ok()
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn get_fd_path(_fd: std::os::unix::io::RawFd) -> Option<PathBuf> {
    None
}

/// Safely opens and reads a repository-scoped file with strict TOCTOU race mitigation,
/// bounded resource usage, non-blocking rejection of FIFOs/special files, and sensitive path enforcement.
pub fn safe_read_file_to_string(
    root: &Path,
    rel_path: &str,
    max_bytes: u64,
) -> Result<String, SafeReadError> {
    if !is_safe_relative_path(rel_path) {
        return Err(SafeReadError::InvalidPath);
    }

    // 1. Initial exclusion check on requested relative path
    if RepositoryScanner::is_excluded_relative_path(rel_path) {
        warn!("Blocked access to excluded sensitive path: {rel_path}");
        return Err(SafeReadError::Forbidden(rel_path.to_string()));
    }

    let canonical_root = root
        .canonicalize()
        .map_err(|e| SafeReadError::NotFound(format!("Failed to resolve repository root: {e}")))?;

    let target = canonical_root.join(rel_path);

    // 2. Open handle with O_NONBLOCK on Unix to prevent indefinite hangs on FIFOs or named pipes
    #[cfg(unix)]
    let file = {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(O_NONBLOCK)
            .open(&target)
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    SafeReadError::NotFound(rel_path.to_string())
                } else {
                    SafeReadError::Io(e)
                }
            })?
    };

    #[cfg(not(unix))]
    let file = std::fs::File::open(&target).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            SafeReadError::NotFound(rel_path.to_string())
        } else {
            SafeReadError::Io(e)
        }
    })?;

    // 3. Inspect metadata from the open file handle (avoids symlink race against directory or FIFO)
    let metadata = file
        .metadata()
        .map_err(|e| SafeReadError::NotFound(format!("Failed to read metadata: {e}")))?;

    if !metadata.file_type().is_file() {
        return Err(SafeReadError::NotARegularFile(rel_path.to_string()));
    }

    if metadata.len() > max_bytes {
        return Err(SafeReadError::ExceedsLimit {
            actual: metadata.len(),
            max: max_bytes,
        });
    }

    // 4. Inspect physical path of open descriptor (or canonical target fallback) to eliminate escapes
    #[cfg(unix)]
    let opened_path_opt = {
        use std::os::unix::io::AsRawFd;
        get_fd_path(file.as_raw_fd())
    };
    #[cfg(not(unix))]
    let opened_path_opt: Option<PathBuf> = None;

    let physical_path = match opened_path_opt {
        Some(p) => p,
        None => target.canonicalize().unwrap_or_else(|_| target.clone()),
    };

    let canon_opened = physical_path
        .canonicalize()
        .unwrap_or_else(|_| physical_path.clone());

    if !canon_opened.starts_with(&canonical_root) {
        warn!(
            "Blocked escape: {rel_path} resolves outside repo root to {}",
            canon_opened.display()
        );
        return Err(SafeReadError::EscapesRoot(rel_path.to_string()));
    }

    if let Ok(opened_rel) = canon_opened.strip_prefix(&canonical_root) {
        let opened_rel_str = opened_rel.to_string_lossy().replace('\\', "/");
        if RepositoryScanner::is_excluded_relative_path(&opened_rel_str) {
            warn!("Blocked symlink to sensitive file: {opened_rel_str}");
            return Err(SafeReadError::Forbidden(opened_rel_str));
        }
    }

    // 5. Read bounded contents strictly up to max_bytes + 1
    let mut buffer = Vec::with_capacity(std::cmp::min(metadata.len(), max_bytes) as usize);
    let bytes_read = file
        .take(max_bytes + 1)
        .read_to_end(&mut buffer)
        .map_err(SafeReadError::Io)?;

    if bytes_read as u64 > max_bytes {
        return Err(SafeReadError::ExceedsLimit {
            actual: bytes_read as u64,
            max: max_bytes,
        });
    }

    // 6. Enforce valid UTF-8
    String::from_utf8(buffer).map_err(|_| SafeReadError::InvalidUtf8)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn test_is_safe_relative_path_boundaries() {
        assert!(is_safe_relative_path("src/main.ts"));
        assert!(is_safe_relative_path("src/component..ts"));
        assert!(is_safe_relative_path("src/path with spaces/file.tsx"));
        assert!(is_safe_relative_path("src/🚀/unicode.ts"));

        assert!(!is_safe_relative_path(""));
        assert!(!is_safe_relative_path("   "));
        assert!(!is_safe_relative_path("/etc/passwd"));
        assert!(!is_safe_relative_path("\\windows\\system32"));
        assert!(!is_safe_relative_path("C:/Users/file.ts"));
        assert!(!is_safe_relative_path("c:\\Users\\file.ts"));
        assert!(!is_safe_relative_path("../outside.ts"));
        assert!(!is_safe_relative_path("src/../../outside.ts"));
        assert!(!is_safe_relative_path("src/file\0.ts"));
    }

    #[test]
    fn test_safe_read_normal_file() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join("hello.ts");
        fs::write(&file_path, "export const msg = 'hello';").unwrap();

        let content = safe_read_file_to_string(dir.path(), "hello.ts", 1024).unwrap();
        assert_eq!(content, "export const msg = 'hello';");
    }

    #[test]
    fn test_safe_read_file_with_spaces() {
        let dir = tempdir().unwrap();
        let file_path = dir.path().join(" spaced file .ts");
        fs::write(&file_path, "content with spaces").unwrap();

        let content = safe_read_file_to_string(dir.path(), " spaced file .ts", 1024).unwrap();
        assert_eq!(content, "content with spaces");
    }

    #[test]
    fn test_safe_read_rejects_excluded_files() {
        let dir = tempdir().unwrap();
        let env_path = dir.path().join(".env");
        fs::write(&env_path, "SECRET=xyz").unwrap();

        let err = safe_read_file_to_string(dir.path(), ".env", 1024).unwrap_err();
        assert!(matches!(err, SafeReadError::Forbidden(_)));
    }

    #[test]
    fn test_safe_read_enforces_size_limit() {
        let dir = tempdir().unwrap();
        let large_path = dir.path().join("large.ts");
        let data = "x".repeat(2000);
        fs::write(&large_path, data).unwrap();

        let err = safe_read_file_to_string(dir.path(), "large.ts", 1000).unwrap_err();
        assert!(
            matches!(err, SafeReadError::ExceedsLimit { actual, max } if actual >= 1000 && max == 1000)
        );
    }

    #[test]
    fn test_safe_read_rejects_directory() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("subdir")).unwrap();

        let err = safe_read_file_to_string(dir.path(), "subdir", 1024).unwrap_err();
        assert!(matches!(err, SafeReadError::NotARegularFile(_)));
    }

    #[test]
    fn test_safe_read_rejects_invalid_utf8() {
        let dir = tempdir().unwrap();
        let bin_path = dir.path().join("binary.dat");
        fs::write(&bin_path, vec![0xFF, 0xFE, 0xFD]).unwrap();

        let err = safe_read_file_to_string(dir.path(), "binary.dat", 1024).unwrap_err();
        assert!(matches!(err, SafeReadError::InvalidUtf8));
    }

    #[cfg(unix)]
    #[test]
    fn test_safe_read_rejects_external_symlink() {
        let dir = tempdir().unwrap();
        let outside_dir = tempdir().unwrap();
        let outside_file = outside_dir.path().join("outside.ts");
        fs::write(&outside_file, "external secret").unwrap();

        let symlink_path = dir.path().join("escape_link.ts");
        std::os::unix::fs::symlink(&outside_file, &symlink_path).unwrap();

        let err = safe_read_file_to_string(dir.path(), "escape_link.ts", 1024).unwrap_err();
        assert!(matches!(err, SafeReadError::EscapesRoot(_)));
    }

    #[cfg(unix)]
    #[test]
    fn test_safe_read_rejects_fifo_nonblocking() {
        let dir = tempdir().unwrap();
        let fifo_path = dir.path().join("stream.fifo");

        extern "C" {
            fn mkfifo(path: *const std::os::raw::c_char, mode: u32) -> i32;
        }

        use std::ffi::CString;
        let c_path = CString::new(fifo_path.to_str().unwrap()).unwrap();
        let res = unsafe { mkfifo(c_path.as_ptr(), 0o600) };
        if res == 0 {
            let start = std::time::Instant::now();
            let err = safe_read_file_to_string(dir.path(), "stream.fifo", 1024).unwrap_err();
            // Opening FIFO non-blocking must return promptly without hanging
            assert!(start.elapsed() < std::time::Duration::from_millis(500));
            assert!(matches!(err, SafeReadError::NotARegularFile(_)));
        }
    }
}
