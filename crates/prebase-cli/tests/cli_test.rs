use prebase_parser::RepositoryAnalyzer;
use prebase_server::start_server;
use std::path::PathBuf;

#[tokio::test]
async fn test_sample_monorepo_analysis_and_server() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let fixture_dir = manifest_dir
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("tests/fixtures/sample-monorepo");

    assert!(fixture_dir.exists(), "Fixture dir must exist");

    // 1. Analyze fixture repository
    let analyzer = RepositoryAnalyzer::default();
    let result = analyzer.analyze_path(&fixture_dir).unwrap();
    let snapshot = result.snapshot;

    // Check excluded files: .env and node_modules must NOT be nodes
    for node in &snapshot.nodes {
        assert!(
            !node.relative_path.contains(".env"),
            "Found .env in nodes: {}",
            node.relative_path
        );
        assert!(
            !node.relative_path.contains("node_modules"),
            "Found node_modules in nodes: {}",
            node.relative_path
        );
    }

    // Verify key nodes exist
    assert!(snapshot
        .nodes
        .iter()
        .any(|n| n.relative_path == "src/index.ts"));
    assert!(snapshot
        .nodes
        .iter()
        .any(|n| n.relative_path == "src/components/Header.tsx"));
    assert!(snapshot
        .nodes
        .iter()
        .any(|n| n.relative_path == "src/components/Button.tsx"));
    assert!(snapshot
        .nodes
        .iter()
        .any(|n| n.relative_path == "src/components/Card/index.ts"));
    assert!(snapshot
        .nodes
        .iter()
        .any(|n| n.relative_path == "src/utils/math.ts"));
    assert!(snapshot
        .nodes
        .iter()
        .any(|n| n.relative_path == "src/features/dashboard with spaces.ts"));
    assert!(snapshot
        .nodes
        .iter()
        .any(|n| n.relative_path == "src/features/unicode_🌟.ts"));

    // Verify edges and relationships
    let has_edge = |src: &str, tgt: &str| {
        snapshot
            .edges
            .iter()
            .any(|e| e.source_file_id == src && e.target_file_id == tgt)
    };

    assert!(
        has_edge("src/index.ts", "src/components/Header.tsx"),
        "Missing index -> Header edge"
    );
    assert!(
        has_edge("src/index.ts", "src/components/Card/index.ts"),
        "Missing index -> Card/index edge"
    );
    assert!(
        has_edge("src/index.ts", "src/utils/math.ts"),
        "Missing path alias @/utils/math edge"
    );
    assert!(
        has_edge("src/index.ts", "src/types.ts"),
        "Missing index -> types edge"
    );
    assert!(
        has_edge("src/components/Header.tsx", "src/components/Button.tsx"),
        "Missing Header -> Button edge"
    );
    assert!(
        has_edge("src/features/dashboard with spaces.ts", "src/utils/math.ts"),
        "Missing dashboard with spaces -> math edge"
    );
    assert!(
        has_edge("src/features/unicode_🌟.ts", "src/components/Button.tsx"),
        "Missing unicode -> Button edge"
    );

    // External package "react" must NOT be an internal edge
    assert!(
        !snapshot
            .edges
            .iter()
            .any(|e| e.target_file_id.contains("react")),
        "Fabricated react edge"
    );

    // 2. Start local server with fixture repository
    let server = start_server(
        fixture_dir.clone(),
        "sample-monorepo".into(),
        "repo-sample".into(),
        None,
    )
    .await
    .unwrap();

    server.state.set_ready(snapshot.clone(), result.index);

    let client = reqwest::Client::new();
    let base_url = format!("http://127.0.0.1:{}", server.port);

    // 3. Test Health endpoint
    let health_resp = client
        .get(format!("{base_url}/api/v1/health"))
        .send()
        .await
        .unwrap();
    assert_eq!(health_resp.status(), 200);

    // 4. Test Repository Info endpoint with session token
    let repo_resp = client
        .get(format!("{base_url}/api/v1/repository"))
        .header("x-prebase-session", &server.session_token)
        .send()
        .await
        .unwrap();
    assert_eq!(repo_resp.status(), 200);

    // 5. Test Network Snapshot endpoint
    let net_resp = client
        .get(format!("{base_url}/api/v1/network"))
        .header("x-prebase-session", &server.session_token)
        .send()
        .await
        .unwrap();
    assert_eq!(net_resp.status(), 200);

    // 6. Test File search
    let search_resp = client
        .get(format!("{base_url}/api/v1/files?q=Header"))
        .header("x-prebase-session", &server.session_token)
        .send()
        .await
        .unwrap();
    assert_eq!(search_resp.status(), 200);

    // 7. Test Inspect File
    let inspect_resp = client
        .get(format!("{base_url}/api/v1/files/src/components/Header.tsx"))
        .header("x-prebase-session", &server.session_token)
        .send()
        .await
        .unwrap();
    assert_eq!(inspect_resp.status(), 200);

    // 8. Test Inspect Edge
    let edge_resp = client
        .get(format!(
            "{base_url}/api/v1/edges/src/index.ts->src/components/Header.tsx"
        ))
        .header("x-prebase-session", &server.session_token)
        .send()
        .await
        .unwrap();
    assert_eq!(edge_resp.status(), 200);

    // 9. Test Static HTML serving
    let static_resp = client.get(format!("{base_url}/")).send().await.unwrap();
    assert_eq!(static_resp.status(), 200);
    let html = static_resp.text().await.unwrap();
    assert!(html.contains("PreBase"));

    // Clean shutdown
    let _ = server.shutdown_tx.send(());
}
