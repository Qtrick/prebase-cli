use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use prebase_parser::RepositoryAnalyzer;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};
use tracing::{debug, error, info, warn};

use crate::state::AppState;

pub struct RepoWatcherHandle {
    pub shutdown_tx: oneshot::Sender<()>,
}

enum WatcherMsg {
    Path(PathBuf),
    Overflow,
}

pub fn start_repo_watcher(state: Arc<AppState>) -> Result<RepoWatcherHandle, notify::Error> {
    let root_path = state.root_path.clone();
    let (tx, mut rx) = mpsc::channel::<WatcherMsg>(1024);

    let tx_clone = tx.clone();
    let mut watcher = RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| match res {
            Ok(event) => match event.kind {
                EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) => {
                    for path in event.paths {
                        if let Err(mpsc::error::TrySendError::Full(_)) =
                            tx_clone.try_send(WatcherMsg::Path(path))
                        {
                            warn!("Filesystem watcher channel full, queuing overflow rescan");
                            let _ = tx_clone.try_send(WatcherMsg::Overflow);
                        }
                    }
                }
                _ => {}
            },
            Err(e) => {
                warn!("Filesystem watcher event error: {e}");
            }
        },
        notify::Config::default(),
    )?;

    watcher.watch(&root_path, RecursiveMode::Recursive)?;

    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();

    tokio::spawn(async move {
        // Keep watcher alive in this async task
        let _watcher = watcher;
        let mut debounce_timer = tokio::time::interval(Duration::from_millis(250));
        debounce_timer.tick().await; // consume first instant tick

        let mut changed_sources: HashSet<String> = HashSet::new();
        let mut git_ref_changed = false;
        let mut full_rescan_needed = false;

        loop {
            tokio::select! {
                _ = &mut shutdown_rx => {
                    info!("Filesystem watcher received shutdown signal");
                    break;
                }
                msg_opt = rx.recv() => {
                    match msg_opt {
                        Some(WatcherMsg::Overflow) => {
                            full_rescan_needed = true;
                        }
                        Some(WatcherMsg::Path(path)) => {
                            let path_str = path.to_string_lossy();

                            // Filter out ignored patterns
                            if path_str.contains("node_modules")
                                || path_str.contains("/target/")
                                || path_str.contains("/dist/")
                                || path_str.contains("/.reference/")
                                || path_str.contains(".DS_Store")
                                || path_str.ends_with('~')
                                || path_str.ends_with(".tmp")
                            {
                                continue;
                            }

                            // Check git refs changes
                            if path_str.contains(".git/HEAD")
                                || path_str.contains(".git/refs/")
                                || path_str.contains(".git/packed-refs")
                            {
                                git_ref_changed = true;
                                continue;
                            }

                            // If inside .git but not a ref, ignore
                            if path_str.contains("/.git/") {
                                continue;
                            }

                            // Check source file extensions or config files
                            if is_supported_source_file(&path) {
                                if let Ok(rel) = path.strip_prefix(&state.root_path) {
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
                _ = tokio::time::sleep(Duration::from_millis(200)), if !changed_sources.is_empty() || git_ref_changed || full_rescan_needed => {
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
                                }
                                Err(err) => {
                                    error!("Reanalysis failed on filesystem change: {err}");
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

fn is_supported_source_file(path: &Path) -> bool {
    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if file_name == "tsconfig.json" || file_name == "jsconfig.json" || file_name == "package.json" {
        return true;
    }
    matches!(
        path.extension().and_then(|ext| ext.to_str()),
        Some("js" | "jsx" | "ts" | "tsx")
    )
}
