use axum::{
    body::Body,
    extract::{Query, Request, State},
    http::{header, HeaderMap, StatusCode},
    middleware::Next,
    response::Response,
};
use rand::{distributions::Alphanumeric, Rng};
use serde::Deserialize;
use std::sync::Arc;
use tracing::warn;

use crate::state::AppState;

pub fn generate_session_token() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect()
}

#[derive(Deserialize)]
pub struct AuthQuery {
    pub token: Option<String>,
}

pub async fn security_headers_middleware(req: Request<Body>, next: Next) -> Response {
    let mut resp = next.run(req).await;
    let headers = resp.headers_mut();

    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        "default-src 'self' 'unsafe-inline' data:; connect-src 'self'; frame-ancestors 'none';"
            .parse()
            .unwrap(),
    );
    headers.insert(header::X_FRAME_OPTIONS, "DENY".parse().unwrap());
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    headers.insert(header::REFERRER_POLICY, "no-referrer".parse().unwrap());

    resp
}

pub async fn host_and_auth_middleware(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    req: Request<Body>,
    next: Next,
) -> Result<Response, (StatusCode, &'static str)> {
    // 1. Host header validation (prevent DNS rebinding)
    if let Some(host) = headers.get(header::HOST).and_then(|h| h.to_str().ok()) {
        let hostname = host.split(':').next().unwrap_or(host);
        if hostname != "127.0.0.1" && hostname != "localhost" {
            warn!("Rejected request with invalid Host: {host}");
            return Err((StatusCode::BAD_REQUEST, "Invalid Host header"));
        }
    }

    // 2. Origin validation (prevent unauthorized cross-origin requests)
    if let Some(origin) = headers.get(header::ORIGIN).and_then(|o| o.to_str().ok()) {
        if !origin.starts_with("http://127.0.0.1:") && !origin.starts_with("http://localhost:") {
            warn!("Rejected cross-origin request from: {origin}");
            return Err((StatusCode::FORBIDDEN, "Forbidden Origin"));
        }
    }

    let path = req.uri().path();
    // Allow static frontend assets (css, js, html, favicon) to load without auth header,
    // as the session token is passed in the URL query string on initial launch or cookie
    let is_api_route = path.starts_with("/api/");

    if is_api_route && path != "/api/v1/health" {
        let token_matches = if let Some(header_token) = headers
            .get("x-prebase-session")
            .and_then(|h| h.to_str().ok())
        {
            header_token == state.session_token
        } else if let Some(q_token) = query.token {
            q_token == state.session_token
        } else {
            false
        };

        if !token_matches {
            warn!("Unauthorized API request to {path}");
            return Err((
                StatusCode::UNAUTHORIZED,
                "Unauthorized: Invalid or missing session token",
            ));
        }
    }

    Ok(next.run(req).await)
}
