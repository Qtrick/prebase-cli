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

        // 4. Port-partitioned cookie must succeed; generic un-suffixed cookie must be rejected (RFC 6265 isolation)
        let port_cookie_req = Request::builder()
            .uri("/api/v1/repository")
            .header(header::HOST, "127.0.0.1:8080")
            .header(header::COOKIE, "prebase_session_8080=secret-token-xyz")
            .body(Body::empty())
            .unwrap();
        let port_cookie_resp = app.clone().oneshot(port_cookie_req).await.unwrap();
        assert_eq!(port_cookie_resp.status(), StatusCode::OK);

        let generic_cookie_req = Request::builder()
            .uri("/api/v1/repository")
            .header(header::HOST, "127.0.0.1:8080")
            .header(header::COOKIE, "prebase_session=secret-token-xyz")
            .body(Body::empty())
            .unwrap();
        let generic_cookie_resp = app.clone().oneshot(generic_cookie_req).await.unwrap();
        assert_eq!(generic_cookie_resp.status(), StatusCode::UNAUTHORIZED);

        // 4b. Query token parameter must be rejected (defense-in-depth against URL credential leakage)
        let query_token_req = Request::builder()
            .uri("/api/v1/repository?token=secret-token-xyz")
            .header(header::HOST, "127.0.0.1:8080")
            .body(Body::empty())
            .unwrap();
        let query_token_resp = app.clone().oneshot(query_token_req).await.unwrap();
        assert_eq!(query_token_resp.status(), StatusCode::UNAUTHORIZED);

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

        // 5b. Cross-site API request with Sec-Fetch-Site: cross-site must be rejected with 403
        let cross_site_api_req = Request::builder()
            .uri("/api/v1/repository")
            .header(header::HOST, "127.0.0.1:8080")
            .header("x-prebase-session", "secret-token-xyz")
            .header("sec-fetch-site", "cross-site")
            .header("sec-fetch-mode", "cors")
            .body(Body::empty())
            .unwrap();
        let cross_site_api_resp = app.clone().oneshot(cross_site_api_req).await.unwrap();
        assert_eq!(cross_site_api_resp.status(), StatusCode::FORBIDDEN);

        // 5c. Cross-site subresource (script/image from evil.com) must be rejected with 403
        let cross_site_sub_req = Request::builder()
            .uri("/assets/index.js")
            .header(header::HOST, "127.0.0.1:8080")
            .header("sec-fetch-site", "cross-site")
            .header("sec-fetch-mode", "no-cors")
            .header("sec-fetch-dest", "script")
            .body(Body::empty())
            .unwrap();
        let cross_site_sub_resp = app.clone().oneshot(cross_site_sub_req).await.unwrap();
        assert_eq!(cross_site_sub_resp.status(), StatusCode::FORBIDDEN);

        // 5d. Legitimate top-level browser navigation from external links (Slack, GitHub, email) must be permitted
        let cross_site_nav_req = Request::builder()
            .uri("/")
            .header(header::HOST, "127.0.0.1:8080")
            .header("sec-fetch-site", "cross-site")
            .header("sec-fetch-mode", "navigate")
            .header("sec-fetch-dest", "document")
            .body(Body::empty())
            .unwrap();
        let cross_site_nav_resp = app.clone().oneshot(cross_site_nav_req).await.unwrap();
        assert_ne!(cross_site_nav_resp.status(), StatusCode::FORBIDDEN);

        // 6. Bootstrap token exchange: first attempt succeeds, sets port-isolated cookie, omits session_token by default
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
        let body_bytes = axum::body::to_bytes(exchange_resp.into_body(), 1024)
            .await
            .unwrap();
        let json_body: serde_json::Value = serde_json::from_slice(&body_bytes).unwrap();
        assert_eq!(json_body["authenticated"], true);
        assert!(json_body.get("session_token").is_none());

        // Reusing the same bootstrap token without a valid cookie must fail with 401
        let reuse_req = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/session")
            .header(header::HOST, "127.0.0.1:8080")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"bootstrap_token":"bootstrap-token-abc"}"#))
            .unwrap();
        let reuse_resp = app.clone().oneshot(reuse_req).await.unwrap();
        assert_eq!(reuse_resp.status(), StatusCode::UNAUTHORIZED);

        // Multi-tab / reload friendliness: if a valid session cookie is present, return 200 OK
        let valid_cookie_req = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/session")
            .header(header::HOST, "127.0.0.1:8080")
            .header(header::COOKIE, "prebase_session_8080=secret-token-xyz")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"bootstrap_token":"already-consumed"}"#))
            .unwrap();
        let valid_cookie_resp = app.clone().oneshot(valid_cookie_req).await.unwrap();
        assert_eq!(valid_cookie_resp.status(), StatusCode::OK);

        // Ambient cookie re-auth must NEVER expose token in JSON even if expose_token: true is requested
        let oracle_attempt_req = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/session")
            .header(header::HOST, "127.0.0.1:8080")
            .header(header::COOKIE, "prebase_session_8080=secret-token-xyz")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                r#"{"bootstrap_token":"consumed","expose_token":true}"#,
            ))
            .unwrap();
        let oracle_resp = app.clone().oneshot(oracle_attempt_req).await.unwrap();
        assert_eq!(oracle_resp.status(), StatusCode::OK);
        let oracle_bytes = axum::body::to_bytes(oracle_resp.into_body(), 1024)
            .await
            .unwrap();
        let oracle_json: serde_json::Value = serde_json::from_slice(&oracle_bytes).unwrap();
        assert_eq!(oracle_json["authenticated"], true);
        assert!(
            oracle_json.get("session_token").is_none(),
            "Ambient cookie must never expose token in JSON response"
        );

        // Bootstrap token exchange with expose_token: true returns session_token for authorized automation
        let auto_state = Arc::new(AppState::new(
            temp.path().to_path_buf(),
            "test-repo".into(),
            "repo-123".into(),
            "secret-token-123".into(),
            Some("bootstrap-auto-456".into()),
            8081,
            false,
        ));
        let auto_app = create_router(auto_state);
        let auto_req = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/session")
            .header(header::HOST, "127.0.0.1:8081")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                r#"{"bootstrap_token":"bootstrap-auto-456","expose_token":true}"#,
            ))
            .unwrap();
        let auto_resp = auto_app.oneshot(auto_req).await.unwrap();
        assert_eq!(auto_resp.status(), StatusCode::OK);
        let auto_bytes = axum::body::to_bytes(auto_resp.into_body(), 1024)
            .await
            .unwrap();
        let auto_json: serde_json::Value = serde_json::from_slice(&auto_bytes).unwrap();
        assert_eq!(auto_json["session_token"], "secret-token-123");
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
    async fn test_handle_get_source_security_and_toctou_defense() {
        use prebase_core::index::GraphIndex;
        use prebase_core::model::{
            AnalysisCoverage, FileKind, FileNode, GraphSnapshot, NodeAnalysisStatus,
        };
        use std::fs;

        let temp = tempfile::tempdir().unwrap();
        let repo_root = temp.path().canonicalize().unwrap();
        let src_dir = repo_root.join("src");
        fs::create_dir_all(&src_dir).unwrap();

        // 1. Legitimate source file
        let valid_file = src_dir.join("main.ts");
        let valid_content = "console.log('hello prebase');";
        fs::write(&valid_file, valid_content).unwrap();

        // 2. Unindexed file on disk
        let unindexed_file = src_dir.join("unindexed.ts");
        fs::write(&unindexed_file, "console.log('secret');").unwrap();

        // 3. Excluded secret file on disk
        let secret_file = src_dir.join(".env");
        fs::write(&secret_file, "SECRET=123").unwrap();

        // 4. Oversized file (> 500KB)
        let large_file = src_dir.join("large.ts");
        let large_content = vec![b'x'; 501 * 1024]; // 501 KB
        fs::write(&large_file, large_content).unwrap();

        // 5. Directory inside src
        let sub_dir = src_dir.join("sub_dir");
        fs::create_dir_all(&sub_dir).unwrap();

        let state = Arc::new(AppState::new(
            repo_root.clone(),
            "test-repo".into(),
            "repo-123".into(),
            "token-xyz".into(),
            None,
            8080,
            false,
        ));

        // Create published snapshot containing valid_file, large_file, secret_file, and sub_dir
        let snap = GraphSnapshot {
            schema_version: "1.0.0".into(),
            repository_id: "repo-123".into(),
            revision: 1,
            nodes: vec![
                FileNode {
                    id: "src/main.ts".into(),
                    relative_path: "src/main.ts".into(),
                    filename: "main.ts".into(),
                    language: "typescript".into(),
                    size_bytes: valid_content.len() as u64,
                    file_kind: FileKind::Source,
                    analysis_status: NodeAnalysisStatus::Analyzed,
                    direct_dependency_count: 0,
                    direct_dependent_count: 0,
                },
                FileNode {
                    id: "src/large.ts".into(),
                    relative_path: "src/large.ts".into(),
                    filename: "large.ts".into(),
                    language: "typescript".into(),
                    size_bytes: 501 * 1024,
                    file_kind: FileKind::Source,
                    analysis_status: NodeAnalysisStatus::Analyzed,
                    direct_dependency_count: 0,
                    direct_dependent_count: 0,
                },
                FileNode {
                    id: "src/.env".into(),
                    relative_path: "src/.env".into(),
                    filename: ".env".into(),
                    language: "unknown".into(),
                    size_bytes: 10,
                    file_kind: FileKind::Other,
                    analysis_status: NodeAnalysisStatus::Unsupported,
                    direct_dependency_count: 0,
                    direct_dependent_count: 0,
                },
                FileNode {
                    id: "src/sub_dir".into(),
                    relative_path: "src/sub_dir".into(),
                    filename: "sub_dir".into(),
                    language: "unknown".into(),
                    size_bytes: 0,
                    file_kind: FileKind::Other,
                    analysis_status: NodeAnalysisStatus::Unsupported,
                    direct_dependency_count: 0,
                    direct_dependent_count: 0,
                },
            ],
            edges: vec![],
            coverage: AnalysisCoverage::default(),
            issues: vec![],
        };
        let index = GraphIndex::build(&snap);
        state.publish_network(snap, index, vec![], None).unwrap();

        let app = create_router(state);

        // Case A: Valid indexed file -> 200 OK
        let req_valid = Request::builder()
            .uri("/api/v1/source/src/main.ts")
            .header(header::HOST, "127.0.0.1:8080")
            .header("x-prebase-session", "token-xyz")
            .body(Body::empty())
            .unwrap();
        let resp_valid = app.clone().oneshot(req_valid).await.unwrap();
        assert_eq!(resp_valid.status(), StatusCode::OK);
        let bytes_valid = axum::body::to_bytes(resp_valid.into_body(), 1024)
            .await
            .unwrap();
        let json_valid: serde_json::Value = serde_json::from_slice(&bytes_valid).unwrap();
        assert_eq!(json_valid["path"], "src/main.ts");
        assert_eq!(json_valid["content"], valid_content);

        // Case B: Unindexed file on disk -> 403 FORBIDDEN
        let req_unindexed = Request::builder()
            .uri("/api/v1/source/src/unindexed.ts")
            .header(header::HOST, "127.0.0.1:8080")
            .header("x-prebase-session", "token-xyz")
            .body(Body::empty())
            .unwrap();
        let resp_unindexed = app.clone().oneshot(req_unindexed).await.unwrap();
        assert_eq!(resp_unindexed.status(), StatusCode::FORBIDDEN);

        // Case C: Excluded secret file (.env) -> 403 FORBIDDEN
        let req_secret = Request::builder()
            .uri("/api/v1/source/src/.env")
            .header(header::HOST, "127.0.0.1:8080")
            .header("x-prebase-session", "token-xyz")
            .body(Body::empty())
            .unwrap();
        let resp_secret = app.clone().oneshot(req_secret).await.unwrap();
        assert_eq!(resp_secret.status(), StatusCode::FORBIDDEN);

        // Case D: Oversized file (> 500KB) -> 413 PAYLOAD_TOO_LARGE
        let req_large = Request::builder()
            .uri("/api/v1/source/src/large.ts")
            .header(header::HOST, "127.0.0.1:8080")
            .header("x-prebase-session", "token-xyz")
            .body(Body::empty())
            .unwrap();
        let resp_large = app.clone().oneshot(req_large).await.unwrap();
        assert_eq!(resp_large.status(), StatusCode::PAYLOAD_TOO_LARGE);

        // Case E: Directory handle -> 400 BAD_REQUEST
        let req_dir = Request::builder()
            .uri("/api/v1/source/src/sub_dir")
            .header(header::HOST, "127.0.0.1:8080")
            .header("x-prebase-session", "token-xyz")
            .body(Body::empty())
            .unwrap();
        let resp_dir = app.clone().oneshot(req_dir).await.unwrap();
        assert_eq!(resp_dir.status(), StatusCode::BAD_REQUEST);

        // Case F: Path traversal .. -> 400 BAD_REQUEST
        let req_trav = Request::builder()
            .uri("/api/v1/source/src/../main.ts")
            .header(header::HOST, "127.0.0.1:8080")
            .header("x-prebase-session", "token-xyz")
            .body(Body::empty())
            .unwrap();
        let resp_trav = app.clone().oneshot(req_trav).await.unwrap();
        assert_eq!(resp_trav.status(), StatusCode::BAD_REQUEST);
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

    #[test]
    fn test_is_safe_relative_path_component_aware() {
        use crate::routes::is_safe_relative_path;

        // 1. Valid filenames with multiple adjacent periods or leading dot files
        let valid_paths = [
            "src/component..ts",
            "src/version..legacy.ts",
            "src/..hidden.ts",
            "src/index.ts",
            "deep/nested/dir/valid..name...ext",
            "nested/.hidden",
            "file...with...many...dots.js",
        ];
        for path in &valid_paths {
            assert!(
                is_safe_relative_path(path),
                "Expected path '{}' to be accepted as safe",
                path
            );
        }

        // 2. Traversal attempts (ParentDir components)
        let traversal_paths = [
            "../secret.ts",
            "src/../../outside.ts",
            "..",
            "src/..",
            "src/../main.ts",
            "src\\..\\secret.ts",
            "..\\secret.ts",
            "a/b/../../../etc/passwd",
        ];
        for path in &traversal_paths {
            assert!(
                !is_safe_relative_path(path),
                "Expected traversal path '{}' to be rejected",
                path
            );
        }

        // 3. Absolute paths and Windows drive prefixes
        let absolute_paths = [
            "/etc/passwd",
            "/absolute/path.ts",
            "/",
            "\\absolute\\path.ts",
            "C:/Windows/System32",
            "D:\\secret\\keys.txt",
            "c:relative\\to\\drive.ts",
        ];
        for path in &absolute_paths {
            assert!(
                !is_safe_relative_path(path),
                "Expected absolute path '{}' to be rejected",
                path
            );
        }

        // 4. Empty path, whitespace, null bytes, or leading slashes
        let malformed_paths = [
            "",
            "   ",
            "\t\n",
            "src/\0payload.ts",
            "\0",
            "/leading/slash.ts",
            "\\leading\\backslash.ts",
        ];
        for path in &malformed_paths {
            assert!(
                !is_safe_relative_path(path),
                "Expected malformed or null-byte path '{:?}' to be rejected",
                path
            );
        }
    }

    #[tokio::test]
    async fn test_static_asset_serving_and_spa_routing() {
        let temp = tempfile::tempdir().unwrap();
        let state = Arc::new(AppState::new(
            temp.path().to_path_buf(),
            "test-repo".into(),
            "repo-123".into(),
            "secret-token-xyz".into(),
            None,
            8080,
            false,
        ));
        let app = create_router(state);

        // Helper closure to build requests with valid Host header
        let make_req = |uri: &str, token: Option<&str>| {
            let mut builder = Request::builder()
                .uri(uri)
                .header(header::HOST, "127.0.0.1:8080");
            if let Some(tok) = token {
                builder = builder.header("x-prebase-session", tok);
            }
            builder.body(Body::empty()).unwrap()
        };

        // 1. Root route `/` -> 200 OK, Content-Type text/html
        let root_resp = app.clone().oneshot(make_req("/", None)).await.unwrap();
        assert_eq!(root_resp.status(), StatusCode::OK);
        let root_ct = root_resp
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        assert!(
            root_ct.contains("text/html"),
            "Expected Content-Type to contain text/html, got '{root_ct}'"
        );

        // 2. SPA routes `/map` and `/history` -> 200 OK, Content-Type text/html
        for spa_route in &["/map", "/history"] {
            let resp = app
                .clone()
                .oneshot(make_req(spa_route, None))
                .await
                .unwrap();
            assert_eq!(
                resp.status(),
                StatusCode::OK,
                "Expected SPA route '{spa_route}' to return 200 OK"
            );
            let ct = resp
                .headers()
                .get(header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default();
            assert!(
                ct.contains("text/html"),
                "Expected Content-Type for '{spa_route}' to contain text/html, got '{ct}'"
            );
        }

        // 3. Missing JavaScript asset -> 404 NOT_FOUND (MUST NOT fall back to index.html)
        let missing_js_resp = app
            .clone()
            .oneshot(make_req("/assets/nonexistent-chunk-999.js", None))
            .await
            .unwrap();
        assert_eq!(
            missing_js_resp.status(),
            StatusCode::NOT_FOUND,
            "Missing JS chunk must return 404 rather than index.html"
        );

        // 4. Missing CSS asset -> 404 NOT_FOUND
        let missing_css_resp = app
            .clone()
            .oneshot(make_req("/style/missing.css", None))
            .await
            .unwrap();
        assert_eq!(
            missing_css_resp.status(),
            StatusCode::NOT_FOUND,
            "Missing CSS file must return 404"
        );

        // 5. Missing API route -> 404 NOT_FOUND (with auth so it hits API fallback, not auth rejection)
        let missing_api_resp = app
            .clone()
            .oneshot(make_req(
                "/api/v1/nonexistent_endpoint",
                Some("secret-token-xyz"),
            ))
            .await
            .unwrap();
        assert_eq!(
            missing_api_resp.status(),
            StatusCode::NOT_FOUND,
            "Missing API route must return 404"
        );

        // 6. Malformed or traversal paths -> 400 BAD_REQUEST
        for malformed in &["/../secret", "/assets/../../etc/passwd"] {
            let resp = app
                .clone()
                .oneshot(make_req(malformed, None))
                .await
                .unwrap();
            assert_eq!(
                resp.status(),
                StatusCode::BAD_REQUEST,
                "Traversal path '{malformed}' must return 400 BAD_REQUEST"
            );
        }
    }

    #[test]
    fn test_shutdown_discards_inflight_reanalysis() {
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

        // Initial state before shutdown
        assert!(!state.is_shutting_down());
        assert_eq!(state.get_current_revision(), 0);
        assert!(state.get_published().is_none());

        let dummy_snapshot = GraphSnapshot {
            schema_version: "1.0.0".into(),
            repository_id: "repo-123".into(),
            revision: 0,
            nodes: vec![],
            edges: vec![],
            coverage: AnalysisCoverage::default(),
            issues: vec![],
        };
        let dummy_index = GraphIndex::build(&dummy_snapshot);

        // 1. Publish baseline revision 1
        let rev1 = state
            .publish_network(dummy_snapshot.clone(), dummy_index.clone(), vec![], None)
            .expect("baseline publication should succeed");
        assert_eq!(rev1, 1);
        assert_eq!(state.get_current_revision(), 1);
        let published_before = state.get_published().expect("expected published state");
        assert_eq!(published_before.revision, 1);

        // 2. Transition state to shutting down
        state.set_shutting_down();
        assert!(
            state.is_shutting_down(),
            "state.is_shutting_down() must return true after set_shutting_down()"
        );

        // 3. In-flight reanalysis attempting to publish during shutdown must be discarded
        let publish_result = state.publish_network(
            dummy_snapshot,
            dummy_index,
            vec!["file_modified_during_shutdown.ts".into()],
            None,
        );

        assert!(
            publish_result.is_err(),
            "publish_network during shutdown must return an Err"
        );
        assert_eq!(
            publish_result.unwrap_err(),
            "Server is shutting down; reanalysis publication discarded"
        );

        // 4. Verify revision counter was NOT incremented and published state was NOT modified
        assert_eq!(
            state.get_current_revision(),
            1,
            "Revision counter must not increment after failed shutdown publish"
        );
        let published_after = state
            .get_published()
            .expect("published state must still exist");
        assert_eq!(
            published_after.revision, 1,
            "Published state revision must remain untouched at 1"
        );
    }
}
