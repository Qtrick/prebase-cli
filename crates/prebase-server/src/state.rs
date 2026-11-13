use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use prebase_core::index::GraphIndex;
use prebase_core::model::{GraphSnapshot, IndexingStatus, RepositoryInfo, WatcherHealth};
use prebase_git::GitEngine;
use serde::Serialize;
use tokio::sync::broadcast;
use tracing::info;

#[derive(Clone)]
pub struct PublishedNetworkState {
    pub revision: u64,
    pub snapshot: Arc<GraphSnapshot>,
    pub index: Arc<GraphIndex>,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", content = "data")]
pub enum ServerEvent {
    #[serde(rename = "network.updated")]
    NetworkUpdated {
        revision: u64,
        changed_files: Vec<String>,
        node_count: usize,
        edge_count: usize,
    },
    #[serde(rename = "git.updated")]
    GitUpdated {
        head_commit: Option<String>,
        branch: Option<String>,
    },
    #[serde(rename = "reconcile.required")]
    ReconcileRequired { current_revision: u64 },
    #[serde(rename = "heartbeat")]
    Heartbeat { timestamp: u64 },
}

pub struct AppState {
    pub session_token: String,
    pub bootstrap_token: RwLock<Option<String>>,
    pub allocated_port: u16,
    pub root_path: PathBuf,
    pub canonical_root: PathBuf,
    pub repo_name: String,
    pub repo_id: String,
    pub status: RwLock<IndexingStatus>,
    pub published: RwLock<Option<Arc<PublishedNetworkState>>>,
    pub revision_counter: AtomicU64,
    pub analysis_generation: AtomicU64,
    pub analysis_duration_ms: AtomicU64,
    pub watcher_health: RwLock<WatcherHealth>,
    pub git_engine: Arc<GitEngine>,
    pub event_sender: broadcast::Sender<ServerEvent>,
    pub is_shutting_down: AtomicBool,
    pub is_analyzing: AtomicBool,
    pub process_output_paths: RwLock<HashSet<PathBuf>>,
}

impl AppState {
    pub fn new(
        root_path: PathBuf,
        repo_name: String,
        repo_id: String,
        session_token: String,
        bootstrap_token: Option<String>,
        allocated_port: u16,
        watch_filesystem: bool,
    ) -> Self {
        let (event_sender, _) = broadcast::channel(128);
        let git_engine = Arc::new(GitEngine::new(root_path.clone()));
        let initial_health = if watch_filesystem {
            WatcherHealth::Active
        } else {
            WatcherHealth::Disabled
        };
        let canonical_root = root_path
            .canonicalize()
            .unwrap_or_else(|_| root_path.clone());

        Self {
            session_token,
            bootstrap_token: RwLock::new(bootstrap_token),
            allocated_port,
            root_path,
            canonical_root: canonical_root.clone(),
            repo_name,
            repo_id,
            status: RwLock::new(IndexingStatus::NotStarted),
            published: RwLock::new(None),
            revision_counter: AtomicU64::new(0),
            analysis_generation: AtomicU64::new(0),
            analysis_duration_ms: AtomicU64::new(0),
            watcher_health: RwLock::new(initial_health),
            git_engine,
            event_sender,
            is_shutting_down: AtomicBool::new(false),
            is_analyzing: AtomicBool::new(false),
            process_output_paths: RwLock::new(detect_process_output_paths(&canonical_root)),
        }
    }

    /// Register an exact path (relative to canonical_root, or absolute) as a process-owned log destination.
    /// Files matching these registered paths are ignored by the filesystem watcher to prevent
    /// self-observation feedback loops when process stdout/stderr or diagnostics are written into the repository.
    pub fn register_process_log_path(&self, path: &Path) {
        let norm = if path.is_relative() {
            path.to_path_buf()
        } else {
            let canon_opt = path.canonicalize().ok().or_else(|| {
                path.parent()
                    .and_then(|p| p.canonicalize().ok())
                    .and_then(|parent_canon| path.file_name().map(|f| parent_canon.join(f)))
            });

            if let Some(ref canon) = canon_opt {
                if let Ok(rel) = canon.strip_prefix(&self.canonical_root) {
                    rel.to_path_buf()
                } else if let Ok(rel) = canon.strip_prefix(&self.root_path) {
                    rel.to_path_buf()
                } else {
                    path.to_path_buf()
                }
            } else if let Ok(rel) = path.strip_prefix(&self.canonical_root) {
                rel.to_path_buf()
            } else if let Ok(rel) = path.strip_prefix(&self.root_path) {
                rel.to_path_buf()
            } else {
                path.to_path_buf()
            }
        };
        let mut guard = self.process_output_paths.write().unwrap();
        guard.insert(norm);
    }

    /// Check if a relative path matches any registered or detected process-owned log destination.
    pub fn is_process_output_path(&self, rel_path: &Path) -> bool {
        let guard = self.process_output_paths.read().unwrap();
        if guard.contains(rel_path) {
            return true;
        }
        if let Ok(canon) = self.canonical_root.join(rel_path).canonicalize() {
            if let Ok(canon_rel) = canon.strip_prefix(&self.canonical_root) {
                if guard.contains(canon_rel) {
                    return true;
                }
            }
        }
        false
    }

    /// Validates and consumes the single-use bootstrap token, returning the session token.
    pub fn exchange_bootstrap_token(&self, candidate: &str) -> Option<String> {
        let mut guard = self.bootstrap_token.write().unwrap();
        if let Some(ref current) = *guard {
            if crate::auth::constant_time_eq(current, candidate) {
                *guard = None; // Single-use consumption
                return Some(self.session_token.clone());
            }
        }
        None
    }

    pub fn get_status(&self) -> IndexingStatus {
        self.status.read().unwrap().clone()
    }

    pub fn get_current_revision(&self) -> u64 {
        self.revision_counter.load(Ordering::SeqCst)
    }

    pub fn get_next_generation(&self) -> u64 {
        self.analysis_generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn current_generation(&self) -> u64 {
        self.analysis_generation.load(Ordering::SeqCst)
    }

    pub fn get_watcher_health(&self) -> WatcherHealth {
        *self.watcher_health.read().unwrap()
    }

    pub fn set_watcher_health(&self, health: WatcherHealth) {
        let mut guard = self.watcher_health.write().unwrap();
        *guard = health;
    }

    pub fn set_analysis_duration(&self, duration_ms: u64) {
        self.analysis_duration_ms
            .store(duration_ms, Ordering::SeqCst);
    }

    pub fn get_analysis_duration(&self) -> Option<u64> {
        let val = self.analysis_duration_ms.load(Ordering::SeqCst);
        if val > 0 {
            Some(val)
        } else {
            None
        }
    }

    pub fn is_shutting_down(&self) -> bool {
        self.is_shutting_down.load(Ordering::SeqCst)
    }

    pub fn set_shutting_down(&self) {
        self.is_shutting_down.store(true, Ordering::SeqCst);
    }

    pub fn is_analyzing(&self) -> bool {
        self.is_analyzing.load(Ordering::SeqCst)
    }

    pub fn set_analyzing(&self, analyzing: bool) {
        self.is_analyzing.store(analyzing, Ordering::SeqCst);
    }

    pub fn set_status(&self, status: IndexingStatus) {
        let mut guard = self.status.write().unwrap();
        *guard = status;
    }

    pub fn get_published(&self) -> Option<Arc<PublishedNetworkState>> {
        self.published.read().unwrap().clone()
    }

    pub fn get_repository_info(&self) -> RepositoryInfo {
        let revision = self.get_current_revision();
        let status = self.get_status();

        RepositoryInfo {
            repository_id: self.repo_id.clone(),
            repository_name: self.repo_name.clone(),
            repository_root_display: self.repo_name.clone(),
            analysis_revision: revision,
            indexing_status: status,
            watcher_health: self.get_watcher_health(),
        }
    }

    /// Atomically publishes a new Network graph revision under a single write lock,
    /// guaranteeing that readers never observe torn state (Finding C) and that
    /// revision counters are strictly monotonic (Finding D).
    pub fn publish_network(
        &self,
        mut snapshot: GraphSnapshot,
        index: GraphIndex,
        changed_files: Vec<String>,
        target_generation: Option<u64>,
    ) -> Result<u64, &'static str> {
        if self.is_shutting_down() {
            return Err("Server is shutting down; reanalysis publication discarded");
        }

        let mut pub_guard = self.published.write().unwrap();

        // Stale analysis check under write lock to prevent concurrency races
        if let Some(expected_gen) = target_generation {
            let current = self.current_generation();
            if expected_gen != current {
                self.set_analyzing(false);
                info!(
                    "Discarding stale analysis result (expected gen {}, current gen {})",
                    expected_gen, current
                );
                return Err("Stale analysis discarded");
            }
        }

        let new_revision = self.revision_counter.fetch_add(1, Ordering::SeqCst) + 1;
        snapshot.revision = new_revision;

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        let node_count = snapshot.nodes.len();
        let edge_count = snapshot.edges.len();

        let new_state = Arc::new(PublishedNetworkState {
            revision: new_revision,
            snapshot: Arc::new(snapshot),
            index: Arc::new(index),
            timestamp: now,
        });

        *pub_guard = Some(new_state);

        let mut st_guard = self.status.write().unwrap();
        *st_guard = IndexingStatus::Ready;

        info!(
            "Published network revision {} ({} nodes, {} edges)",
            new_revision, node_count, edge_count
        );

        self.set_analyzing(false);

        // Broadcast SSE update event
        let _ = self.event_sender.send(ServerEvent::NetworkUpdated {
            revision: new_revision,
            changed_files,
            node_count,
            edge_count,
        });

        Ok(new_revision)
    }

    pub fn set_failed(&self, _err_message: &str) {
        let mut st = self.status.write().unwrap();
        *st = IndexingStatus::Failed;
    }

    pub fn notify_git_updated(&self) {
        let status = self.git_engine.get_status().ok();
        let (head_commit, branch) = match status {
            Some(st) => (st.head_commit, st.branch),
            None => (None, None),
        };

        let _ = self.event_sender.send(ServerEvent::GitUpdated {
            head_commit,
            branch,
        });
    }

    pub fn root_path(&self) -> &Path {
        &self.root_path
    }
}

fn detect_process_output_paths(canonical_root: &Path) -> HashSet<PathBuf> {
    let mut paths = HashSet::new();
    // Check stdout (fd 1) and stderr (fd 2) for redirected process output files
    for fd in [1, 2] {
        if let Some(target) = get_fd_path(fd) {
            if let Ok(canon_target) = target.canonicalize() {
                if let Ok(rel) = canon_target.strip_prefix(canonical_root) {
                    paths.insert(rel.to_path_buf());
                }
            } else if let Ok(rel) = target.strip_prefix(canonical_root) {
                paths.insert(rel.to_path_buf());
            }
        }
    }
    // Also check PREBASE_PROCESS_LOG_PATH or PREBASE_LOG_FILE env var if set
    if let Ok(env_path) =
        std::env::var("PREBASE_PROCESS_LOG_PATH").or_else(|_| std::env::var("PREBASE_LOG_FILE"))
    {
        let p = PathBuf::from(env_path);
        if let Ok(canon_target) = p.canonicalize() {
            if let Ok(rel) = canon_target.strip_prefix(canonical_root) {
                paths.insert(rel.to_path_buf());
            }
        } else if let Ok(rel) = p.strip_prefix(canonical_root) {
            paths.insert(rel.to_path_buf());
        } else {
            paths.insert(p);
        }
    }
    paths
}

#[cfg(target_os = "macos")]
fn get_fd_path(fd: i32) -> Option<PathBuf> {
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
fn get_fd_path(fd: i32) -> Option<PathBuf> {
    std::fs::read_link(format!("/proc/self/fd/{fd}")).ok()
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn get_fd_path(_fd: i32) -> Option<PathBuf> {
    None
}
