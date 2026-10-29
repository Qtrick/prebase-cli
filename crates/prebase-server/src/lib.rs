pub mod auth;
pub mod routes;
pub mod server;
pub mod state;
pub mod static_assets;

pub use auth::generate_session_token;
pub use server::{create_router, start_server, RunningServer};
pub use state::AppState;

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{header, Request, StatusCode};
    use std::sync::Arc;
    use tower::ServiceExt;

    #[tokio::test]
    async fn test_auth_and_security_headers() {
        let temp = tempfile::tempdir().unwrap();
        let state = Arc::new(AppState::new(
            temp.path().to_path_buf(),
            "test-repo".into(),
            "repo-123".into(),
            "secret-token-xyz".into(),
        ));

        let app = create_router(state.clone());

        // 1. Health endpoint should succeed without token
        let health_req = Request::builder()
            .uri("/api/v1/health")
            .header(header::HOST, "127.0.0.1:8080")
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(health_req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(resp.headers().contains_key(header::CONTENT_SECURITY_POLICY));
        assert_eq!(resp.headers().get(header::X_FRAME_OPTIONS).unwrap(), "DENY");

        // 2. Protected endpoint without token must return 401 Unauthorized
        let unauth_req = Request::builder()
            .uri("/api/v1/repository")
            .header(header::HOST, "127.0.0.1:8080")
            .body(Body::empty())
            .unwrap();
        let unauth_resp = app.clone().oneshot(unauth_req).await.unwrap();
        assert_eq!(unauth_resp.status(), StatusCode::UNAUTHORIZED);

        // 3. Protected endpoint with token in header must succeed
        let auth_req = Request::builder()
            .uri("/api/v1/repository")
            .header(header::HOST, "127.0.0.1:8080")
            .header("x-prebase-session", "secret-token-xyz")
            .body(Body::empty())
            .unwrap();
        let auth_resp = app.clone().oneshot(auth_req).await.unwrap();
        assert_eq!(auth_resp.status(), StatusCode::OK);

        // 4. Host header validation must reject arbitrary external host (DNS rebinding protection)
        let evil_host_req = Request::builder()
            .uri("/api/v1/health")
            .header(header::HOST, "evil-attacker.com")
            .body(Body::empty())
            .unwrap();
        let evil_resp = app.clone().oneshot(evil_host_req).await.unwrap();
        assert_eq!(evil_resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn test_path_traversal_protection() {
        let temp = tempfile::tempdir().unwrap();
        let state = Arc::new(AppState::new(
            temp.path().to_path_buf(),
            "test-repo".into(),
            "repo-123".into(),
            "token".into(),
        ));
        let app = create_router(state);

        let traversal_req = Request::builder()
            .uri("/api/v1/source/../../etc/passwd")
            .header(header::HOST, "127.0.0.1:8080")
            .header("x-prebase-session", "token")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(traversal_req).await.unwrap();
        assert!(resp.status() == StatusCode::BAD_REQUEST || resp.status() == StatusCode::FORBIDDEN);
    }
}
