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
        false,
    )
    .await
    .unwrap();

    let _ = server
        .state
        .publish_network(snapshot.clone(), result.index, vec![], None);

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

    // 9. Test Git status endpoint
    let git_resp = client
        .get(format!("{base_url}/api/v1/git/status"))
        .header("x-prebase-session", &server.session_token)
        .send()
        .await
        .unwrap();
    assert_eq!(git_resp.status(), 200);

    // 10. Test Static HTML serving
    let static_resp = client.get(format!("{base_url}/")).send().await.unwrap();
    assert_eq!(static_resp.status(), 200);
    let html = static_resp.text().await.unwrap();
    assert!(html.contains("PreBase"));

    // Clean shutdown
    let _ = server.shutdown_tx.send(());
}

#[tokio::test]
async fn test_polyglot_repo_analysis_and_server() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let fixture_dir = manifest_dir
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("tests/fixtures/polyglot-repo");

    assert!(fixture_dir.exists(), "Polyglot fixture dir must exist");

    // 1. Analyze polyglot repository
    let analyzer = RepositoryAnalyzer::default();
    let result = analyzer.analyze_path(&fixture_dir).unwrap();
    let snapshot = result.snapshot;

    // Verify language detection across languages
    let find_lang = |path: &str| -> Option<String> {
        snapshot
            .nodes
            .iter()
            .find(|n| n.relative_path == path)
            .map(|n| n.language.clone())
    };

    assert_eq!(
        find_lang("python_app/main.py").as_deref(),
        Some("python"),
        "python_app/main.py should be detected as python"
    );
    assert_eq!(
        find_lang("rust_crate/src/main.rs").as_deref(),
        Some("rust"),
        "rust_crate/src/main.rs should be detected as rust"
    );
    assert_eq!(
        find_lang("go_app/cmd/server/main.go").as_deref(),
        Some("go"),
        "go_app/cmd/server/main.go should be detected as go"
    );
    assert_eq!(
        find_lang("java_app/src/main/java/com/example/polyglot/App.java").as_deref(),
        Some("java"),
        "App.java should be detected as java"
    );
    assert_eq!(
        find_lang("native_app/src/main.c").as_deref(),
        Some("c"),
        "main.c should be detected as c"
    );
    assert_eq!(
        find_lang("native_app/src/engine.cpp").as_deref(),
        Some("cpp"),
        "engine.cpp should be detected as cpp"
    );
    assert_eq!(
        find_lang("ruby_app/app.rb").as_deref(),
        Some("ruby"),
        "app.rb should be detected as ruby"
    );
    assert_eq!(
        find_lang("php_app/index.php").as_deref(),
        Some("php"),
        "index.php should be detected as php"
    );
    assert_eq!(
        find_lang("web_app/src/index.ts").as_deref(),
        Some("typescript"),
        "index.ts should be detected as typescript"
    );

    // Verify internal edges resolved across polyglot project
    let has_edge = |src: &str, tgt: &str| {
        snapshot
            .edges
            .iter()
            .any(|e| e.source_file_id == src && e.target_file_id == tgt)
    };

    // Python relative imports
    assert!(
        has_edge("python_app/main.py", "python_app/utils.py"),
        "Missing python_app/main.py -> python_app/utils.py edge"
    );
    assert!(
        has_edge("python_app/main.py", "python_app/models/user.py"),
        "Missing python_app/main.py -> python_app/models/user.py edge"
    );

    // Rust module declarations & crate imports
    assert!(
        has_edge("rust_crate/src/main.rs", "rust_crate/src/config.rs"),
        "Missing rust main.rs -> config.rs edge"
    );
    assert!(
        has_edge("rust_crate/src/main.rs", "rust_crate/src/service.rs"),
        "Missing rust main.rs -> service.rs edge"
    );
    assert!(
        has_edge(
            "rust_crate/src/service.rs",
            "rust_crate/src/service/worker.rs"
        ),
        "Missing rust service.rs -> service/worker.rs edge"
    );

    // Go package-to-path resolution
    assert!(
        has_edge("go_app/cmd/server/main.go", "go_app/pkg/math/calc.go"),
        "Missing go main.go -> pkg/math/calc.go edge"
    );

    // Java package-to-path resolution
    assert!(
        has_edge(
            "java_app/src/main/java/com/example/polyglot/App.java",
            "java_app/src/main/java/com/example/polyglot/service/UserService.java"
        ),
        "Missing Java App.java -> UserService.java edge"
    );

    // C & C++ include resolution
    assert!(
        has_edge("native_app/src/main.c", "native_app/include/common.h"),
        "Missing C main.c -> include/common.h edge"
    );
    assert!(
        has_edge("native_app/src/engine.cpp", "native_app/include/common.h"),
        "Missing C++ engine.cpp -> include/common.h edge"
    );

    // Ruby require_relative
    assert!(
        has_edge("ruby_app/app.rb", "ruby_app/lib/helper.rb"),
        "Missing ruby app.rb -> lib/helper.rb edge"
    );

    // PHP require_once
    assert!(
        has_edge("php_app/index.php", "php_app/config.php"),
        "Missing php index.php -> config.php edge"
    );

    // TypeScript relative
    assert!(
        has_edge("web_app/src/index.ts", "web_app/src/utils.ts"),
        "Missing web_app index.ts -> utils.ts edge"
    );

    // Verify external dependencies are NOT internal edges
    assert!(
        !snapshot
            .edges
            .iter()
            .any(|e| e.target_file_id == "requests"),
        "External Python 'requests' must not be an internal edge"
    );
    assert!(
        !snapshot.edges.iter().any(|e| e.target_file_id == "fmt"),
        "External Go 'fmt' must not be an internal edge"
    );
    assert!(
        !snapshot.edges.iter().any(|e| e.target_file_id == "std"),
        "External Rust 'std' must not be an internal edge"
    );

    // 2. Start local server with polyglot repository
    let server = start_server(
        fixture_dir.clone(),
        "polyglot-repo".into(),
        "repo-polyglot".into(),
        None,
        false,
    )
    .await
    .unwrap();

    let _ = server
        .state
        .publish_network(snapshot.clone(), result.index, vec![], None);

    let client = reqwest::Client::new();
    let base_url = format!("http://127.0.0.1:{}", server.port);

    // 3. Test Health endpoint
    let health_resp = client
        .get(format!("{base_url}/api/v1/health"))
        .send()
        .await
        .unwrap();
    assert_eq!(health_resp.status(), 200);

    // 4. Test Repository Info endpoint
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

    // 6. Test File search for native C++ file
    let search_resp = client
        .get(format!("{base_url}/api/v1/files?q=engine.cpp"))
        .header("x-prebase-session", &server.session_token)
        .send()
        .await
        .unwrap();
    assert_eq!(search_resp.status(), 200);

    // Clean shutdown
    let _ = server.shutdown_tx.send(());
}
