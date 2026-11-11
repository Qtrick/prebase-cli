use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use prebase_core::model::WatcherHealth;
use prebase_core::RepositoryScanner;
use prebase_parser::RepositoryAnalyzer;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};
use tracing::{debug, error, info, warn};

use crate::state::AppState;

pub struct RepoWatcherHandle {
    pub shutdown_tx: oneshot::Sender<()>,
    pub task_handle: tokio::task::JoinHandle<()>,
}

pub fn start_repo_watcher(state: Arc<AppState>) -> Result<RepoWatcherHandle, notify::Error> {
    let root_path = state.root_path.clone();
    let (tx, mut rx) = mpsc::channel::<PathBuf>(1024);

    let overflow_flag = Arc::new(AtomicBool::new(false));
    let overflow_cb = overflow_flag.clone();
    let state_cb = state.clone();

    let tx_clone = tx.clone();
    let mut watcher = RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| match res {
            Ok(event) => match event.kind {
                EventKind::Access(_) => {}
                _ => {
                    if event.paths.is_empty() {
                        overflow_cb.store(true, Ordering::SeqCst);
                        let _ = tx_clone.try_send(PathBuf::new());
                    } else {
                        for path in event.paths {
                            if let Err(mpsc::error::TrySendError::Full(_)) = tx_clone.try_send(path)
                            {
                                warn!(
                                    "Filesystem watcher channel full, setting overflow flag for rescan"
                                );
                                overflow_cb.store(true, Ordering::SeqCst);
                            }
                        }
                    }
                }
            },
            Err(e) => {
                warn!("Filesystem watcher event error: {e}");
                overflow_cb.store(true, Ordering::SeqCst);
                state_cb.set_watcher_health(WatcherHealth::Degraded);
                let _ = tx_clone.try_send(PathBuf::new());
            }
        },
        notify::Config::default(),
    )?;

    watcher.watch(&root_path, RecursiveMode::Recursive)?;

    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();

    let task_handle = tokio::spawn(async move {
        // Keep watcher alive in this async task
        let _watcher = watcher;

        let mut changed_sources: HashSet<String> = HashSet::new();
        let mut git_ref_changed = false;
        let mut full_rescan_needed = false;

        // Single-flight analysis coordinator state
        let mut is_analyzing = false;
        let mut pending_after_analysis = false;
        let (completion_tx, mut completion_rx) = mpsc::channel::<()>(1);
        let mut active_task: Option<tokio::task::JoinHandle<()>> = None;

        loop {
            if overflow_flag.swap(false, Ordering::SeqCst) {
                full_rescan_needed = true;
            }

            tokio::select! {
                _ = &mut shutdown_rx => {
                    info!("Filesystem watcher received shutdown signal");
                    state.set_shutting_down();
                    if let Some(mut handle) = active_task.take() {
                        handle.abort();
                        let _ = tokio::time::timeout(Duration::from_millis(500), &mut handle).await;
                    }
                    break;
                }
                _ = completion_rx.recv() => {
                    is_analyzing = false;
                    state.set_analyzing(false);
                    if let Some(handle) = active_task.take() {
                        let _ = handle.await;
                    }
                    debug!("Background repository reanalysis finished");

                    // Drain git ref changes if any arrived while analyzing
                    if git_ref_changed {
                        git_ref_changed = false;
                        debug!("Git ref change detected during reanalysis; notifying subscribers");
                        state.notify_git_updated();
                    }

                    // If modifications arrived while analysis was running, trigger next single-flight analysis
                    if pending_after_analysis || full_rescan_needed || !changed_sources.is_empty() {
                        pending_after_analysis = false;
                        if overflow_flag.swap(false, Ordering::SeqCst) {
                            full_rescan_needed = true;
                        }

                        let files_to_report =
                            drain_pending_changes(&mut full_rescan_needed, &mut changed_sources);

                        info!(
                            "Reanalyzing repository following coalesced filesystem changes in {} file(s)...",
                            files_to_report.len()
                        );

                        is_analyzing = true;
                        state.set_analyzing(true);
                        let generation = state.get_next_generation();
                        active_task = Some(spawn_reanalysis(
                            state.clone(),
                            files_to_report,
                            generation,
                            completion_tx.clone(),
                        ));
                    }
                }
                msg_opt = rx.recv() => {
                    if overflow_flag.swap(false, Ordering::SeqCst) {
                        full_rescan_needed = true;
                    }

                    match msg_opt {
                        Some(path) => {
                            if path.as_os_str().is_empty() {
                                continue;
                            }
                            if let Some(rel) = extract_relative_path(&path, &state.root_path, &state.canonical_root) {
                                if is_git_ref_path(&rel) {
                                    git_ref_changed = true;
                                    continue;
                                }

                                if should_ignore_path(&rel) {
                                    continue;
                                }

                                if is_supported_source_file(&path) {
                                    changed_sources.insert(rel.to_string_lossy().replace('\\', "/"));
                                    if is_analyzing || state.is_analyzing() {
                                        pending_after_analysis = true;
                                    }
                                } else {
                                    // Any other non-ignored filesystem change (e.g. README.md, styles.css, directory changes)
                                    // requires a full rescan to maintain truthful discovered file counts, coverage, and metadata.
                                    full_rescan_needed = true;
                                    if is_analyzing || state.is_analyzing() {
                                        pending_after_analysis = true;
                                    }
                                }
                            }
                        }
                        None => {
                            debug!("Watcher channel closed");
                            break;
                        }
                    }
                }
                _ = tokio::time::sleep(Duration::from_millis(200)), if !is_analyzing && !state.is_analyzing() && (!changed_sources.is_empty() || git_ref_changed || full_rescan_needed || overflow_flag.load(Ordering::SeqCst)) => {
                    if overflow_flag.swap(false, Ordering::SeqCst) {
                        full_rescan_needed = true;
                    }

                    // Debounce window elapsed with pending changes
                    if git_ref_changed {
                        git_ref_changed = false;
                        debug!("Git ref change detected; notifying subscribers");
                        state.notify_git_updated();
                    }

                    if full_rescan_needed || !changed_sources.is_empty() {
                        let files_to_report =
                            drain_pending_changes(&mut full_rescan_needed, &mut changed_sources);

                        info!(
                            "Reanalyzing repository following filesystem changes in {} file(s)...",
                            files_to_report.len()
                        );

                        is_analyzing = true;
                        state.set_analyzing(true);
                        let generation = state.get_next_generation();
                        active_task = Some(spawn_reanalysis(
                            state.clone(),
                            files_to_report,
                            generation,
                            completion_tx.clone(),
                        ));
                    }
                }
            }
        }
    });

    Ok(RepoWatcherHandle {
        shutdown_tx,
        task_handle,
    })
}

/// Consume the coalesced change set into the file list reported to subscribers.
/// A full rescan is reported as the wildcard entry.
fn drain_pending_changes(
    full_rescan_needed: &mut bool,
    changed_sources: &mut HashSet<String>,
) -> Vec<String> {
    if *full_rescan_needed {
        *full_rescan_needed = false;
        changed_sources.clear();
        vec!["*".to_string()]
    } else {
        changed_sources.drain().collect()
    }
}

/// Start one blocking reanalysis. The completion signal flips `is_analyzing`
/// so the coordinator can run exactly one analysis at a time.
fn spawn_reanalysis(
    state: Arc<AppState>,
    files_to_report: Vec<String>,
    generation: u64,
    completion_tx: mpsc::Sender<()>,
) -> tokio::task::JoinHandle<()> {
    tokio::task::spawn_blocking(move || {
        if state.is_shutting_down() {
            state.set_analyzing(false);
            let _ = completion_tx.try_send(());
            return;
        }
        let start = std::time::Instant::now();
        let state_cancel = state.clone();
        let analyzer = RepositoryAnalyzer::default();
        match analyzer
            .analyze_path_cancellable(&state.root_path, move || state_cancel.is_shutting_down())
        {
            Ok(result) => {
                if state.is_shutting_down() {
                    state.set_analyzing(false);
                    let _ = completion_tx.try_send(());
                    return;
                }
                let duration = start.elapsed().as_millis() as u64;
                match state.publish_network(
                    result.snapshot,
                    result.index,
                    files_to_report,
                    Some(generation),
                ) {
                    Ok(_rev) => {
                        // Only record duration when this generation was accepted and published.
                        state.set_analysis_duration(duration);
                        if state.get_watcher_health() == WatcherHealth::Degraded {
                            state.set_watcher_health(WatcherHealth::Active);
                        }
                    }
                    Err(err) => {
                        debug!("Rejected stale reanalysis generation {generation}: {err}");
                    }
                }
            }
            Err(err) => {
                if !state.is_shutting_down() {
                    error!("Reanalysis failed on filesystem change: {err}");
                    state.set_watcher_health(WatcherHealth::Degraded);
                }
            }
        }
        state.set_analyzing(false);
        let _ = completion_tx.try_send(());
    })
}

/// Robustly extracts the relative path of an event target within the repository root,
/// accounting for macOS `/private/var` vs `/var` symlink aliasing, path canonicalization,
/// and parent canonicalization for deleted files.
pub fn extract_relative_path(
    path: &Path,
    root_path: &Path,
    canonical_root: &Path,
) -> Option<PathBuf> {
    if let Ok(rel) = path.strip_prefix(root_path) {
        return Some(rel.to_path_buf());
    }
    if let Ok(rel) = path.strip_prefix(canonical_root) {
        return Some(rel.to_path_buf());
    }

    // Helper to normalize macOS `/private/...` to `/...` while preserving absolute path
    let unprivate = |p: &Path| -> PathBuf {
        if let Ok(rel) = p.strip_prefix("/private") {
            Path::new("/").join(rel)
        } else {
            p.to_path_buf()
        }
    };

    let path_norm = unprivate(path);
    let root_norm = unprivate(root_path);
    let canon_norm = unprivate(canonical_root);

    if let Ok(rel) = path_norm.strip_prefix(&root_norm) {
        return Some(rel.to_path_buf());
    }
    if let Ok(rel) = path_norm.strip_prefix(&canon_norm) {
        return Some(rel.to_path_buf());
    }

    // Attempt canonicalization for existing path
    if let Ok(canonical_path) = path.canonicalize() {
        if let Ok(rel) = canonical_path.strip_prefix(canonical_root) {
            return Some(rel.to_path_buf());
        }
        if let Ok(rel) = canonical_path.strip_prefix(root_path) {
            return Some(rel.to_path_buf());
        }
    } else if let Some(parent) = path.parent() {
        // For deleted or newly unlinked files, canonicalize existing parent directory
        if let Ok(canonical_parent) = parent.canonicalize() {
            if let Some(file_name) = path.file_name() {
                let canonical_target = canonical_parent.join(file_name);
                if let Ok(rel) = canonical_target.strip_prefix(canonical_root) {
                    return Some(rel.to_path_buf());
                }
                if let Ok(rel) = canonical_target.strip_prefix(root_path) {
                    return Some(rel.to_path_buf());
                }
            }
        }
    }
    None
}

fn is_git_ref_path(rel_path: &Path) -> bool {
    let mut comps = rel_path.components();
    match comps.next() {
        Some(std::path::Component::Normal(first)) if first.to_string_lossy() == ".git" => {}
        _ => return false,
    }
    match comps.next() {
        Some(std::path::Component::Normal(second)) => {
            let s = second.to_string_lossy();
            s == "HEAD" || s == "refs" || s == "packed-refs"
        }
        _ => false,
    }
}

fn should_ignore_path(rel_path: &Path) -> bool {
    let rel_str = rel_path.to_string_lossy();
    if RepositoryScanner::is_excluded_relative_path(&rel_str) {
        return true;
    }

    if let Some(file_name) = rel_path.file_name().and_then(|n| n.to_str()) {
        if file_name == ".DS_Store" || file_name.ends_with('~') || file_name.ends_with(".tmp") {
            return true;
        }
    }

    false
}

fn is_supported_source_file(path: &Path) -> bool {
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if file_name == "tsconfig.json" || file_name == "jsconfig.json" || file_name == "package.json" {
        return true;
    }
    matches!(
        path.extension().and_then(|ext| ext.to_str()),
        Some("js" | "jsx" | "ts" | "tsx" | "mjs" | "cjs" | "mts" | "cts" | "json")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_drain_pending_changes_coalesces_and_resets_state() {
        let mut full_rescan = false;
        let mut changed: HashSet<String> = ["src/a.ts".to_string(), "src/b.ts".to_string()]
            .into_iter()
            .collect();

        let mut files = drain_pending_changes(&mut full_rescan, &mut changed);
        files.sort();
        assert_eq!(files, vec!["src/a.ts".to_string(), "src/b.ts".to_string()]);
        assert!(changed.is_empty());
        assert!(!full_rescan);

        // A pending full rescan wins over individual paths and clears them.
        let mut full_rescan = true;
        let mut changed: HashSet<String> = ["src/a.ts".to_string()].into_iter().collect();
        let files = drain_pending_changes(&mut full_rescan, &mut changed);
        assert_eq!(files, vec!["*".to_string()]);
        assert!(!full_rescan);
        assert!(changed.is_empty());
    }

    #[test]
    fn test_component_aware_filesystem_filtering() {
        // Files containing 'dist' or 'target' as substrings must NOT be ignored
        assert!(!should_ignore_path(Path::new("src/distribution.ts")));
        assert!(!should_ignore_path(Path::new("src/distance.tsx")));
        assert!(!should_ignore_path(Path::new("src/targeting/index.ts")));
        assert!(!should_ignore_path(Path::new("target_file.js")));

        // Exact folder components MUST be ignored
        assert!(should_ignore_path(Path::new("dist/index.js")));
        assert!(should_ignore_path(Path::new("target/debug/prebase")));
        assert!(should_ignore_path(Path::new("node_modules/pkg/index.js")));
        assert!(should_ignore_path(Path::new(".next/server/page.js")));
        assert!(should_ignore_path(Path::new("build/static/bundle.js")));
        assert!(should_ignore_path(Path::new("coverage/lcov.info")));
        assert!(should_ignore_path(Path::new(".git/config")));
        assert!(should_ignore_path(Path::new("src/.DS_Store")));
        assert!(should_ignore_path(Path::new("src/temp.tmp")));

        // Sensitive and case-insensitive folders match scanner boundaries
        assert!(should_ignore_path(Path::new(".ssh/id_rsa")));
        assert!(should_ignore_path(Path::new(".aws/credentials")));
        assert!(should_ignore_path(Path::new(".gnupg/secring.gpg")));
        assert!(should_ignore_path(Path::new("NODE_MODULES/package.json")));
        assert!(should_ignore_path(Path::new(".env")));
        assert!(should_ignore_path(Path::new("secrets.key")));
    }

    #[test]
    fn test_watcher_policy_for_unsupported_non_ignored_files() {
        // Non-source files that are NOT ignored (e.g. README.md, styles.css, notes.txt)
        assert!(!should_ignore_path(Path::new("README.md")));
        assert!(!is_supported_source_file(Path::new("README.md")));

        assert!(!should_ignore_path(Path::new("styles.css")));
        assert!(!is_supported_source_file(Path::new("styles.css")));

        assert!(!should_ignore_path(Path::new("docs/architecture.txt")));
        assert!(!is_supported_source_file(Path::new(
            "docs/architecture.txt"
        )));

        // Ignored files MUST remain ignored
        assert!(should_ignore_path(Path::new(".DS_Store")));
        assert!(should_ignore_path(Path::new("nested/.DS_Store")));
        assert!(should_ignore_path(Path::new(".git/config")));
        assert!(should_ignore_path(Path::new("node_modules/pkg/index.js")));
        assert!(should_ignore_path(Path::new(".env")));
        assert!(should_ignore_path(Path::new("backup.tmp")));
    }

    #[test]
    fn test_git_ref_path_detection() {
        assert!(is_git_ref_path(Path::new(".git/HEAD")));
        assert!(is_git_ref_path(Path::new(".git/refs/heads/main")));
        assert!(is_git_ref_path(Path::new(".git/packed-refs")));

        // Non-ref git files must return false
        assert!(!is_git_ref_path(Path::new(".git/config")));
        assert!(!is_git_ref_path(Path::new(".git/index")));
        assert!(!is_git_ref_path(Path::new(".git/objects/12/3456")));
        assert!(!is_git_ref_path(Path::new("src/HEAD")));
    }

    #[test]
    fn test_supported_source_file_extensions() {
        assert!(is_supported_source_file(Path::new("index.ts")));
        assert!(is_supported_source_file(Path::new("component.tsx")));
        assert!(is_supported_source_file(Path::new("server.js")));
        assert!(is_supported_source_file(Path::new("module.mjs")));
        assert!(is_supported_source_file(Path::new("common.cjs")));
        assert!(is_supported_source_file(Path::new("types.mts")));
        assert!(is_supported_source_file(Path::new("package.json")));
        assert!(is_supported_source_file(Path::new("tsconfig.json")));

        assert!(!is_supported_source_file(Path::new("image.png")));
        assert!(!is_supported_source_file(Path::new("binary.exe")));
    }

    #[test]
    fn test_extract_relative_path_canonical_and_private_aliasing() {
        let root = Path::new("/var/folders/3d/project");
        let canonical_root = Path::new("/private/var/folders/3d/project");

        // Case 1: Exact root prefix
        assert_eq!(
            extract_relative_path(
                Path::new("/var/folders/3d/project/src/app.ts"),
                root,
                canonical_root
            ),
            Some(PathBuf::from("src/app.ts"))
        );

        // Case 2: Canonical root prefix
        assert_eq!(
            extract_relative_path(
                Path::new("/private/var/folders/3d/project/src/app.ts"),
                root,
                canonical_root
            ),
            Some(PathBuf::from("src/app.ts"))
        );

        // Case 3: Root is non-canonical, path is canonical
        assert_eq!(
            extract_relative_path(
                Path::new("/private/var/folders/3d/project/src/live.ts"),
                root,
                root
            ),
            Some(PathBuf::from("src/live.ts"))
        );

        // Case 4: Root is canonical, path is non-canonical
        assert_eq!(
            extract_relative_path(
                Path::new("/var/folders/3d/project/src/live.ts"),
                canonical_root,
                canonical_root
            ),
            Some(PathBuf::from("src/live.ts"))
        );

        // Case 5: Path outside root
        assert_eq!(
            extract_relative_path(Path::new("/etc/passwd"), root, canonical_root),
            None
        );
    }
}
