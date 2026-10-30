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
            Some("bootstrap-token-abc".into()),
            8080,
            false,
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

        // 4. Protected endpoint with cookie must succeed
        let cookie_auth_req = Request::builder()
            .uri("/api/v1/repository")
            .header(header::HOST, "127.0.0.1:8080")
            .header(header::COOKIE, "prebase_session=secret-token-xyz")
            .body(Body::empty())
            .unwrap();
        let cookie_resp = app.clone().oneshot(cookie_auth_req).await.unwrap();
        assert_eq!(cookie_resp.status(), StatusCode::OK);

        // 5. Host header validation must reject arbitrary external host or wrong port
        let evil_host_req = Request::builder()
            .uri("/api/v1/health")
            .header(header::HOST, "evil-attacker.com")
            .body(Body::empty())
            .unwrap();
        let evil_resp = app.clone().oneshot(evil_host_req).await.unwrap();
        assert_eq!(evil_resp.status(), StatusCode::BAD_REQUEST);

        let wrong_port_req = Request::builder()
            .uri("/api/v1/health")
            .header(header::HOST, "127.0.0.1:9999")
            .body(Body::empty())
            .unwrap();
        let wrong_port_resp = app.clone().oneshot(wrong_port_req).await.unwrap();
        assert_eq!(wrong_port_resp.status(), StatusCode::BAD_REQUEST);

        // 6. Bootstrap token exchange: first attempt succeeds, sets cookie, returns session_token
        let exchange_req = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/session")
            .header(header::HOST, "127.0.0.1:8080")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"bootstrap_token":"bootstrap-token-abc"}"#))
            .unwrap();
        let exchange_resp = app.clone().oneshot(exchange_req).await.unwrap();
        assert_eq!(exchange_resp.status(), StatusCode::OK);
        assert!(exchange_resp.headers().contains_key(header::SET_COOKIE));

        // Reusing the same bootstrap token must fail with 401
        let reuse_req = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/session")
            .header(header::HOST, "127.0.0.1:8080")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"bootstrap_token":"bootstrap-token-abc"}"#))
            .unwrap();
        let reuse_resp = app.clone().oneshot(reuse_req).await.unwrap();
        assert_eq!(reuse_resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn test_path_traversal_protection() {
        let temp = tempfile::tempdir().unwrap();
        let state = Arc::new(AppState::new(
            temp.path().to_path_buf(),
            "test-repo".into(),
            "repo-123".into(),
            "token".into(),
            None,
            8080,
            false,
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
            None,
            8080,
            false,
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

    #[tokio::test]
    async fn test_watcher_health_reporting_and_events() {
        let temp = tempfile::tempdir().unwrap();
        let state = Arc::new(AppState::new(
            temp.path().to_path_buf(),
            "test-repo".into(),
            "repo-123".into(),
            "token".into(),
            None,
            8080,
            false, // --no-watch
        ));

        let app = create_router(state.clone());

        // Check initial watcher_health is Disabled
        assert_eq!(
            state.get_watcher_health(),
            prebase_core::model::WatcherHealth::Disabled
        );

        let req = Request::builder()
            .uri("/api/v1/status")
            .header(header::HOST, "127.0.0.1:8080")
            .header("x-prebase-session", "token")
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let body_str = String::from_utf8(body.to_vec()).unwrap();
        assert!(body_str.contains(r#""watcher_health":"disabled""#));

        // Update health to Degraded
        state.set_watcher_health(prebase_core::model::WatcherHealth::Degraded);
        assert_eq!(
            state.get_watcher_health(),
            prebase_core::model::WatcherHealth::Degraded
        );

        // Verify ServerEvent::ReconcileRequired serialization
        let evt = ServerEvent::ReconcileRequired {
            current_revision: 99,
        };
        let serialized = serde_json::to_string(&evt).unwrap();
        assert_eq!(
            serialized,
            r#"{"type":"reconcile.required","data":{"current_revision":99}}"#
        );
    }

    #[tokio::test]
    async fn test_broadcast_stream_lagged_reconcile_event() {
        use tokio_stream::wrappers::BroadcastStream;
        use tokio_stream::StreamExt;

        let temp = tempfile::tempdir().unwrap();
        let state = Arc::new(AppState::new(
            temp.path().to_path_buf(),
            "test-repo".into(),
            "repo-123".into(),
            "token".into(),
            None,
            8080,
            false,
        ));

        // Advance current revision to 42
        state
            .revision_counter
            .store(42, std::sync::atomic::Ordering::SeqCst);

        let rx = state.event_sender.subscribe();
        let state_clone = state.clone();
        let mut stream = BroadcastStream::new(rx).filter_map(move |res| match res {
            Ok(evt) => {
                let data = serde_json::to_string(&evt).unwrap_or_default();
                Some(data)
            }
            Err(tokio_stream::wrappers::errors::BroadcastStreamRecvError::Lagged(_)) => {
                let current_revision = state_clone.get_current_revision();
                let evt = ServerEvent::ReconcileRequired { current_revision };
                let data = serde_json::to_string(&evt).unwrap_or_default();
                Some(data)
            }
        });

        // Overflow the broadcast buffer (capacity is 128)
        for i in 0..150 {
            let _ = state
                .event_sender
                .send(ServerEvent::Heartbeat { timestamp: i });
        }

        // The very first item from lagged stream must be ReconcileRequired with revision 42
        let first = stream.next().await.expect("expected stream item");
        assert!(first.contains(r#""type":"reconcile.required""#));
        assert!(first.contains(r#""current_revision":42"#));
    }

    #[tokio::test]
    async fn test_sse_endpoint_lagged_reconcile_event_e2e() {
        use axum::response::IntoResponse;
        use tokio_stream::StreamExt;

        let temp = tempfile::tempdir().unwrap();
        let state = Arc::new(AppState::new(
            temp.path().to_path_buf(),
            "test-repo".into(),
            "repo-123".into(),
            "token".into(),
            None,
            8080,
            false,
        ));

        state
            .revision_counter
            .store(108, std::sync::atomic::Ordering::SeqCst);

        // Call handle_events directly to get the actual SSE response stream produced by the handler
        let sse_resp = crate::routes::handle_events(axum::extract::State(state.clone()))
            .await
            .into_response();

        let mut data_stream = sse_resp.into_body().into_data_stream();

        // Overflow the broadcast channel while the subscriber is not reading
        for i in 0..150 {
            let _ = state
                .event_sender
                .send(ServerEvent::Heartbeat { timestamp: i });
        }

        // The first chunk yielded by the actual SSE handler body must be the reconcile.required SSE event
        let chunk = data_stream.next().await.expect("expected chunk").unwrap();
        let chunk_str = String::from_utf8(chunk.to_vec()).unwrap();
        assert!(
            chunk_str.contains(r#"data: {"type":"reconcile.required""#)
                || chunk_str.contains(r#""type":"reconcile.required""#)
        );
        assert!(chunk_str.contains(r#""current_revision":108"#));
    }

    #[tokio::test]
    async fn test_sse_route_lagged_reconcile_event_via_router() {
        use axum::http::Request;
        use tokio_stream::StreamExt;
        use tower::ServiceExt;

        let temp = tempfile::tempdir().unwrap();
        let state = Arc::new(AppState::new(
            temp.path().to_path_buf(),
            "test-repo".into(),
            "repo-123".into(),
            "token".into(),
            None,
            8080,
            false,
        ));
        state
            .revision_counter
            .store(77, std::sync::atomic::Ordering::SeqCst);

        let app = create_router(state.clone());

        let req = Request::builder()
            .uri("/api/v1/events")
            .header(header::HOST, "127.0.0.1:8080")
            .header("x-prebase-session", "token")
            .body(Body::empty())
            .unwrap();

        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/event-stream"
        );

        let mut data_stream = resp.into_body().into_data_stream();

        // Cause the broadcast stream to lag by overflowing its channel
        for i in 0..150 {
            let _ = state
                .event_sender
                .send(ServerEvent::Heartbeat { timestamp: i });
        }

        let chunk = data_stream
            .next()
            .await
            .expect("expected stream item")
            .unwrap();
        let text = String::from_utf8(chunk.to_vec()).unwrap();
        assert!(
            text.contains(r#"data: {"type":"reconcile.required""#)
                || text.contains("reconcile.required")
        );
        assert!(text.contains(r#""current_revision":77"#));

        // After the lag error is handled, the stream recovers and yields the remaining queued events
        let next_chunk = data_stream
            .next()
            .await
            .expect("expected next item")
            .unwrap();
        let next_text = String::from_utf8(next_chunk.to_vec()).unwrap();
        assert!(next_text.contains(r#""type":"heartbeat""#));
    }
}
