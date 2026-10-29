pub mod auth;
pub mod routes;
pub mod server;
pub mod state;
pub mod static_assets;
pub mod watcher;

pub use auth::generate_session_token;
pub use server::{create_router, start_server, RunningServer};
pub use state::{AppState, PublishedNetworkState, ServerEvent};

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{header, Request, StatusCode};
    use prebase_core::index::GraphIndex;
    use prebase_core::model::{AnalysisCoverage, GraphSnapshot};
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

        // 4. Protected endpoint with token in query string (for SSE) must succeed
        let query_auth_req = Request::builder()
            .uri("/api/v1/repository?token=secret-token-xyz")
            .header(header::HOST, "127.0.0.1:8080")
            .body(Body::empty())
            .unwrap();
        let query_resp = app.clone().oneshot(query_auth_req).await.unwrap();
        assert_eq!(query_resp.status(), StatusCode::OK);

        // 5. Host header validation must reject arbitrary external host (DNS rebinding protection)
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

    #[tokio::test]
    async fn test_atomic_state_publication_and_monotonic_revisions() {
        let temp = tempfile::tempdir().unwrap();
        let state = Arc::new(AppState::new(
            temp.path().to_path_buf(),
            "test-repo".into(),
            "repo-123".into(),
            "token".into(),
        ));

        let mut event_rx = state.event_sender.subscribe();

        // Create empty dummy snapshot
        let snap1 = GraphSnapshot {
            schema_version: "1.0.0".into(),
            repository_id: "repo-123".into(),
            revision: 0,
            nodes: vec![],
            edges: vec![],
            coverage: AnalysisCoverage {
                total_discovered: 0,
                total_analyzed: 0,
                total_excluded: 0,
                total_issues: 0,
                is_complete: true,
            },
            issues: vec![],
        };
        let index1 = GraphIndex::build(&snap1);

        // Publish revision 1
        let rev1 = state
            .publish_network(snap1.clone(), index1, vec!["file1.ts".into()], None)
            .unwrap();
        assert_eq!(rev1, 1);
        assert_eq!(state.get_current_revision(), 1);

        let pub1 = state.get_published().expect("expected published state");
        assert_eq!(pub1.revision, 1);
        assert_eq!(pub1.snapshot.revision, 1);

        // Check broadcast event
        let evt = event_rx.try_recv().expect("expected SSE event");
        match evt {
            ServerEvent::NetworkUpdated {
                revision,
                changed_files,
                ..
            } => {
                assert_eq!(revision, 1);
                assert_eq!(changed_files, vec!["file1.ts"]);
            }
            _ => panic!("unexpected event variant"),
        }

        // Publish revision 2 (strictly monotonic)
        let index2 = GraphIndex::build(&snap1);
        let rev2 = state
            .publish_network(snap1, index2, vec!["file2.ts".into()], None)
            .unwrap();
        assert_eq!(rev2, 2);
        assert_eq!(state.get_current_revision(), 2);

        // Stale generation protection test
        let stale_index = GraphIndex::build(&pub1.snapshot);
        let current_gen = state.get_next_generation();
        // Trying to publish with old generation
        let stale_result = state.publish_network(
            (*pub1.snapshot).clone(),
            stale_index,
            vec![],
            Some(current_gen - 1),
        );
        assert!(stale_result.is_err());
    }
}
