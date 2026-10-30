use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
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
    pub repo_name: String,
    pub repo_id: String,
    pub status: RwLock<IndexingStatus>,
    pub published: RwLock<Option<Arc<PublishedNetworkState>>>,
    pub revision_counter: AtomicU64,
    pub analysis_generation: AtomicU64,
    pub watcher_health: RwLock<WatcherHealth>,
    pub git_engine: Arc<GitEngine>,
    pub event_sender: broadcast::Sender<ServerEvent>,
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

        Self {
            session_token,
            bootstrap_token: RwLock::new(bootstrap_token),
            allocated_port,
            root_path,
            repo_name,
            repo_id,
            status: RwLock::new(IndexingStatus::NotStarted),
            published: RwLock::new(None),
            revision_counter: AtomicU64::new(0),
            analysis_generation: AtomicU64::new(0),
            watcher_health: RwLock::new(initial_health),
            git_engine,
            event_sender,
        }
    }

    /// Validates and consumes the single-use bootstrap token, returning the session token.
    pub fn exchange_bootstrap_token(&self, candidate: &str) -> Option<String> {
        let mut guard = self.bootstrap_token.write().unwrap();
        if let Some(ref current) = *guard {
            if current == candidate {
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
        let mut pub_guard = self.published.write().unwrap();

        // Stale analysis check under write lock to prevent concurrency races
        if let Some(expected_gen) = target_generation {
            let current = self.current_generation();
            if expected_gen != current {
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
