use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse,
    },
    Json,
};
use futures_util::stream::Stream;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;
use tracing::warn;

use prebase_core::model::{
    DependencyEdge, FileNode, GraphSnapshot, IndexingStatus, RepositoryInfo, WatcherHealth,
};
use prebase_core::scanner::RepositoryScanner;
use prebase_git::{CommitDetails, FileHistoryResult, GitStatus, HistoryPage};

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
    pub watcher_health: WatcherHealth,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub analysis_duration_ms: Option<u64>,
}

#[derive(Deserialize)]
pub struct SearchQuery {
    pub q: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Deserialize)]
pub struct HistoryQuery {
    pub limit: Option<usize>,
    pub cursor: Option<String>,
}

#[derive(Deserialize)]
pub struct FileHistoryQuery {
    pub path: String,
    pub limit: Option<usize>,
}

#[derive(Deserialize)]
pub struct AuthSessionRequest {
    pub bootstrap_token: String,
    #[serde(default)]
    pub expose_token: bool,
}

#[derive(Serialize)]
pub struct AuthSessionResponse {
    pub authenticated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_token: Option<String>,
}

pub async fn handle_auth_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<AuthSessionRequest>,
) -> Result<impl IntoResponse, (StatusCode, &'static str)> {
    // 1. Multi-tab & reload idempotence:
    // If the client already possesses a valid port-specific session cookie for this instance,
    // grant immediate 200 OK even if the single-use bootstrap token was already consumed.
    if let Some(cookie_token) = crate::auth::extract_cookie_token(&headers, state.allocated_port) {
        if crate::auth::constant_time_eq(&cookie_token, &state.session_token) {
            // Re-authentication via existing ambient cookie must NEVER expose the token in JSON.
            // This prevents an ambient HttpOnly cookie from functioning as an unintended token-extraction oracle.
            return Ok((
                HeaderMap::new(),
                Json(AuthSessionResponse {
                    authenticated: true,
                    session_token: None,
                }),
            ));
        }
    }

    // 2. Validate and consume single-use bootstrap token
    match state.exchange_bootstrap_token(&payload.bootstrap_token) {
        Some(token) => {
            let mut headers = HeaderMap::new();
            // Partitioned port-specific session cookie (RFC 6265 prevents cross-instance clobbering)
            let port_cookie = format!(
                "prebase_session_{}={}; HttpOnly; SameSite=Strict; Path=/",
                state.allocated_port, token
            );
            if let Ok(val) = port_cookie.parse() {
                headers.append(header::SET_COOKIE, val);
            }
            // Explicitly clear legacy un-suffixed cookie from browser jar
            let clear_legacy_cookie =
                "prebase_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0";
            if let Ok(val) = clear_legacy_cookie.parse() {
                headers.append(header::SET_COOKIE, val);
            }

            let session_token = if payload.expose_token {
                Some(token)
            } else {
                None
            };

            Ok((
                headers,
                Json(AuthSessionResponse {
                    authenticated: true,
                    session_token,
                }),
            ))
        }
        None => Err((
            StatusCode::UNAUTHORIZED,
            "Invalid or expired bootstrap token",
        )),
    }
}

pub async fn handle_health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        version: "0.1.0",
    })
}

pub async fn handle_status(State(state): State<Arc<AppState>>) -> Json<StatusResponse> {
    let status = state.get_status();
    let revision = state.get_current_revision();
    let watcher_health = state.get_watcher_health();
    let analysis_duration_ms = state.get_analysis_duration();
    Json(StatusResponse {
        indexing_status: status,
        revision,
        watcher_health,
        analysis_duration_ms,
    })
}

pub async fn handle_repository(
    State(state): State<Arc<AppState>>,
) -> Result<Json<RepositoryInfo>, (StatusCode, &'static str)> {
    Ok(Json(state.get_repository_info()))
}

pub async fn handle_network(
    State(state): State<Arc<AppState>>,
) -> Result<Json<GraphSnapshot>, (StatusCode, &'static str)> {
    match state.get_published() {
        Some(published) => Ok(Json((*published.snapshot).clone())),
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
    let published = match state.get_published() {
        Some(p) => p,
        None => {
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "Repository index not ready yet",
            ))
        }
    };

    let q = query.q.as_deref().unwrap_or("");
    let limit = query.limit.unwrap_or(50).min(200);

    let results = published.index.search_files(q, limit);
    Ok(Json(results))
}

pub async fn handle_inspect_file(
    State(state): State<Arc<AppState>>,
    Path(file_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, &'static str)> {
    let published = match state.get_published() {
        Some(p) => p,
        None => {
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "Repository index not ready yet",
            ))
        }
    };

    match published.index.inspect_file(&file_id) {
        Some(inspection) => Ok(Json(inspection)),
        None => Err((StatusCode::NOT_FOUND, "File node not found")),
    }
}

pub async fn handle_inspect_edge(
    State(state): State<Arc<AppState>>,
    Path(edge_id): Path<String>,
) -> Result<Json<DependencyEdge>, (StatusCode, &'static str)> {
    let published = match state.get_published() {
        Some(p) => p,
        None => {
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "Repository index not ready yet",
            ))
        }
    };

    match published.index.get_edge(&edge_id) {
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

    // Verify that the requested file exists in the published canonical snapshot
    let published = match state.get_published() {
        Some(p) => p,
        None => {
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "Repository index not ready yet",
            ))
        }
    };

    let is_indexed = published
        .snapshot
        .nodes
        .iter()
        .any(|n| n.id == file_path || n.relative_path == file_path);
    if !is_indexed {
        warn!("Attempted to read non-indexed file: {file_path}");
        return Err((
            StatusCode::FORBIDDEN,
            "Requested file is not part of indexed repository",
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

    // Verify resolved canonical target is not an excluded sensitive file (prevents internal symlink leaks)
    let canonical_rel = match canonical.strip_prefix(&canonical_root) {
        Ok(p) => p.to_string_lossy().replace('\\', "/"),
        Err(_) => return Err((StatusCode::FORBIDDEN, "Path escapes repository root")),
    };
    if RepositoryScanner::is_excluded_relative_path(&canonical_rel) {
        warn!("Blocked access to excluded sensitive file via symlink: {canonical_rel}");
        return Err((
            StatusCode::FORBIDDEN,
            "Access to file is excluded for security",
        ));
    }

    // Race-resistant handle validation and reading (eliminates TOCTOU metadata-to-read race)
    use std::io::Read;
    let file = match std::fs::File::open(&canonical) {
        Ok(f) => f,
        Err(_) => return Err((StatusCode::NOT_FOUND, "Failed to open source file")),
    };

    let metadata = match file.metadata() {
        Ok(m) => m,
        Err(_) => return Err((StatusCode::NOT_FOUND, "Failed to read file metadata")),
    };
    if !metadata.is_file() {
        return Err((StatusCode::BAD_REQUEST, "Target is not a regular file"));
    }
    if metadata.len() > 500 * 1024 {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            "Source file exceeds 500KB limit",
        ));
    }

    let mut content = String::with_capacity(metadata.len() as usize);
    match file.take(500 * 1024 + 1).read_to_string(&mut content) {
        Ok(bytes_read) if bytes_read > 500 * 1024 => Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            "Source file exceeds 500KB limit",
        )),
        Ok(_) => Ok(Json(SourceContentResponse {
            path: file_path,
            content,
        })),
        Err(_) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to read source file",
        )),
    }
}

// -------------------------------------------------------------
// Temporal & Git Routes
// -------------------------------------------------------------

pub async fn handle_history(
    State(state): State<Arc<AppState>>,
    Query(query): Query<HistoryQuery>,
) -> Result<Json<HistoryPage>, (StatusCode, String)> {
    let limit = query.limit.unwrap_or(50).min(200);
    let git = state.git_engine.clone();
    let cursor = query.cursor;

    tokio::task::spawn_blocking(move || git.get_history(limit, cursor.as_deref()))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map(Json)
        .map_err(|e| match e {
            prebase_git::GitError::StaleCursor(_) => (StatusCode::GONE, e.to_string()),
            prebase_git::GitError::InvalidRevision(_) => (StatusCode::BAD_REQUEST, e.to_string()),
            _ => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        })
}

pub async fn handle_commit_details(
    State(state): State<Arc<AppState>>,
    Path(hash): Path<String>,
) -> Result<Json<CommitDetails>, (StatusCode, String)> {
    let git = state.git_engine.clone();
    tokio::task::spawn_blocking(move || git.get_commit_details(&hash))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map(Json)
        .map_err(|e| match e {
            prebase_git::GitError::CommitNotFound(_) => (StatusCode::NOT_FOUND, e.to_string()),
            _ => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        })
}

pub async fn handle_file_history(
    State(state): State<Arc<AppState>>,
    Query(query): Query<FileHistoryQuery>,
) -> Result<Json<FileHistoryResult>, (StatusCode, String)> {
    let clean_path = query.path.trim_start_matches('/').trim_start_matches('\\');
    if clean_path.contains("..") || RepositoryScanner::is_excluded_relative_path(clean_path) {
        return Err((
            StatusCode::FORBIDDEN,
            "Access to file history is excluded for security".into(),
        ));
    }

    let limit = query.limit.unwrap_or(50).min(100);
    let git = state.git_engine.clone();
    let path = clean_path.to_string();

    tokio::task::spawn_blocking(move || git.get_file_history(&path, limit))
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

pub async fn handle_git_status(
    State(state): State<Arc<AppState>>,
) -> Result<Json<GitStatus>, (StatusCode, String)> {
    let git = state.git_engine.clone();
    tokio::task::spawn_blocking(move || git.get_status())
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map(Json)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

// -------------------------------------------------------------
// Live Events Route (SSE)
// -------------------------------------------------------------

pub async fn handle_events(
    State(state): State<Arc<AppState>>,
) -> Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>> {
    let rx = state.event_sender.subscribe();
    let state_clone = state.clone();
    let stream = BroadcastStream::new(rx).filter_map(move |res| match res {
        Ok(evt) => {
            let data = serde_json::to_string(&evt).unwrap_or_default();
            Some(Ok(Event::default().data(data)))
        }
        Err(tokio_stream::wrappers::errors::BroadcastStreamRecvError::Lagged(_)) => {
            let current_revision = state_clone.get_current_revision();
            let evt = crate::state::ServerEvent::ReconcileRequired { current_revision };
            let data = serde_json::to_string(&evt).unwrap_or_default();
            Some(Ok(Event::default().data(data)))
        }
    });

    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("heartbeat"),
    )
}
