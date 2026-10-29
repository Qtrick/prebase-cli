use std::path::PathBuf;
use std::sync::RwLock;

use prebase_core::index::GraphIndex;
use prebase_core::model::{GraphSnapshot, IndexingStatus, RepositoryInfo};

pub struct AppState {
    pub session_token: String,
    pub root_path: PathBuf,
    pub repo_info: RwLock<RepositoryInfo>,
    pub snapshot: RwLock<Option<GraphSnapshot>>,
    pub index: RwLock<Option<GraphIndex>>,
    pub status: RwLock<IndexingStatus>,
}

impl AppState {
    pub fn new(
        root_path: PathBuf,
        repo_name: String,
        repo_id: String,
        session_token: String,
    ) -> Self {
        let repo_info = RepositoryInfo {
            repository_id: repo_id,
            repository_root_display: repo_name.clone(),
            repository_name: repo_name,
            analysis_revision: 0,
            indexing_status: IndexingStatus::NotStarted,
        };

        Self {
            session_token,
            root_path,
            repo_info: RwLock::new(repo_info),
            snapshot: RwLock::new(None),
            index: RwLock::new(None),
            status: RwLock::new(IndexingStatus::NotStarted),
        }
    }

    pub fn set_ready(&self, snapshot: GraphSnapshot, index: GraphIndex) {
        let mut st = self.status.write().unwrap();
        *st = IndexingStatus::Ready;

        let mut info = self.repo_info.write().unwrap();
        info.indexing_status = IndexingStatus::Ready;
        info.analysis_revision = snapshot.revision;

        let mut snap = self.snapshot.write().unwrap();
        *snap = Some(snapshot);

        let mut idx = self.index.write().unwrap();
        *idx = Some(index);
    }

    pub fn set_failed(&self, _err_message: &str) {
        let mut st = self.status.write().unwrap();
        *st = IndexingStatus::Failed;

        let mut info = self.repo_info.write().unwrap();
        info.indexing_status = IndexingStatus::Failed;
    }

    pub fn get_status(&self) -> IndexingStatus {
        self.status.read().unwrap().clone()
    }
}
