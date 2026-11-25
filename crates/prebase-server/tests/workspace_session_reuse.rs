use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use prebase_server::{create_router, start_server, AppState};
use std::sync::Arc;
use tower::ServiceExt;

#[tokio::test]
async fn test_workspace_navigate_no_clients_and_bootstrap_mint_auth() {
    let temp = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new(
        temp.path().to_path_buf(),
        "test-repo".into(),
        "repo-abc".into(),
        "sess-tok-123".into(),
        Some("boot-1".into()),
        8080,
        false,
    ));
    let app = create_router(state.clone());

    // 1. Navigate with 0 active SSE clients returns delivered: false, acknowledged: false immediately
    let nav_req = Request::builder()
        .method("POST")
        .uri("/api/v1/workspace/navigate")
        .header(header::HOST, "127.0.0.1:8080")
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-prebase-session", "sess-tok-123")
        .body(Body::from(r#"{"view":"2d","focus":"src/main.rs"}"#))
        .unwrap();
    let nav_resp = app.clone().oneshot(nav_req).await.unwrap();
    assert_eq!(nav_resp.status(), StatusCode::OK);
    let body_bytes = axum::body::to_bytes(nav_resp.into_body(), 1024 * 64)
        .await
        .unwrap();
    let nav_json: serde_json::Value = serde_json::from_slice(&body_bytes).unwrap();
    assert_eq!(nav_json["delivered"], false);
    assert_eq!(nav_json["acknowledged"], false);
    assert_eq!(nav_json["active_clients"], 0);

    // 2. Invalid view rejected with 400
    let bad_view_req = Request::builder()
        .method("POST")
        .uri("/api/v1/workspace/navigate")
        .header(header::HOST, "127.0.0.1:8080")
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-prebase-session", "sess-tok-123")
        .body(Body::from(r#"{"view":"invalid"}"#))
        .unwrap();
    let bad_view_resp = app.clone().oneshot(bad_view_req).await.unwrap();
    assert_eq!(bad_view_resp.status(), StatusCode::BAD_REQUEST);

    // 3. Mint bootstrap requires explicit X-Prebase-Session header (cookie alone -> 403)
    let cookie_mint_req = Request::builder()
        .method("POST")
        .uri("/api/v1/auth/bootstrap")
        .header(header::HOST, "127.0.0.1:8080")
        .header(header::COOKIE, "prebase_session_8080=sess-tok-123")
        .body(Body::from("{}"))
        .unwrap();
    let cookie_mint_resp = app.clone().oneshot(cookie_mint_req).await.unwrap();
    assert_eq!(cookie_mint_resp.status(), StatusCode::FORBIDDEN);

    // 4. Mint bootstrap with X-Prebase-Session succeeds and minted token can be exchanged
    let cli_mint_req = Request::builder()
        .method("POST")
        .uri("/api/v1/auth/bootstrap")
        .header(header::HOST, "127.0.0.1:8080")
        .header("x-prebase-session", "sess-tok-123")
        .body(Body::from("{}"))
        .unwrap();
    let cli_mint_resp = app.clone().oneshot(cli_mint_req).await.unwrap();
    assert_eq!(cli_mint_resp.status(), StatusCode::OK);
    let mint_bytes = axum::body::to_bytes(cli_mint_resp.into_body(), 1024 * 64)
        .await
        .unwrap();
    let mint_json: serde_json::Value = serde_json::from_slice(&mint_bytes).unwrap();
    let new_boot = mint_json["bootstrap_token"].as_str().unwrap();
    assert!(!new_boot.is_empty());
    assert_ne!(new_boot, "boot-1");

    let exchange_req = Request::builder()
        .method("POST")
        .uri("/api/v1/auth/session")
        .header(header::HOST, "127.0.0.1:8080")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::json!({ "bootstrap_token": new_boot }).to_string(),
        ))
        .unwrap();
    let exchange_resp = app.clone().oneshot(exchange_req).await.unwrap();
    assert_eq!(exchange_resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn test_sse_client_tracking_and_ack_correlation() {
    let temp = tempfile::tempdir().unwrap();
    let server = start_server(
        temp.path().to_path_buf(),
        "test-repo".into(),
        "repo-xyz".into(),
        None,
        false,
    )
    .await
    .unwrap();

    let state = server.state.clone();
    let app = create_router(state.clone());

    // Invalid client_id rejected with 400
    let bad_sse_req = Request::builder()
        .uri("/api/v1/events?client_id=bad%20id!")
        .header(header::HOST, format!("127.0.0.1:{}", server.port))
        .header("x-prebase-session", &server.session_token)
        .body(Body::empty())
        .unwrap();
    let bad_sse_resp = app.clone().oneshot(bad_sse_req).await.unwrap();
    assert_eq!(bad_sse_resp.status(), StatusCode::BAD_REQUEST);

    // Valid SSE client connects
    let sse_req = Request::builder()
        .uri("/api/v1/events?client_id=tab_alpha_1")
        .header(header::HOST, format!("127.0.0.1:{}", server.port))
        .header("x-prebase-session", &server.session_token)
        .body(Body::empty())
        .unwrap();
    let sse_resp = app.clone().oneshot(sse_req).await.unwrap();
    assert_eq!(sse_resp.status(), StatusCode::OK);
    assert_eq!(state.active_sse_client_count(), 1);

    // Trigger workspace navigate in background and ack from client
    let nav_app = app.clone();
    let nav_port = server.port;
    let nav_tok = server.session_token.clone();
    let nav_handle = tokio::spawn(async move {
        let req = Request::builder()
            .method("POST")
            .uri("/api/v1/workspace/navigate")
            .header(header::HOST, format!("127.0.0.1:{nav_port}"))
            .header(header::CONTENT_TYPE, "application/json")
            .header("x-prebase-session", nav_tok)
            .body(Body::from(
                r#"{"view":"temporal","focus":"src/lib.rs","timeout_ms":2000}"#,
            ))
            .unwrap();
        nav_app.oneshot(req).await.unwrap()
    });

    // Wait briefly for pending_nav_acks to be registered, then extract request_id and ack
    let mut req_id = None;
    for _ in 0..40 {
        {
            let guard = state.pending_nav_acks.lock().unwrap();
            if let Some(k) = guard.keys().next() {
                req_id = Some(k.clone());
                break;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let req_id = req_id.expect("Expected pending navigation request_id");

    let ack_req = Request::builder()
        .method("POST")
        .uri("/api/v1/workspace/ack")
        .header(header::HOST, format!("127.0.0.1:{}", server.port))
        .header(header::CONTENT_TYPE, "application/json")
        .header(
            header::COOKIE,
            format!("prebase_session_{}={}", server.port, server.session_token),
        )
        .body(Body::from(
            serde_json::json!({
                "request_id": req_id,
                "client_id": "tab_alpha_1"
            })
            .to_string(),
        ))
        .unwrap();
    let ack_resp = app.clone().oneshot(ack_req).await.unwrap();
    assert_eq!(ack_resp.status(), StatusCode::OK);

    let nav_resp = nav_handle.await.unwrap();
    assert_eq!(nav_resp.status(), StatusCode::OK);
    let nav_bytes = axum::body::to_bytes(nav_resp.into_body(), 1024 * 64)
        .await
        .unwrap();
    let nav_json: serde_json::Value = serde_json::from_slice(&nav_bytes).unwrap();
    assert_eq!(nav_json["delivered"], true);
    assert_eq!(nav_json["acknowledged"], true);
    assert_eq!(nav_json["client_id"], "tab_alpha_1");

    // Dropping the SSE response stream unregisters the client
    drop(sse_resp);
    assert_eq!(state.active_sse_client_count(), 0);

    let _ = server.shutdown_tx.send(());
}

#[tokio::test]
async fn test_workspace_navigate_ack_timeout_and_auth_boundaries() {
    let temp = tempfile::tempdir().unwrap();
    let server = start_server(
        temp.path().to_path_buf(),
        "test-repo".into(),
        "repo-timeout".into(),
        None,
        false,
    )
    .await
    .unwrap();

    let state = server.state.clone();
    let app = create_router(state.clone());

    // 1. Unauthenticated / wrong token / cookie-only rejected on workspace/navigate and auth/bootstrap
    let cookie_only_nav = Request::builder()
        .method("POST")
        .uri("/api/v1/workspace/navigate")
        .header(header::HOST, format!("127.0.0.1:{}", server.port))
        .header(header::CONTENT_TYPE, "application/json")
        .header(
            header::COOKIE,
            format!("prebase_session_{}={}", server.port, server.session_token),
        )
        .body(Body::from(r#"{"view":"3d"}"#))
        .unwrap();
    assert_eq!(
        app.clone().oneshot(cookie_only_nav).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );

    let unauth_nav = Request::builder()
        .method("POST")
        .uri("/api/v1/workspace/navigate")
        .header(header::HOST, format!("127.0.0.1:{}", server.port))
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-prebase-session", "wrong-token")
        .body(Body::from(r#"{"view":"3d"}"#))
        .unwrap();
    assert_eq!(
        app.clone().oneshot(unauth_nav).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );

    let unauth_boot = Request::builder()
        .method("POST")
        .uri("/api/v1/auth/bootstrap")
        .header(header::HOST, format!("127.0.0.1:{}", server.port))
        .header("x-prebase-session", "wrong-token")
        .body(Body::from("{}"))
        .unwrap();
    assert_eq!(
        app.clone().oneshot(unauth_boot).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );

    // 2. Connect an SSE client that does NOT ack -> navigate reports delivered: true, acknowledged: false after timeout
    let sse_req = Request::builder()
        .uri("/api/v1/events?client_id=silent_tab_1")
        .header(header::HOST, format!("127.0.0.1:{}", server.port))
        .header("x-prebase-session", &server.session_token)
        .body(Body::empty())
        .unwrap();
    let sse_resp = app.clone().oneshot(sse_req).await.unwrap();
    assert_eq!(sse_resp.status(), StatusCode::OK);
    assert_eq!(state.active_sse_client_count(), 1);

    let nav_req = Request::builder()
        .method("POST")
        .uri("/api/v1/workspace/navigate")
        .header(header::HOST, format!("127.0.0.1:{}", server.port))
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-prebase-session", &server.session_token)
        .body(Body::from(r#"{"view":"2d","timeout_ms":100}"#))
        .unwrap();
    let nav_resp = app.clone().oneshot(nav_req).await.unwrap();
    assert_eq!(nav_resp.status(), StatusCode::OK);
    let nav_bytes = axum::body::to_bytes(nav_resp.into_body(), 1024 * 64)
        .await
        .unwrap();
    let nav_json: serde_json::Value = serde_json::from_slice(&nav_bytes).unwrap();
    assert_eq!(nav_json["delivered"], true);
    assert_eq!(nav_json["acknowledged"], false);
    assert_eq!(nav_json["active_clients"], 0);

    // 3. Unknown request_id ack returns ok with acknowledged: false
    let stale_ack_req = Request::builder()
        .method("POST")
        .uri("/api/v1/workspace/ack")
        .header(header::HOST, format!("127.0.0.1:{}", server.port))
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-prebase-session", &server.session_token)
        .body(Body::from(
            r#"{"request_id":"nonexistent-req-id","client_id":"silent_tab_1"}"#,
        ))
        .unwrap();
    let stale_ack_resp = app.clone().oneshot(stale_ack_req).await.unwrap();
    assert_eq!(stale_ack_resp.status(), StatusCode::OK);
    let ack_bytes = axum::body::to_bytes(stale_ack_resp.into_body(), 1024 * 64)
        .await
        .unwrap();
    let ack_json: serde_json::Value = serde_json::from_slice(&ack_bytes).unwrap();
    assert_eq!(ack_json["accepted"], false);

    drop(sse_resp);
    let _ = server.shutdown_tx.send(());
}

#[tokio::test]
async fn test_single_target_tab_routing_ignores_non_target_ack() {
    let temp = tempfile::tempdir().unwrap();
    let server = start_server(
        temp.path().to_path_buf(),
        "test-repo".into(),
        "repo-multi-tab".into(),
        None,
        false,
    )
    .await
    .unwrap();

    let state = server.state.clone();
    let app = create_router(state.clone());

    // Connect older tab and newer tab
    let sse_old = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/events?client_id=tab_old")
                .header(header::HOST, format!("127.0.0.1:{}", server.port))
                .header("x-prebase-session", &server.session_token)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(sse_old.status(), StatusCode::OK);

    let sse_new = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/events?client_id=tab_new")
                .header(header::HOST, format!("127.0.0.1:{}", server.port))
                .header("x-prebase-session", &server.session_token)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(sse_new.status(), StatusCode::OK);
    assert_eq!(state.active_sse_client_count(), 2);

    let nav_app = app.clone();
    let nav_port = server.port;
    let nav_tok = server.session_token.clone();
    let nav_handle = tokio::spawn(async move {
        nav_app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/workspace/navigate")
                    .header(header::HOST, format!("127.0.0.1:{nav_port}"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .header("x-prebase-session", nav_tok)
                    .body(Body::from(r#"{"view":"3d","timeout_ms":2000}"#))
                    .unwrap(),
            )
            .await
            .unwrap()
    });

    let mut req_id = None;
    for _ in 0..40 {
        {
            let guard = state.pending_nav_acks.lock().unwrap();
            if let Some(k) = guard.keys().next() {
                req_id = Some(k.clone());
                break;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let req_id = req_id.expect("Expected pending navigation request_id");

    // Non-target tab_old attempting to ACK must be rejected (accepted: false)
    let old_ack_resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/workspace/ack")
                .header(header::HOST, format!("127.0.0.1:{}", server.port))
                .header(header::CONTENT_TYPE, "application/json")
                .header("x-prebase-session", &server.session_token)
                .body(Body::from(
                    serde_json::json!({
                        "request_id": req_id,
                        "client_id": "tab_old"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let old_ack_json: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(old_ack_resp.into_body(), 1024 * 64)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(old_ack_json["accepted"], false);

    // Target tab_new ACKs -> accepted: true and navigate resolves with client_id: "tab_new"
    let new_ack_resp = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/workspace/ack")
                .header(header::HOST, format!("127.0.0.1:{}", server.port))
                .header(header::CONTENT_TYPE, "application/json")
                .header("x-prebase-session", &server.session_token)
                .body(Body::from(
                    serde_json::json!({
                        "request_id": req_id,
                        "client_id": "tab_new"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let new_ack_json: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(new_ack_resp.into_body(), 1024 * 64)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(new_ack_json["accepted"], true);

    let nav_resp = nav_handle.await.unwrap();
    let nav_json: serde_json::Value = serde_json::from_slice(
        &axum::body::to_bytes(nav_resp.into_body(), 1024 * 64)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(nav_json["acknowledged"], true);
    assert_eq!(nav_json["client_id"], "tab_new");

    drop(sse_old);
    drop(sse_new);
    let _ = server.shutdown_tx.send(());
}

#[tokio::test]
async fn test_multi_slot_bootstrap_anonymous_sse_exclusion_and_server_shutdown() {
    let temp = tempfile::tempdir().unwrap();
    let server = start_server(
        temp.path().to_path_buf(),
        "test-repo".into(),
        "repo-sec".into(),
        None,
        false,
    )
    .await
    .unwrap();

    let state = server.state.clone();
    let app = create_router(state.clone());

    // 1. Multi-slot bootstrap: minting a second token does NOT invalidate the initial token
    let boot2 = state.mint_bootstrap_token();
    assert!(state
        .exchange_bootstrap_token(&server.bootstrap_token)
        .is_some());
    assert!(state.exchange_bootstrap_token(&boot2).is_some());
    // Single-use still enforced
    assert!(state.exchange_bootstrap_token(&boot2).is_none());

    // 2. Anonymous SSE connections are excluded from workspace client count and navigation
    let anon_sse = Request::builder()
        .uri("/api/v1/events")
        .header(header::HOST, format!("127.0.0.1:{}", server.port))
        .header("x-prebase-session", &server.session_token)
        .body(Body::empty())
        .unwrap();
    let _anon_resp = app.clone().oneshot(anon_sse).await.unwrap();
    assert_eq!(state.active_sse_client_count(), 0);
    assert!(state.most_recent_sse_client().is_none());

    // 3. /api/v1/server/identity & /api/v1/server/shutdown enforce X-Prebase-Session (403 on cookie)
    let cookie_id = Request::builder()
        .uri("/api/v1/server/identity")
        .header(header::HOST, format!("127.0.0.1:{}", server.port))
        .header(
            header::COOKIE,
            format!("prebase_session_{}={}", server.port, server.session_token),
        )
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        app.clone().oneshot(cookie_id).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );

    let cli_id = Request::builder()
        .uri("/api/v1/server/identity")
        .header(header::HOST, format!("127.0.0.1:{}", server.port))
        .header("x-prebase-session", &server.session_token)
        .body(Body::empty())
        .unwrap();
    let id_resp = app.clone().oneshot(cli_id).await.unwrap();
    assert_eq!(id_resp.status(), StatusCode::OK);
    let id_bytes = axum::body::to_bytes(id_resp.into_body(), 1024 * 64)
        .await
        .unwrap();
    let id_json: serde_json::Value = serde_json::from_slice(&id_bytes).unwrap();
    assert_eq!(id_json["repository_id"], "repo-sec");
    assert_eq!(id_json["pid"], std::process::id());

    let cli_shutdown = Request::builder()
        .method("POST")
        .uri("/api/v1/server/shutdown")
        .header(header::HOST, format!("127.0.0.1:{}", server.port))
        .header("x-prebase-session", &server.session_token)
        .body(Body::from("{}"))
        .unwrap();
    let shut_resp = app.clone().oneshot(cli_shutdown).await.unwrap();
    assert_eq!(shut_resp.status(), StatusCode::OK);
    assert!(state.is_shutting_down());
}
