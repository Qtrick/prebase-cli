use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tracing::warn;

use prebase_core::model::{
    DependencyEdge, FileNode, GraphSnapshot, IndexingStatus, RepositoryInfo,
};
use prebase_core::scanner::RepositoryScanner;

use crate::state::AppState;

#[derive(Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub version: &'static str,
}

#[derive(Serialize)]
pub struct StatusResponse {
    pub indexing_status: IndexingStatus,
    pub revision: u64,
}

#[derive(Deserialize)]
pub struct SearchQuery {
    pub q: Option<String>,
    pub limit: Option<usize>,
}

pub async fn handle_health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        version: "0.1.0",
    })
}

pub async fn handle_status(State(state): State<Arc<AppState>>) -> Json<StatusResponse> {
    let status = state.get_status();
    let revision = state.repo_info.read().unwrap().analysis_revision;
    Json(StatusResponse {
        indexing_status: status,
        revision,
    })
}

pub async fn handle_repository(
    State(state): State<Arc<AppState>>,
) -> Result<Json<RepositoryInfo>, (StatusCode, &'static str)> {
    let info = state.repo_info.read().unwrap().clone();
    Ok(Json(info))
}

pub async fn handle_network(
    State(state): State<Arc<AppState>>,
) -> Result<Json<GraphSnapshot>, (StatusCode, &'static str)> {
    let snap_guard = state.snapshot.read().unwrap();
    match snap_guard.as_ref() {
        Some(snapshot) => Ok(Json(snapshot.clone())),
        None => Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "Repository indexing not ready yet",
        )),
    }
}

pub async fn handle_search_files(
    State(state): State<Arc<AppState>>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<Vec<FileNode>>, (StatusCode, &'static str)> {
    let index_guard = state.index.read().unwrap();
    let index = match index_guard.as_ref() {
        Some(idx) => idx,
        None => {
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "Repository index not ready yet",
            ))
        }
    };

    let q = query.q.as_deref().unwrap_or("");
    let limit = query.limit.unwrap_or(50).min(200);

    let results = index.search_files(q, limit);
    Ok(Json(results))
}

pub async fn handle_inspect_file(
    State(state): State<Arc<AppState>>,
    Path(file_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, &'static str)> {
    let index_guard = state.index.read().unwrap();
    let index = match index_guard.as_ref() {
        Some(idx) => idx,
        None => {
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "Repository index not ready yet",
            ))
        }
    };

    match index.inspect_file(&file_id) {
        Some(inspection) => Ok(Json(inspection)),
        None => Err((StatusCode::NOT_FOUND, "File node not found")),
    }
}

pub async fn handle_inspect_edge(
    State(state): State<Arc<AppState>>,
    Path(edge_id): Path<String>,
) -> Result<Json<DependencyEdge>, (StatusCode, &'static str)> {
    let index_guard = state.index.read().unwrap();
    let index = match index_guard.as_ref() {
        Some(idx) => idx,
        None => {
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "Repository index not ready yet",
            ))
        }
    };

    match index.get_edge(&edge_id) {
        Some(edge) => Ok(Json(edge.clone())),
        None => Err((StatusCode::NOT_FOUND, "Edge not found")),
    }
}

#[derive(Serialize)]
pub struct SourceContentResponse {
    pub path: String,
    pub content: String,
}

pub async fn handle_get_source(
    State(state): State<Arc<AppState>>,
    Path(file_path): Path<String>,
) -> Result<Json<SourceContentResponse>, (StatusCode, &'static str)> {
    // Filesystem security check: prevent path traversal!
    if file_path.contains("..") || file_path.starts_with('/') || file_path.starts_with('\\') {
        return Err((StatusCode::BAD_REQUEST, "Invalid path"));
    }

    if RepositoryScanner::is_excluded_relative_path(&file_path) {
        warn!("Attempted to read excluded/secret file: {file_path}");
        return Err((
            StatusCode::FORBIDDEN,
            "Access to file is excluded for security",
        ));
    }

    let target = state.root_path.join(&file_path);
    let canonical = match target.canonicalize() {
        Ok(p) => p,
        Err(_) => return Err((StatusCode::NOT_FOUND, "File not found")),
    };

    // Verify canonical path starts with canonical root path
    let canonical_root = match state.root_path.canonicalize() {
        Ok(r) => r,
        Err(_) => return Err((StatusCode::INTERNAL_SERVER_ERROR, "Invalid root path")),
    };

    if !canonical.starts_with(&canonical_root) {
        warn!("Path traversal attempt blocked: {file_path}");
        return Err((StatusCode::FORBIDDEN, "Path escapes repository root"));
    }

    match std::fs::read_to_string(&canonical) {
        Ok(content) => Ok(Json(SourceContentResponse {
            path: file_path,
            content,
        })),
        Err(_) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to read source file",
        )),
    }
}
