use axum::{
    body::Body,
    extract::{Request, State},
    http::{header, HeaderMap, Method, StatusCode},
    middleware::Next,
    response::Response,
};
use rand::{distributions::Alphanumeric, Rng};
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

/// Constant-time byte comparison to mitigate local side-channel timing attacks.
pub(crate) fn constant_time_eq(a: &str, b: &str) -> bool {
    let a_bytes = a.as_bytes();
    let b_bytes = b.as_bytes();
    if a_bytes.len() != b_bytes.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a_bytes.iter().zip(b_bytes.iter()) {
        diff |= x ^ y;
    }
    diff == 0
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

pub(crate) fn extract_cookie_token(headers: &HeaderMap, port: u16) -> Option<String> {
    headers
        .get(header::COOKIE)
        .and_then(|h| h.to_str().ok())
        .and_then(|cookies| {
            let port_prefix = format!("prebase_session_{port}=");
            for cookie in cookies.split(';') {
                let cookie = cookie.trim();
                if let Some(token) = cookie.strip_prefix(&port_prefix) {
                    return Some(token.to_string());
                }
            }
            // Strict multi-instance isolation: Never fall back to generic un-suffixed cookie.
            // RFC 6265 scopes cookies to (Domain, Path, Name) without TCP port isolation.
            // Port-partitioning cookie names prevents cross-instance session clobbering.
            None
        })
}

pub async fn host_and_auth_middleware(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
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

    // 3. Defense-in-depth Sec-Fetch-Site validation (mitigate browser cross-site & same-site cross-port ambient cookie abuse)
    if let Some(sec_site) = headers.get("sec-fetch-site").and_then(|s| s.to_str().ok()) {
        let is_cross_origin = sec_site.eq_ignore_ascii_case("cross-site")
            || sec_site.eq_ignore_ascii_case("same-site");

        if is_cross_origin {
            let is_top_level_navigation = (req.method() == Method::GET
                || req.method() == Method::HEAD)
                && headers.get("sec-fetch-mode").and_then(|m| m.to_str().ok()) == Some("navigate")
                && !is_api_route
                && headers
                    .get("sec-fetch-dest")
                    .and_then(|d| d.to_str().ok())
                    .is_none_or(|d| d == "document");

            if !is_top_level_navigation {
                warn!("Rejected cross-origin request to {path} with Sec-Fetch-Site: {sec_site}");
                return Err((StatusCode::FORBIDDEN, "Forbidden Cross-Site Request"));
            }
        }
    }

    if is_api_route && !is_public_api {
        let mut authorized = false;

        // Check 1: X-Prebase-Session header (for non-browser CLI/automation tooling)
        if let Some(header_token) = headers
            .get("x-prebase-session")
            .and_then(|h| h.to_str().ok())
        {
            if constant_time_eq(header_token, &state.session_token) {
                authorized = true;
            }
        }

        // Check 2: HttpOnly Session Cookie (port-partitioned: prebase_session_{port})
        if !authorized {
            if let Some(cookie_token) = extract_cookie_token(&headers, port) {
                if constant_time_eq(&cookie_token, &state.session_token) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_constant_time_eq() {
        assert!(constant_time_eq("", ""));
        assert!(constant_time_eq("token-123456", "token-123456"));
        assert!(!constant_time_eq("token-123456", "token-123457"));
        assert!(!constant_time_eq("token-123456", "token-12345"));
        assert!(!constant_time_eq("token-12345", "token-123456"));
        assert!(!constant_time_eq("a", "b"));
    }

    #[test]
    fn test_extract_cookie_token_port_scoped() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            "other=val; prebase_session_8080=tok8080; prebase_session_8081=tok8081"
                .parse()
                .unwrap(),
        );

        // Exact port matches
        assert_eq!(
            extract_cookie_token(&headers, 8080),
            Some("tok8080".to_string())
        );
        assert_eq!(
            extract_cookie_token(&headers, 8081),
            Some("tok8081".to_string())
        );
        // Non-matching port returns None
        assert_eq!(extract_cookie_token(&headers, 9000), None);

        // Generic un-suffixed prebase_session cookie is strictly ignored (no fallback)
        let mut generic_headers = HeaderMap::new();
        generic_headers.insert(
            header::COOKIE,
            "prebase_session=legacy-token".parse().unwrap(),
        );
        assert_eq!(extract_cookie_token(&generic_headers, 8080), None);
    }
}
