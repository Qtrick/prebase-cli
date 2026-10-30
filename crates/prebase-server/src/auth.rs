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

pub fn generate_bootstrap_token() -> String {
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

    // Strict offline Content Security Policy:
    // No external fonts, CDNs, scripts, or connections allowed.
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self' data:; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none';"
            .parse()
            .unwrap(),
    );
    headers.insert(header::X_FRAME_OPTIONS, "DENY".parse().unwrap());
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    headers.insert(header::REFERRER_POLICY, "no-referrer".parse().unwrap());

    resp
}

fn extract_cookie_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::COOKIE)
        .and_then(|h| h.to_str().ok())
        .and_then(|cookies| {
            for cookie in cookies.split(';') {
                let cookie = cookie.trim();
                if let Some(token) = cookie.strip_prefix("prebase_session=") {
                    return Some(token.to_string());
                }
            }
            None
        })
}

pub async fn host_and_auth_middleware(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    req: Request<Body>,
    next: Next,
) -> Result<Response, (StatusCode, &'static str)> {
    let port = state.allocated_port;

    // 1. Exact Host header validation (prevent DNS rebinding attacks)
    let host = match headers.get(header::HOST).and_then(|h| h.to_str().ok()) {
        Some(h) if !h.trim().is_empty() => h.trim(),
        _ => {
            warn!("Rejected request missing or empty Host header");
            return Err((StatusCode::BAD_REQUEST, "Missing or invalid Host header"));
        }
    };

    let expected_ip = format!("127.0.0.1:{port}");
    let expected_lh = format!("localhost:{port}");
    let matches = host.eq_ignore_ascii_case(&expected_ip)
        || host.eq_ignore_ascii_case(&expected_lh)
        || (port == 80
            && (host.eq_ignore_ascii_case("127.0.0.1") || host.eq_ignore_ascii_case("localhost")));

    if !matches {
        warn!(
            "Rejected request with invalid Host: {host} (expected {expected_ip} or {expected_lh})"
        );
        return Err((StatusCode::BAD_REQUEST, "Invalid Host header"));
    }

    // 2. Exact Origin validation (prevent unauthorized cross-origin requests)
    if let Some(origin) = headers.get(header::ORIGIN).and_then(|o| o.to_str().ok()) {
        let expected_ip = format!("http://127.0.0.1:{port}");
        let expected_lh = format!("http://localhost:{port}");
        let matches = origin == expected_ip
            || origin == expected_lh
            || (port == 80 && (origin == "http://127.0.0.1" || origin == "http://localhost"));

        if !matches {
            warn!("Rejected cross-origin request from: {origin}");
            return Err((StatusCode::FORBIDDEN, "Forbidden Origin"));
        }
    }

    let path = req.uri().path();
    let is_api_route = path.starts_with("/api/");
    let is_public_api = path == "/api/v1/health" || path == "/api/v1/auth/session";

    if is_api_route && !is_public_api {
        let mut authorized = false;

        // Check 1: X-Prebase-Session header
        if let Some(header_token) = headers
            .get("x-prebase-session")
            .and_then(|h| h.to_str().ok())
        {
            if header_token == state.session_token {
                authorized = true;
            }
        }

        // Check 2: HttpOnly Session Cookie
        if !authorized {
            if let Some(cookie_token) = extract_cookie_token(&headers) {
                if cookie_token == state.session_token {
                    authorized = true;
                }
            }
        }

        // Check 3: Query Parameter fallback (e.g. for initial testing or SSE)
        if !authorized {
            if let Some(ref q_token) = query.token {
                if q_token == &state.session_token {
                    authorized = true;
                }
            }
        }

        if !authorized {
            warn!("Unauthorized API request to {path}");
            return Err((
                StatusCode::UNAUTHORIZED,
                "Unauthorized: Invalid or missing session token",
            ));
        }
    }

    Ok(next.run(req).await)
}
