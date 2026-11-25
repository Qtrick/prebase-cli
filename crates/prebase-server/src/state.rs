use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use prebase_core::index::GraphIndex;
use prebase_core::model::{GraphSnapshot, IndexingStatus, RepositoryInfo, WatcherHealth};
use prebase_git::GitEngine;
use serde::Serialize;
use tokio::sync::{broadcast, oneshot, Notify};
use tracing::info;

pub const GIT_REFRESH_IDLE: u8 = 0;
pub const GIT_REFRESH_RUNNING: u8 = 1;
pub const GIT_REFRESH_RUNNING_PENDING: u8 = 2;
pub const MAX_TRACKED_SSE_CLIENTS: usize = 128;
pub const MAX_PENDING_NAV_ACKS: usize = 64;
pub const MAX_BOOTSTRAP_TOKENS: usize = 16;
pub const BOOTSTRAP_TOKEN_TTL: Duration = Duration::from_secs(60);

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
    #[serde(rename = "workspace.navigate")]
    WorkspaceNavigate {
        request_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        target_client_id: Option<String>,
        view: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        focus: Option<String>,
    },
    #[serde(rename = "heartbeat")]
    Heartbeat { timestamp: u64 },
}

/// Validate a bounded client/request identifier (1..=64 ASCII alphanumeric, `-`, `_`).
pub fn validate_bounded_id(id: &str) -> Option<String> {
    let trimmed = id.trim();
    if trimmed.is_empty() || trimmed.len() > 64 {
        return None;
    }
    if trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        Some(trimmed.to_string())
    } else {
        None
    }
}

pub struct SseClientGuard {
    state: Arc<AppState>,
    client_id: Option<String>,
    conn_id: u64,
}

impl Drop for SseClientGuard {
    fn drop(&mut self) {
        if let Some(ref client_id) = self.client_id {
            self.state.unregister_sse_client(client_id, self.conn_id);
        }
    }
}

pub struct PendingNavAck {
    pub target_client_id: String,
    pub tx: oneshot::Sender<String>,
}

pub struct AppState {
    pub session_token: String,
    pub bootstrap_tokens: Mutex<HashMap<String, Instant>>,
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
    pub is_shutting_down: Arc<AtomicBool>,
    pub shutdown_notify: Arc<Notify>,
    pub is_analyzing: AtomicBool,
    pub process_output_paths: RwLock<HashSet<PathBuf>>,
    pub git_refresh_state: Arc<AtomicU8>,
    pub sse_clients: Mutex<HashMap<String, u64>>,
    pub sse_conn_counter: AtomicU64,
    pub pending_nav_acks: Mutex<HashMap<String, PendingNavAck>>,
    pub launch_pending_until: Mutex<Option<Instant>>,
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

        let mut initial_tokens = HashMap::new();
        if let Some(tok) = bootstrap_token {
            initial_tokens.insert(tok, Instant::now());
        }

        Self {
            session_token,
            bootstrap_tokens: Mutex::new(initial_tokens),
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
            is_shutting_down: Arc::new(AtomicBool::new(false)),
            shutdown_notify: Arc::new(Notify::new()),
            is_analyzing: AtomicBool::new(false),
            process_output_paths: RwLock::new(detect_process_output_paths(&canonical_root)),
            git_refresh_state: Arc::new(AtomicU8::new(GIT_REFRESH_IDLE)),
            sse_clients: Mutex::new(HashMap::new()),
            sse_conn_counter: AtomicU64::new(0),
            pending_nav_acks: Mutex::new(HashMap::new()),
            launch_pending_until: Mutex::new(None),
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

    /// Validates and consumes a short-TTL single-use bootstrap token, returning the session token.
    pub fn exchange_bootstrap_token(&self, candidate: &str) -> Option<String> {
        let now = Instant::now();
        let mut guard = self.bootstrap_tokens.lock().unwrap();
        guard.retain(|_, created| now.duration_since(*created) <= BOOTSTRAP_TOKEN_TTL);
        let matched = guard
            .keys()
            .find(|tok| crate::auth::constant_time_eq(tok, candidate))
            .cloned();
        if let Some(key) = matched {
            guard.remove(&key);
            return Some(self.session_token.clone());
        }
        None
    }

    /// Mint and store a fresh short-TTL single-use bootstrap token (bounded to MAX_BOOTSTRAP_TOKENS).
    pub fn mint_bootstrap_token(&self) -> String {
        let now = Instant::now();
        let token = crate::auth::generate_bootstrap_token();
        let mut guard = self.bootstrap_tokens.lock().unwrap();
        guard.retain(|_, created| now.duration_since(*created) <= BOOTSTRAP_TOKEN_TTL);
        if guard.len() >= MAX_BOOTSTRAP_TOKENS {
            if let Some(oldest_key) = guard
                .iter()
                .min_by_key(|(_, created)| *created)
                .map(|(k, _)| k.clone())
            {
                guard.remove(&oldest_key);
            }
        }
        guard.insert(token.clone(), now);
        token
    }

    pub fn next_sse_conn_id(&self) -> u64 {
        self.sse_conn_counter.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn register_sse_client(self: &Arc<Self>, client_id: Option<String>) -> SseClientGuard {
        let conn_id = self.next_sse_conn_id();
        if let Some(ref cid) = client_id {
            {
                let mut guard = self.sse_clients.lock().unwrap();
                if !guard.contains_key(cid) && guard.len() >= MAX_TRACKED_SSE_CLIENTS {
                    if let Some(oldest_key) = guard
                        .iter()
                        .min_by_key(|(_, id)| *id)
                        .map(|(k, _)| k.clone())
                    {
                        guard.remove(&oldest_key);
                    }
                }
                guard.insert(cid.clone(), conn_id);
            }
            self.clear_launch_pending();
        }
        SseClientGuard {
            state: Arc::clone(self),
            client_id,
            conn_id,
        }
    }

    pub fn unregister_sse_client(&self, client_id: &str, conn_id: u64) {
        let mut guard = self.sse_clients.lock().unwrap();
        if guard.get(client_id) == Some(&conn_id) {
            guard.remove(client_id);
        }
    }

    pub fn remove_sse_client(&self, client_id: &str) {
        self.sse_clients.lock().unwrap().remove(client_id);
    }

    pub fn active_sse_client_count(&self) -> usize {
        self.sse_clients.lock().unwrap().len()
    }

    /// Returns the most recently connected authenticated workspace client ID (never anonymous).
    pub fn most_recent_sse_client(&self) -> Option<String> {
        let guard = self.sse_clients.lock().unwrap();
        guard
            .iter()
            .max_by_key(|(_, cid)| *cid)
            .map(|(id, _)| id.clone())
    }

    pub fn mark_launch_pending(&self, window: Duration) {
        let mut guard = self.launch_pending_until.lock().unwrap();
        *guard = Some(Instant::now() + window);
    }

    pub fn clear_launch_pending(&self) {
        let mut guard = self.launch_pending_until.lock().unwrap();
        *guard = None;
    }

    pub fn is_launch_pending(&self) -> bool {
        let mut guard = self.launch_pending_until.lock().unwrap();
        match *guard {
            Some(until) if Instant::now() < until => true,
            Some(_) => {
                *guard = None;
                false
            }
            None => false,
        }
    }

    pub fn register_nav_ack(
        &self,
        request_id: String,
        target_client_id: String,
    ) -> oneshot::Receiver<String> {
        let (tx, rx) = oneshot::channel();
        let mut guard = self.pending_nav_acks.lock().unwrap();
        if guard.len() >= MAX_PENDING_NAV_ACKS {
            guard.retain(|_, entry| !entry.tx.is_closed());
            if guard.len() >= MAX_PENDING_NAV_ACKS {
                if let Some(first_key) = guard.keys().next().cloned() {
                    guard.remove(&first_key);
                }
            }
        }
        guard.insert(
            request_id,
            PendingNavAck {
                target_client_id,
                tx,
            },
        );
        rx
    }

    pub fn ack_nav(&self, request_id: &str, client_id: &str) -> bool {
        let tx = {
            let mut guard = self.pending_nav_acks.lock().unwrap();
            match guard.get(request_id) {
                Some(entry) if entry.target_client_id == client_id => {
                    guard.remove(request_id).map(|e| e.tx)
                }
                _ => None,
            }
        };
        match tx {
            Some(sender) => sender.send(client_id.to_string()).is_ok(),
            None => false,
        }
    }

    pub fn remove_nav_ack(&self, request_id: &str) {
        let mut guard = self.pending_nav_acks.lock().unwrap();
        guard.remove(request_id);
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
        if self.is_shutting_down() {
            return;
        }

        // Bound overlapping Git operations: coalesce burst events into a single pending pass.
        // 3-state atomic machine: IDLE = 0, RUNNING = 1, RUNNING_PENDING = 2.
        let mut current = self.git_refresh_state.load(Ordering::SeqCst);
        loop {
            if self.is_shutting_down() {
                return;
            }
            match current {
                GIT_REFRESH_IDLE => {
                    match self.git_refresh_state.compare_exchange_weak(
                        GIT_REFRESH_IDLE,
                        GIT_REFRESH_RUNNING,
                        Ordering::SeqCst,
                        Ordering::SeqCst,
                    ) {
                        Ok(_) => break, // Successfully transitioned from IDLE to RUNNING; spawn worker
                        Err(actual) => current = actual,
                    }
                }
                GIT_REFRESH_RUNNING => {
                    match self.git_refresh_state.compare_exchange_weak(
                        GIT_REFRESH_RUNNING,
                        GIT_REFRESH_RUNNING_PENDING,
                        Ordering::SeqCst,
                        Ordering::SeqCst,
                    ) {
                        Ok(_) => return, // Successfully transitioned to RUNNING_PENDING; active worker will rerun
                        Err(actual) => current = actual,
                    }
                }
                GIT_REFRESH_RUNNING_PENDING => {
                    // Already marked pending, coalesce
                    return;
                }
                _ => return,
            }
        }

        let git_engine = Arc::clone(&self.git_engine);
        let sender = self.event_sender.clone();
        let refresh_state = Arc::clone(&self.git_refresh_state);
        let is_shutting_down = Arc::clone(&self.is_shutting_down);

        tokio::task::spawn_blocking(move || {
            loop {
                if is_shutting_down.load(Ordering::SeqCst) {
                    refresh_state.store(GIT_REFRESH_IDLE, Ordering::SeqCst);
                    break;
                }

                let status = git_engine.get_status().ok();
                let (head_commit, branch) = match status {
                    Some(st) => (st.head_commit, st.branch),
                    None => (None, None),
                };

                if is_shutting_down.load(Ordering::SeqCst) {
                    refresh_state.store(GIT_REFRESH_IDLE, Ordering::SeqCst);
                    break;
                }

                let _ = sender.send(ServerEvent::GitUpdated {
                    head_commit,
                    branch,
                });

                // Atomic state transition: check if another refresh was requested while running.
                let should_continue = loop {
                    if is_shutting_down.load(Ordering::SeqCst) {
                        refresh_state.store(GIT_REFRESH_IDLE, Ordering::SeqCst);
                        return;
                    }
                    let curr = refresh_state.load(Ordering::SeqCst);
                    match curr {
                        GIT_REFRESH_RUNNING => {
                            if refresh_state
                                .compare_exchange_weak(
                                    GIT_REFRESH_RUNNING,
                                    GIT_REFRESH_IDLE,
                                    Ordering::SeqCst,
                                    Ordering::SeqCst,
                                )
                                .is_ok()
                            {
                                break false;
                            }
                        }
                        GIT_REFRESH_RUNNING_PENDING => {
                            if refresh_state
                                .compare_exchange_weak(
                                    GIT_REFRESH_RUNNING_PENDING,
                                    GIT_REFRESH_RUNNING,
                                    Ordering::SeqCst,
                                    Ordering::SeqCst,
                                )
                                .is_ok()
                            {
                                break true;
                            }
                        }
                        _ => {
                            refresh_state.store(GIT_REFRESH_IDLE, Ordering::SeqCst);
                            break false;
                        }
                    }
                };

                if !should_continue {
                    break;
                }
            }
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
