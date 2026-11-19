use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use prebase_core::model::{NodeAnalysisStatus, ResolutionStatus};
use prebase_parser::resolver::{ImportResolver, ResolvedTarget, RustCrateInfo};
use prebase_parser::RepositoryAnalyzer;

// ============================================================================
// 1. Rust Import & Module Resolution Unit Tests
// ============================================================================

#[test]
fn test_rust_internal_module_resolution() {
    let mut known_files = HashSet::new();
    known_files.insert("src/main.rs".to_string());
    known_files.insert("src/foo.rs".to_string());
    known_files.insert("src/foo/bar.rs".to_string());
    known_files.insert("src/foo/sub.rs".to_string());
    known_files.insert("src/baz/mod.rs".to_string());

    let mut rust_crates = HashMap::new();
    rust_crates.insert(
        "my_crate".to_string(),
        RustCrateInfo {
            name: "my_crate".to_string(),
            normalized_name: "my_crate".to_string(),
            crate_dir: "".to_string(),
            src_dir: "src".to_string(),
            lib_entry: None,
            main_entry: Some("src/main.rs".to_string()),
        },
    );

    let resolver = ImportResolver::with_all(known_files, Vec::new(), HashMap::new(), rust_crates);

    // 1. mod foo; in src/main.rs -> src/foo.rs
    let res = resolver.resolve("src/main.rs", "mod:foo");
    assert_eq!(
        res,
        ResolvedTarget::Internal("src/foo.rs".to_string()),
        "mod foo in src/main.rs must resolve to src/foo.rs"
    );

    // 2. mod baz; in src/main.rs -> src/baz/mod.rs
    let res = resolver.resolve("src/main.rs", "mod:baz");
    assert_eq!(
        res,
        ResolvedTarget::Internal("src/baz/mod.rs".to_string()),
        "mod baz in src/main.rs must resolve to src/baz/mod.rs"
    );

    // 3. mod bar; in src/foo.rs -> src/foo/bar.rs
    let res = resolver.resolve("src/foo.rs", "mod:bar");
    assert_eq!(
        res,
        ResolvedTarget::Internal("src/foo/bar.rs".to_string()),
        "mod bar in src/foo.rs must resolve to src/foo/bar.rs"
    );

    // 4. use crate::foo::bar in src/main.rs -> src/foo/bar.rs
    let res = resolver.resolve("src/main.rs", "crate::foo::bar");
    assert_eq!(
        res,
        ResolvedTarget::Internal("src/foo/bar.rs".to_string()),
        "use crate::foo::bar in src/main.rs must resolve to src/foo/bar.rs"
    );

    // 5. use self::sub in src/foo.rs -> src/foo/sub.rs
    let res = resolver.resolve("src/foo.rs", "self::sub");
    assert_eq!(
        res,
        ResolvedTarget::Internal("src/foo/sub.rs".to_string()),
        "use self::sub in src/foo.rs must resolve to src/foo/sub.rs"
    );

    // 6. use super::sub in src/foo/bar.rs -> src/foo/sub.rs
    let res = resolver.resolve("src/foo/bar.rs", "super::sub");
    assert_eq!(
        res,
        ResolvedTarget::Internal("src/foo/sub.rs".to_string()),
        "use super::sub in src/foo/bar.rs must resolve to src/foo/sub.rs"
    );
}

#[test]
fn test_rust_workspace_crate_cross_resolution() {
    let mut known_files = HashSet::new();
    known_files.insert("crates/core/src/lib.rs".to_string());
    known_files.insert("crates/core/src/model.rs".to_string());
    known_files.insert("crates/cli/src/main.rs".to_string());

    let mut rust_crates = HashMap::new();
    rust_crates.insert(
        "my_core".to_string(),
        RustCrateInfo {
            name: "my-core".to_string(),
            normalized_name: "my_core".to_string(),
            crate_dir: "crates/core".to_string(),
            src_dir: "crates/core/src".to_string(),
            lib_entry: Some("crates/core/src/lib.rs".to_string()),
            main_entry: None,
        },
    );
    rust_crates.insert(
        "my_cli".to_string(),
        RustCrateInfo {
            name: "my-cli".to_string(),
            normalized_name: "my_cli".to_string(),
            crate_dir: "crates/cli".to_string(),
            src_dir: "crates/cli/src".to_string(),
            lib_entry: None,
            main_entry: Some("crates/cli/src/main.rs".to_string()),
        },
    );

    let resolver = ImportResolver::with_all(known_files, Vec::new(), HashMap::new(), rust_crates);

    // 1. my_cli importing my_core::model -> crates/core/src/model.rs
    let res = resolver.resolve("crates/cli/src/main.rs", "my_core::model");
    assert_eq!(
        res,
        ResolvedTarget::Internal("crates/core/src/model.rs".to_string()),
        "my_cli importing my_core::model must resolve to crates/core/src/model.rs"
    );

    // 2. my_cli importing my_core root -> crates/core/src/lib.rs
    let res = resolver.resolve("crates/cli/src/main.rs", "my_core");
    assert_eq!(
        res,
        ResolvedTarget::Internal("crates/core/src/lib.rs".to_string()),
        "my_cli importing my_core must resolve to crates/core/src/lib.rs"
    );
}

#[test]
fn test_rust_stdlib_and_external_crates() {
    let known_files = HashSet::new();
    let resolver =
        ImportResolver::with_all(known_files, Vec::new(), HashMap::new(), HashMap::new());

    // stdlib
    assert_eq!(
        resolver.resolve("src/main.rs", "std::collections::HashMap"),
        ResolvedTarget::External("std".to_string())
    );
    assert_eq!(
        resolver.resolve("src/main.rs", "core::fmt::Debug"),
        ResolvedTarget::External("core".to_string())
    );
    assert_eq!(
        resolver.resolve("src/main.rs", "alloc::vec::Vec"),
        ResolvedTarget::External("alloc".to_string())
    );

    // external third-party crates
    assert_eq!(
        resolver.resolve("src/main.rs", "serde::Serialize"),
        ResolvedTarget::External("serde".to_string())
    );
    assert_eq!(
        resolver.resolve("src/main.rs", "tokio::sync::mpsc"),
        ResolvedTarget::External("tokio".to_string())
    );
}

// ============================================================================
// 2. Python Import Resolution Unit Tests
// ============================================================================

#[test]
fn test_python_relative_and_package_resolution() {
    let mut known_files = HashSet::new();
    known_files.insert("pkg/__init__.py".to_string());
    known_files.insert("pkg/models.py".to_string());
    known_files.insert("pkg/services.py".to_string());
    known_files.insert("pkg/sub/__init__.py".to_string());
    known_files.insert("pkg/sub/worker.py".to_string());
    known_files.insert("main.py".to_string());
    known_files.insert("utils.py".to_string());

    let resolver =
        ImportResolver::with_all(known_files, Vec::new(), HashMap::new(), HashMap::new());

    // 1. from .models import User in pkg/services.py
    let res = resolver.resolve("pkg/services.py", ".models:User");
    assert_eq!(
        res,
        ResolvedTarget::Internal("pkg/models.py".to_string()),
        "from .models import User in pkg/services.py must resolve to pkg/models.py"
    );

    // 2. from . import models in pkg/services.py
    let res = resolver.resolve("pkg/services.py", ".:models");
    assert_eq!(
        res,
        ResolvedTarget::Internal("pkg/models.py".to_string()),
        "from . import models in pkg/services.py must resolve to pkg/models.py"
    );

    // 3. from ..models import User in pkg/sub/worker.py
    let res = resolver.resolve("pkg/sub/worker.py", "..models:User");
    assert_eq!(
        res,
        ResolvedTarget::Internal("pkg/models.py".to_string()),
        "from ..models import User in pkg/sub/worker.py must resolve to pkg/models.py"
    );

    // 4. import utils in main.py
    let res = resolver.resolve("main.py", "utils");
    assert_eq!(
        res,
        ResolvedTarget::Internal("utils.py".to_string()),
        "import utils in main.py must resolve to utils.py"
    );

    // 5. from pkg import models in main.py
    let res = resolver.resolve("main.py", "pkg:models");
    assert_eq!(
        res,
        ResolvedTarget::Internal("pkg/models.py".to_string()),
        "from pkg import models in main.py must resolve to pkg/models.py"
    );
}

#[test]
fn test_python_stdlib_and_external_packages() {
    let known_files = HashSet::new();
    let resolver =
        ImportResolver::with_all(known_files, Vec::new(), HashMap::new(), HashMap::new());

    // Python standard library
    assert_eq!(
        resolver.resolve("app/main.py", "sys"),
        ResolvedTarget::External("sys".to_string())
    );
    assert_eq!(
        resolver.resolve("app/main.py", "os.path"),
        ResolvedTarget::External("os".to_string())
    );
    assert_eq!(
        resolver.resolve("app/main.py", "typing:List"),
        ResolvedTarget::External("typing".to_string())
    );
    assert_eq!(
        resolver.resolve("app/main.py", "asyncio"),
        ResolvedTarget::External("asyncio".to_string())
    );

    // Third-party packages
    assert_eq!(
        resolver.resolve("app/main.py", "fastapi:FastAPI"),
        ResolvedTarget::External("fastapi".to_string())
    );
    assert_eq!(
        resolver.resolve("app/main.py", "pydantic:BaseModel"),
        ResolvedTarget::External("pydantic".to_string())
    );
    assert_eq!(
        resolver.resolve("app/main.py", "requests"),
        ResolvedTarget::External("requests".to_string())
    );
}

// ============================================================================
// 3. Mixed-Language Disk Fixture End-to-End Test
// ============================================================================

#[test]
fn test_mixed_language_disk_fixture_e2e() {
    let temp_dir = tempfile::tempdir().expect("Failed to create tempdir");
    let root = temp_dir.path();

    // 1. TypeScript project
    fs::create_dir_all(root.join("ts_app/src")).unwrap();
    fs::write(
        root.join("ts_app/package.json"),
        r#"{"name": "ts-app", "version": "1.0.0"}"#,
    )
    .unwrap();
    fs::write(
        root.join("ts_app/tsconfig.json"),
        r#"{"compilerOptions": {"baseUrl": ".", "paths": {"@/*": ["src/*"]}}}"#,
    )
    .unwrap();
    fs::write(
        root.join("ts_app/src/helper.ts"),
        "export function add(a: number, b: number): number { return a + b; }\n",
    )
    .unwrap();
    fs::write(
        root.join("ts_app/src/index.ts"),
        "import { add } from './helper';\nconsole.log(add(1, 2));\n",
    )
    .unwrap();

    // 2. Rust workspace project
    fs::create_dir_all(root.join("rust_app/crates/core/src")).unwrap();
    fs::create_dir_all(root.join("rust_app/crates/cli/src")).unwrap();
    fs::write(
        root.join("rust_app/Cargo.toml"),
        r#"[workspace]
members = ["crates/core", "crates/cli"]
"#,
    )
    .unwrap();
    fs::write(
        root.join("rust_app/crates/core/Cargo.toml"),
        r#"[package]
name = "rust-core"
version = "0.1.0"
edition = "2021"
"#,
    )
    .unwrap();
    fs::write(
        root.join("rust_app/crates/core/src/model.rs"),
        "pub struct Config { pub port: u16 }\n",
    )
    .unwrap();
    fs::write(
        root.join("rust_app/crates/core/src/lib.rs"),
        "pub mod model;\npub use model::Config;\n",
    )
    .unwrap();
    fs::write(
        root.join("rust_app/crates/cli/Cargo.toml"),
        r#"[package]
name = "rust-cli"
version = "0.1.0"
edition = "2021"
[dependencies]
rust-core = { path = "../core" }
"#,
    )
    .unwrap();
    fs::write(
        root.join("rust_app/crates/cli/src/main.rs"),
        "use rust_core::Config;\nfn main() { let _c = Config { port: 8080 }; }\n",
    )
    .unwrap();

    // 3. Python project
    fs::create_dir_all(root.join("py_app/src/pkg")).unwrap();
    fs::write(
        root.join("py_app/pyproject.toml"),
        r#"[project]
name = "py-app"
version = "0.1.0"
"#,
    )
    .unwrap();
    fs::write(root.join("py_app/src/pkg/__init__.py"), "# pkg root\n").unwrap();
    fs::write(
        root.join("py_app/src/pkg/utils.py"),
        "def greet(name: str) -> str:\n    return f'Hello {name}'\n",
    )
    .unwrap();
    fs::write(
        root.join("py_app/src/pkg/main.py"),
        "from .utils import greet\n\ndef run():\n    print(greet('world'))\n",
    )
    .unwrap();

    // Run analyzer
    let analyzer = RepositoryAnalyzer::default();
    let res = analyzer
        .analyze_path(root)
        .expect("Repository analysis failed");
    let snapshot = res.snapshot;

    // Verify nodes
    let node_map: HashMap<&str, &prebase_core::model::FileNode> = snapshot
        .nodes
        .iter()
        .map(|n| (n.relative_path.as_str(), n))
        .collect();

    // Assert language tagging
    let ts_index = node_map
        .get("ts_app/src/index.ts")
        .expect("ts index exists");
    assert_eq!(ts_index.language, "typescript");
    assert_eq!(ts_index.analysis_status, NodeAnalysisStatus::Analyzed);

    let rs_cli = node_map
        .get("rust_app/crates/cli/src/main.rs")
        .expect("rs cli exists");
    assert_eq!(rs_cli.language, "rust");
    assert_eq!(rs_cli.analysis_status, NodeAnalysisStatus::Analyzed);

    let rs_core_lib = node_map
        .get("rust_app/crates/core/src/lib.rs")
        .expect("rs core lib exists");
    assert_eq!(rs_core_lib.language, "rust");
    assert_eq!(rs_core_lib.analysis_status, NodeAnalysisStatus::Analyzed);

    let rs_core_model = node_map
        .get("rust_app/crates/core/src/model.rs")
        .expect("rs core model exists");
    assert_eq!(rs_core_model.language, "rust");
    assert_eq!(rs_core_model.analysis_status, NodeAnalysisStatus::Analyzed);

    let py_main = node_map
        .get("py_app/src/pkg/main.py")
        .expect("py main exists");
    assert_eq!(py_main.language, "python");
    assert_eq!(py_main.analysis_status, NodeAnalysisStatus::Analyzed);

    let py_utils = node_map
        .get("py_app/src/pkg/utils.py")
        .expect("py utils exists");
    assert_eq!(py_utils.language, "python");
    assert_eq!(py_utils.analysis_status, NodeAnalysisStatus::Analyzed);

    // Verify edges
    let internal_edges: Vec<_> = snapshot
        .edges
        .iter()
        .filter(|e| e.resolution_status == ResolutionStatus::ResolvedInternal)
        .collect();

    // TypeScript edge: index.ts -> helper.ts
    assert!(
        internal_edges.iter().any(|e| {
            e.source_file_id == "ts_app/src/index.ts" && e.target_file_id == "ts_app/src/helper.ts"
        }),
        "TypeScript edge ts_app/src/index.ts -> ts_app/src/helper.ts must exist"
    );

    // Rust edge: core/src/lib.rs -> core/src/model.rs (from mod model;)
    assert!(
        internal_edges.iter().any(|e| {
            e.source_file_id == "rust_app/crates/core/src/lib.rs"
                && e.target_file_id == "rust_app/crates/core/src/model.rs"
        }),
        "Rust edge rust_app/crates/core/src/lib.rs -> rust_app/crates/core/src/model.rs must exist"
    );

    // Rust edge: cli/src/main.rs -> core/src/lib.rs or model.rs (from use rust_core::Config;)
    assert!(
        internal_edges.iter().any(|e| {
            e.source_file_id == "rust_app/crates/cli/src/main.rs"
                && (e.target_file_id == "rust_app/crates/core/src/lib.rs"
                    || e.target_file_id == "rust_app/crates/core/src/model.rs")
        }),
        "Rust cross-crate edge rust_app/crates/cli/src/main.rs -> rust_app/crates/core must exist"
    );

    // Python edge: main.py -> utils.py (from from .utils import greet)
    assert!(
        internal_edges.iter().any(|e| {
            e.source_file_id == "py_app/src/pkg/main.py"
                && e.target_file_id == "py_app/src/pkg/utils.py"
        }),
        "Python edge py_app/src/pkg/main.py -> py_app/src/pkg/utils.py must exist"
    );
}

// ============================================================================
// 4. PreBase Repository Self-Analysis Test
// ============================================================================

#[test]
fn test_prebase_self_analysis_cross_crate_edges() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let repo_root = Path::new(manifest_dir)
        .parent()
        .and_then(|p| p.parent())
        .expect("Failed to find repo root");

    let analyzer = RepositoryAnalyzer::default();
    let res = analyzer
        .analyze_path(repo_root)
        .expect("Self analysis failed");
    let snapshot = res.snapshot;

    // Coverage must report analyzed files
    assert!(
        snapshot.coverage.total_discovered > 50,
        "Should discover >50 files"
    );
    assert!(
        snapshot.coverage.total_analyzed > 30,
        "Should analyze >30 files"
    );
    if !snapshot.issues.is_empty() {
        println!("Self-analysis issues ({}):", snapshot.issues.len());
        for iss in &snapshot.issues {
            println!(
                "  [{}]: {} - {}",
                iss.issue_kind, iss.file_path, iss.message
            );
        }
    }

    // Assert nodes exist for Rust crates
    let node_paths: HashSet<&str> = snapshot
        .nodes
        .iter()
        .map(|n| n.relative_path.as_str())
        .collect();

    assert!(
        node_paths.contains("crates/prebase-cli/src/main.rs"),
        "Must contain prebase-cli/src/main.rs"
    );
    assert!(
        node_paths.contains("crates/prebase-core/src/lib.rs"),
        "Must contain prebase-core/src/lib.rs"
    );
    assert!(
        node_paths.contains("crates/prebase-parser/src/lib.rs"),
        "Must contain prebase-parser/src/lib.rs"
    );
    assert!(
        node_paths.contains("crates/prebase-server/src/lib.rs"),
        "Must contain prebase-server/src/lib.rs"
    );
    assert!(
        node_paths.contains("crates/prebase-git/src/lib.rs"),
        "Must contain prebase-git/src/lib.rs"
    );

    // Assert internal edges exist between Rust crates in PreBase
    let internal_edges: Vec<_> = snapshot
        .edges
        .iter()
        .filter(|e| e.resolution_status == ResolutionStatus::ResolvedInternal)
        .collect();

    // Check that prebase-cli connects to other prebase crates
    let cli_targets: HashSet<&str> = internal_edges
        .iter()
        .filter(|e| e.source_file_id.starts_with("crates/prebase-cli"))
        .map(|e| e.target_file_id.as_str())
        .collect();

    assert!(
        cli_targets.iter().any(|t| t.starts_with("crates/prebase-")),
        "prebase-cli should have internal dependency edges to other prebase crates, found: {cli_targets:?}"
    );

    // Check that prebase-parser connects to prebase-core
    let parser_targets: HashSet<&str> = internal_edges
        .iter()
        .filter(|e| e.source_file_id.starts_with("crates/prebase-parser"))
        .map(|e| e.target_file_id.as_str())
        .collect();

    assert!(
        parser_targets.iter().any(|t| t.starts_with("crates/prebase-core")),
        "prebase-parser should have internal dependency edges to prebase-core, found: {parser_targets:?}"
    );

    // Check insights computation
    let insights = snapshot.insights.expect("Snapshot should include insights");
    assert!(
        !insights.area_couplings.is_empty(),
        "Insights must include area couplings"
    );
    assert!(
        !insights.highly_depended_files.is_empty(),
        "Insights must identify highly depended files"
    );
}
