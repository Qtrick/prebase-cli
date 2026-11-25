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
    ArchitecturalInsights, DependencyEdge, DependencyPathResult, FileImpactAnalysis, FileNode,
    GraphSnapshot, IndexingStatus, PathDirection, RepositoryInfo, WatcherHealth,
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
    pub cursor: Option<String>,
}

#[derive(Deserialize)]
pub struct ImpactQuery {
    pub depth: Option<usize>,
}

#[derive(Deserialize)]
pub struct DependencyPathQuery {
    pub source: Option<String>,
    pub from: Option<String>,
    pub target: Option<String>,
    pub to: Option<String>,
    pub direction: Option<String>,
    pub depth: Option<usize>,
    pub include_types: Option<bool>,
}

#[derive(Deserialize)]
pub struct AuthSessionRequest {
    #[serde(default)]
    pub bootstrap_token: Option<String>,
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

    // 2. Validate and consume single-use bootstrap token if provided
    let raw_token = payload.bootstrap_token.as_deref().unwrap_or("").trim();
    if raw_token.is_empty() {
        return Err((
            StatusCode::UNAUTHORIZED,
            "Authentication required: missing or expired session",
        ));
    }

    match state.exchange_bootstrap_token(raw_token) {
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

pub async fn handle_insights(
    State(state): State<Arc<AppState>>,
) -> Result<Json<ArchitecturalInsights>, (StatusCode, &'static str)> {
    match state.get_published() {
        Some(published) => Ok(Json(published.index.get_insights().clone())),
        None => Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "Repository index not ready yet",
        )),
    }
}

pub async fn handle_file_impact(
    State(state): State<Arc<AppState>>,
    Path(file_id): Path<String>,
    Query(query): Query<ImpactQuery>,
) -> Result<Json<FileImpactAnalysis>, (StatusCode, &'static str)> {
    let published = match state.get_published() {
        Some(p) => p,
        None => {
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "Repository index not ready yet",
            ));
        }
    };

    let depth = query.depth.unwrap_or(5);
    match published.index.analyze_impact(&file_id, depth) {
        Some(impact) => Ok(Json(impact)),
        None => Err((StatusCode::NOT_FOUND, "File node not found")),
    }
}

pub async fn handle_dependency_path(
    State(state): State<Arc<AppState>>,
    Query(query): Query<DependencyPathQuery>,
) -> Result<Json<DependencyPathResult>, (StatusCode, &'static str)> {
    let source = query.source.or(query.from).filter(|s| !s.trim().is_empty());
    let target = query.target.or(query.to).filter(|s| !s.trim().is_empty());

    let (source, target) = match (source, target) {
        (Some(s), Some(t)) => (s, t),
        _ => {
            return Err((
                StatusCode::BAD_REQUEST,
                "Missing source or target parameter",
            ))
        }
    };

    if source.len() > 1024 || target.len() > 1024 {
        return Err((
            StatusCode::BAD_REQUEST,
            "Endpoint parameter exceeds maximum length",
        ));
    }

    let published = match state.get_published() {
        Some(p) => p,
        None => {
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "Repository index not ready yet",
            ));
        }
    };

    let direction = match query.direction.as_deref() {
        Some("incoming" | "used_by") => PathDirection::Incoming,
        _ => PathDirection::Outgoing,
    };

    let include_types = query.include_types.unwrap_or(true);
    let result = published
        .index
        .find_path(&source, &target, direction, include_types);
    Ok(Json(result))
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

pub use prebase_core::is_safe_relative_path;

#[derive(Serialize)]
pub struct SourceContentResponse {
    pub path: String,
    pub content: String,
}

pub async fn handle_get_source(
    State(state): State<Arc<AppState>>,
    Path(file_path): Path<String>,
) -> Result<Json<SourceContentResponse>, (StatusCode, &'static str)> {
    let clean_path = file_path.as_str();
    if !is_safe_relative_path(clean_path) {
        return Err((StatusCode::BAD_REQUEST, "Invalid path"));
    }

    if RepositoryScanner::is_excluded_relative_path(clean_path) {
        warn!("Attempted to read excluded/secret file: {clean_path}");
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
        .any(|n| n.id == clean_path || n.relative_path == clean_path);
    if !is_indexed {
        warn!("Attempted to read non-indexed file: {clean_path}");
        return Err((
            StatusCode::FORBIDDEN,
            "Requested file is not part of indexed repository",
        ));
    }

    let root = state.root_path.clone();
    let path = clean_path.to_string();
    let read_result = tokio::task::spawn_blocking(move || {
        prebase_core::safe_read_file_to_string(&root, &path, 500 * 1024)
    })
    .await
    .map_err(|_| (StatusCode::INTERNAL_SERVER_ERROR, "Worker thread failed"))?;

    match read_result {
        Ok(content) => Ok(Json(SourceContentResponse {
            path: file_path,
            content,
        })),
        Err(prebase_core::SafeReadError::InvalidPath) => {
            Err((StatusCode::BAD_REQUEST, "Invalid path"))
        }
        Err(prebase_core::SafeReadError::Forbidden(_)) => Err((
            StatusCode::FORBIDDEN,
            "Access to file is excluded for security",
        )),
        Err(prebase_core::SafeReadError::EscapesRoot(_)) => {
            Err((StatusCode::FORBIDDEN, "Path escapes repository root"))
        }
        Err(prebase_core::SafeReadError::ContainmentFailed(_)) => {
            Err((StatusCode::FORBIDDEN, "Containment verification failed"))
        }
        Err(prebase_core::SafeReadError::NotARegularFile(_)) => {
            Err((StatusCode::BAD_REQUEST, "Target is not a regular file"))
        }
        Err(prebase_core::SafeReadError::ExceedsLimit { .. }) => Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            "Source file exceeds 500KB limit",
        )),
        Err(prebase_core::SafeReadError::InvalidUtf8) => Err((
            StatusCode::BAD_REQUEST,
            "File is binary or contains invalid UTF-8",
        )),
        Err(prebase_core::SafeReadError::NotFound(_)) => {
            Err((StatusCode::NOT_FOUND, "File not found"))
        }
        Err(prebase_core::SafeReadError::Io(_)) => Err((
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
    if !is_safe_relative_path(clean_path)
        || RepositoryScanner::is_excluded_relative_path(clean_path)
    {
        return Err((
            StatusCode::FORBIDDEN,
            "Access to file history is excluded for security".into(),
        ));
    }

    let limit = query.limit.unwrap_or(50).min(100);
    let git = state.git_engine.clone();
    let path = clean_path.to_string();
    let cursor = query.cursor;

    tokio::task::spawn_blocking(move || git.get_file_history(&path, limit, cursor.as_deref()))
        .await
        .map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Worker thread failed".to_string(),
            )
        })?
        .map(Json)
        .map_err(|e| match e {
            prebase_git::GitError::StaleCursor(msg) => (StatusCode::GONE, msg),
            prebase_git::GitError::InvalidRevision(msg) => (StatusCode::BAD_REQUEST, msg),
            prebase_git::GitError::FileNotFound(msg) => (StatusCode::NOT_FOUND, msg),
            _ => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to retrieve file history".to_string(),
            ),
        })
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
// Session Bootstrap & Workspace Control Routes
// -------------------------------------------------------------

#[derive(Serialize)]
pub struct MintBootstrapResponse {
    pub bootstrap_token: String,
}

fn require_cli_session_header(
    headers: &HeaderMap,
    state: &AppState,
) -> Result<(), (StatusCode, &'static str)> {
    let header_token = headers
        .get("x-prebase-session")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    if !crate::auth::constant_time_eq(header_token, &state.session_token) {
        return Err((
            StatusCode::FORBIDDEN,
            "Forbidden: Explicit X-Prebase-Session header required",
        ));
    }
    Ok(())
}

pub async fn handle_mint_bootstrap(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<MintBootstrapResponse>, (StatusCode, &'static str)> {
    require_cli_session_header(&headers, &state)?;

    let bootstrap_token = state.mint_bootstrap_token();
    Ok(Json(MintBootstrapResponse { bootstrap_token }))
}

#[derive(Deserialize)]
pub struct WorkspaceNavigateRequest {
    pub view: String,
    #[serde(default)]
    pub focus: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Serialize)]
pub struct WorkspaceNavigateResponse {
    pub delivered: bool,
    pub acknowledged: bool,
    pub active_clients: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

pub async fn handle_workspace_navigate(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<WorkspaceNavigateRequest>,
) -> Result<Json<WorkspaceNavigateResponse>, (StatusCode, &'static str)> {
    require_cli_session_header(&headers, &state)?;
    let view = payload.view.trim();
    if !matches!(view, "3d" | "2d" | "temporal") {
        return Err((
            StatusCode::BAD_REQUEST,
            "Invalid view: expected '3d', '2d', or 'temporal'",
        ));
    }

    let focus = match payload.focus {
        Some(f) => {
            let trimmed = f.trim();
            if trimmed.is_empty() {
                None
            } else if trimmed.len() > 4096 {
                return Err((StatusCode::BAD_REQUEST, "Focus path exceeds maximum length"));
            } else {
                Some(trimmed.to_string())
            }
        }
        None => None,
    };

    let active_clients = state.active_sse_client_count();
    let Some(target_client_id) = state.most_recent_sse_client() else {
        return Ok(Json(WorkspaceNavigateResponse {
            delivered: false,
            acknowledged: false,
            active_clients: 0,
            client_id: None,
            request_id: None,
        }));
    };
    if active_clients == 0 {
        return Ok(Json(WorkspaceNavigateResponse {
            delivered: false,
            acknowledged: false,
            active_clients: 0,
            client_id: None,
            request_id: None,
        }));
    }

    let request_id = format!("nav_{}", &crate::auth::generate_bootstrap_token()[..24]);
    let rx = state.register_nav_ack(request_id.clone(), target_client_id.clone());

    let _ = state
        .event_sender
        .send(crate::state::ServerEvent::WorkspaceNavigate {
            request_id: request_id.clone(),
            target_client_id: Some(target_client_id),
            view: view.to_string(),
            focus,
        });

    let wait_ms = payload.timeout_ms.unwrap_or(1500).clamp(100, 5000);
    match tokio::time::timeout(Duration::from_millis(wait_ms), rx).await {
        Ok(Ok(client_id)) => Ok(Json(WorkspaceNavigateResponse {
            delivered: true,
            acknowledged: true,
            active_clients: state.active_sse_client_count(),
            client_id: Some(client_id),
            request_id: Some(request_id),
        })),
        _ => {
            state.remove_nav_ack(&request_id);
            Ok(Json(WorkspaceNavigateResponse {
                delivered: true,
                acknowledged: false,
                active_clients: state.active_sse_client_count(),
                client_id: None,
                request_id: Some(request_id),
            }))
        }
    }
}

#[derive(Deserialize)]
pub struct WorkspaceAckRequest {
    pub request_id: String,
    pub client_id: String,
}

#[derive(Serialize)]
pub struct WorkspaceAckResponse {
    pub accepted: bool,
}

pub async fn handle_workspace_ack(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<WorkspaceAckRequest>,
) -> Result<Json<WorkspaceAckResponse>, (StatusCode, &'static str)> {
    let request_id = crate::state::validate_bounded_id(&payload.request_id)
        .ok_or((StatusCode::BAD_REQUEST, "Invalid request_id"))?;
    let client_id = crate::state::validate_bounded_id(&payload.client_id)
        .ok_or((StatusCode::BAD_REQUEST, "Invalid client_id"))?;

    let accepted = state.ack_nav(&request_id, &client_id);
    Ok(Json(WorkspaceAckResponse { accepted }))
}

// -------------------------------------------------------------
// Live Events Route (SSE)
// -------------------------------------------------------------

#[derive(Deserialize, Default)]
pub struct EventsQuery {
    pub client_id: Option<String>,
}

struct GuardedStream<S> {
    inner: std::pin::Pin<Box<S>>,
    _guard: crate::state::SseClientGuard,
}

impl<S: Stream> Stream for GuardedStream<S> {
    type Item = S::Item;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        self.inner.as_mut().poll_next(cx)
    }
}

pub async fn handle_events(
    State(state): State<Arc<AppState>>,
    Query(query): Query<EventsQuery>,
) -> Result<
    Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>>,
    (StatusCode, &'static str),
> {
    let client_id = match query.client_id {
        Some(raw) if !raw.trim().is_empty() => crate::state::validate_bounded_id(&raw)
            .ok_or((StatusCode::BAD_REQUEST, "Invalid client_id"))?,
        _ => format!("anon_{}", state.next_sse_conn_id()),
    };

    let guard = state.register_sse_client(client_id);
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

    let guarded = GuardedStream {
        inner: Box::pin(stream),
        _guard: guard,
    };

    Ok(Sse::new(guarded).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("heartbeat"),
    ))
}
