use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use prebase_core::model::WatcherHealth;
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
                EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) => {
                    for path in event.paths {
                        if let Err(mpsc::error::TrySendError::Full(_)) = tx_clone.try_send(path) {
                            warn!(
                                "Filesystem watcher channel full, setting overflow flag for rescan"
                            );
                            overflow_cb.store(true, Ordering::SeqCst);
                        }
                    }
                }
                _ => {}
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

    tokio::spawn(async move {
        // Keep watcher alive in this async task
        let _watcher = watcher;

        let mut changed_sources: HashSet<String> = HashSet::new();
        let mut git_ref_changed = false;
        let mut full_rescan_needed = false;

        loop {
            if overflow_flag.swap(false, Ordering::SeqCst) {
                full_rescan_needed = true;
            }

            tokio::select! {
                _ = &mut shutdown_rx => {
                    info!("Filesystem watcher received shutdown signal");
                    break;
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
                            if let Ok(rel) = path.strip_prefix(&state.root_path) {
                                if is_git_ref_path(rel) {
                                    git_ref_changed = true;
                                    continue;
                                }

                                if should_ignore_path(rel) {
                                    continue;
                                }

                                if is_supported_source_file(&path) {
                                    changed_sources.insert(rel.to_string_lossy().to_string());
                                }
                            }
                        }
                        None => {
                            debug!("Watcher channel closed");
                            break;
                        }
                    }
                }
                _ = tokio::time::sleep(Duration::from_millis(200)), if !changed_sources.is_empty() || git_ref_changed || full_rescan_needed || overflow_flag.load(Ordering::SeqCst) => {
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
                        let files_to_report: Vec<String> = if full_rescan_needed {
                            full_rescan_needed = false;
                            changed_sources.clear();
                            vec!["*".to_string()]
                        } else {
                            changed_sources.drain().collect()
                        };

                        info!(
                            "Detected filesystem changes in {} source files. Triggering incremental reanalysis...",
                            files_to_report.len()
                        );

                        let generation = state.get_next_generation();
                        let state_clone = state.clone();
                        let root_clone = state.root_path.clone();

                        tokio::task::spawn_blocking(move || {
                            let analyzer = RepositoryAnalyzer::default();
                            match analyzer.analyze_path(&root_clone) {
                                Ok(result) => {
                                    let _ = state_clone.publish_network(
                                        result.snapshot,
                                        result.index,
                                        files_to_report,
                                        Some(generation),
                                    );
                                    if state_clone.get_watcher_health() == WatcherHealth::Degraded {
                                        state_clone.set_watcher_health(WatcherHealth::Active);
                                    }
                                }
                                Err(err) => {
                                    error!("Reanalysis failed on filesystem change: {err}");
                                    state_clone.set_watcher_health(WatcherHealth::Degraded);
                                }
                            }
                        });
                    }
                }
            }
        }
    });

    Ok(RepoWatcherHandle { shutdown_tx })
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
    for comp in rel_path.components() {
        if let std::path::Component::Normal(os_name) = comp {
            let s = os_name.to_string_lossy();
            match s.as_ref() {
                "node_modules" | "target" | "dist" | "build" | ".build" | ".next" | ".nuxt"
                | "coverage" | ".reference" | ".cache" | ".turbo" | ".vscode" | ".idea"
                | ".cursor" | ".agents" | ".codex" | ".git" => return true,
                _ => {}
            }
        }
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
}
