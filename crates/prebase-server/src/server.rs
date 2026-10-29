use axum::{middleware, routing::get, Router};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tracing::info;

use crate::auth::{generate_session_token, host_and_auth_middleware, security_headers_middleware};
use crate::routes::*;
use crate::state::AppState;
use crate::static_assets::serve_static_asset;
use crate::watcher::{start_repo_watcher, RepoWatcherHandle};

pub struct RunningServer {
    pub port: u16,
    pub session_token: String,
    pub state: Arc<AppState>,
    pub shutdown_tx: oneshot::Sender<()>,
    pub server_handle: tokio::task::JoinHandle<()>,
    pub watcher_handle: Option<RepoWatcherHandle>,
}

pub fn create_router(state: Arc<AppState>) -> Router {
    let api_router = Router::new()
        .route("/health", get(handle_health))
        .route("/status", get(handle_status))
        .route("/repository", get(handle_repository))
        .route("/network", get(handle_network))
        .route("/files", get(handle_search_files))
        .route("/files/*file_id", get(handle_inspect_file))
        .route("/edges/*edge_id", get(handle_inspect_edge))
        .route("/source/*file_path", get(handle_get_source))
        .route("/history", get(handle_history))
        .route("/commits/*hash", get(handle_commit_details))
        .route("/file-history", get(handle_file_history))
        .route("/git/status", get(handle_git_status))
        .route("/events", get(handle_events));

    Router::new()
        .nest("/api/v1", api_router)
        .fallback(|req: axum::extract::Request| async move {
            serve_static_asset(req.uri().path()).await
        })
        .layer(middleware::from_fn_with_state(
            state.clone(),
            host_and_auth_middleware,
        ))
        .layer(middleware::from_fn(security_headers_middleware))
        .with_state(state)
}

pub async fn start_server(
    root_path: PathBuf,
    repo_name: String,
    repo_id: String,
    port: Option<u16>,
    watch_filesystem: bool,
) -> Result<RunningServer, Box<dyn std::error::Error + Send + Sync>> {
    let session_token = generate_session_token();
    let state = Arc::new(AppState::new(
        root_path.clone(),
        repo_name,
        repo_id,
        session_token.clone(),
    ));

    let bind_addr = SocketAddr::from(([127, 0, 0, 1], port.unwrap_or(0)));
    let listener = TcpListener::bind(bind_addr).await?;
    let local_addr = listener.local_addr()?;
    let allocated_port = local_addr.port();

    info!("PreBase server listening on http://127.0.0.1:{allocated_port}");

    let app = create_router(state.clone());
    let (shutdown_tx, shutdown_rx) = oneshot::channel();

    let server_handle = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = shutdown_rx.await;
                info!("Server received shutdown signal");
            })
            .await
            .unwrap_or_else(|e| tracing::error!("Server error: {e}"));
    });

    let watcher_handle = if watch_filesystem {
        match start_repo_watcher(state.clone()) {
            Ok(handle) => {
                info!("Filesystem watcher active for {}", root_path.display());
                Some(handle)
            }
            Err(e) => {
                tracing::warn!("Failed to initialize filesystem watcher: {e}");
                None
            }
        }
    } else {
        None
    };

    Ok(RunningServer {
        port: allocated_port,
        session_token,
        state,
        shutdown_tx,
        server_handle,
        watcher_handle,
    })
}
