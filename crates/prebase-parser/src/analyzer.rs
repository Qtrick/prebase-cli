use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;
use tracing::{debug, info, warn};

use prebase_core::graph::CanonicalGraph;
use prebase_core::index::GraphIndex;
use prebase_core::model::{
    AnalysisCoverage, AnalysisIssue, FileNode, GraphSnapshot, NodeAnalysisStatus, ResolutionStatus,
};
use prebase_core::scanner::{DiscoveredFile, RepositoryScanner, ScanOutput, ScannerConfig};

use crate::ast::SourceParser;
use crate::resolver::{ImportResolver, ResolvedTarget, RustCrateInfo, UnresolvedReasonKind};
use crate::tsconfig::TsConfig;

#[derive(Debug)]
pub struct AnalysisResult {
    pub snapshot: GraphSnapshot,
    pub index: GraphIndex,
    pub duration_ms: u128,
}

pub struct RepositoryAnalyzer {
    scanner_config: ScannerConfig,
}

impl Default for RepositoryAnalyzer {
    fn default() -> Self {
        Self::new(ScannerConfig::default())
    }
}

impl RepositoryAnalyzer {
    pub fn new(scanner_config: ScannerConfig) -> Self {
        Self { scanner_config }
    }

    pub fn analyze_path(&self, repo_path: &Path) -> Result<AnalysisResult, String> {
        self.analyze_path_cancellable(repo_path, || false)
    }

    pub fn analyze_path_cancellable<F: Fn() -> bool + Send + Sync>(
        &self,
        repo_path: &Path,
        is_cancelled: F,
    ) -> Result<AnalysisResult, String> {
        let start_time = Instant::now();
        if is_cancelled() {
            return Err("Analysis cancelled before starting".to_string());
        }

        let scanner = RepositoryScanner::new(repo_path, self.scanner_config.clone())
            .map_err(|e| format!("Failed to initialize repository scanner: {e}"))?;

        let repo_id = scanner.repository_id();
        let scan_output = scanner.scan_with_cancellation(&is_cancelled);
        if is_cancelled() {
            return Err("Analysis cancelled during scan".to_string());
        }

        info!(
            "Discovered {} candidate files in {} (excluded: {}, traversal errors: {})",
            scan_output.discovered.len(),
            repo_path.display(),
            scan_output.excluded_count,
            scan_output.traversal_errors.len(),
        );

        let result = self.analyze_discovered_internal(
            scanner.root(),
            &repo_id,
            scan_output,
            1, // Initial revision
            &is_cancelled,
        )?;

        let duration_ms = start_time.elapsed().as_millis();
        info!("Repository analysis completed in {duration_ms} ms");

        Ok(AnalysisResult {
            snapshot: result.0,
            index: result.1,
            duration_ms,
        })
    }

    pub fn analyze_discovered(
        &self,
        root: &Path,
        repository_id: &str,
        discovered_files: Vec<DiscoveredFile>,
        excluded_count: usize,
        revision: u64,
    ) -> Result<(GraphSnapshot, GraphIndex), String> {
        self.analyze_discovered_internal(
            root,
            repository_id,
            ScanOutput {
                discovered: discovered_files,
                excluded_count,
                traversal_errors: Vec::new(),
            },
            revision,
            &|| false,
        )
    }

    fn analyze_discovered_internal(
        &self,
        root: &Path,
        repository_id: &str,
        scan_output: ScanOutput,
        revision: u64,
        is_cancelled: &dyn Fn() -> bool,
    ) -> Result<(GraphSnapshot, GraphIndex), String> {
        let mut graph = CanonicalGraph::new();
        let discovered_files = scan_output.discovered;
        let excluded_count = scan_output.excluded_count;
        let traversal_errors = scan_output.traversal_errors;
        let mut known_files = HashSet::with_capacity(discovered_files.len());

        for file in &discovered_files {
            known_files.insert(file.relative_path.clone());
            graph.add_node(FileNode {
                id: file.relative_path.clone(),
                relative_path: file.relative_path.clone(),
                filename: file.filename.clone(),
                language: Self::infer_language(&file.extension),
                size_bytes: file.size_bytes,
                file_kind: file.file_kind,
                analysis_status: if file.is_supported_language {
                    NodeAnalysisStatus::Pending
                } else {
                    NodeAnalysisStatus::Unsupported
                },
                direct_dependency_count: 0,
                direct_dependent_count: 0,
            });
        }

        let mut configs = Vec::new();
        if let Some(root_cfg) = TsConfig::load_from_dir(root) {
            configs.push(root_cfg);
        }
        for file in &discovered_files {
            if file.filename == "tsconfig.json"
                && !file.relative_path.is_empty()
                && file.relative_path != "tsconfig.json"
            {
                if let Some(pkg_cfg) = TsConfig::load_from_file_in_repo(root, &file.relative_path) {
                    configs.push(pkg_cfg);
                }
            }
        }

        // Discover workspace package.json manifests and index package names to entry files
        let mut workspace_packages = std::collections::HashMap::new();
        for file in &discovered_files {
            if file.filename == "package.json" {
                if let Ok(content) =
                    prebase_core::safe_read_file_to_string(root, &file.relative_path, 256 * 1024)
                {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                        if let Some(pkg_name) = v.get("name").and_then(|n| n.as_str()) {
                            let pkg_dir = Path::new(&file.relative_path)
                                .parent()
                                .unwrap_or_else(|| Path::new(""));

                            let mut entry_candidate: Option<String> = None;
                            if let Some(main_val) = v.get("main").and_then(|m| m.as_str()) {
                                let target = pkg_dir.join(main_val.trim_start_matches("./"));
                                if let Some(norm) = ImportResolver::normalize_path(&target) {
                                    entry_candidate = Some(norm);
                                }
                            } else if let Some(types_val) = v.get("types").and_then(|t| t.as_str())
                            {
                                let target = pkg_dir.join(types_val.trim_start_matches("./"));
                                if let Some(norm) = ImportResolver::normalize_path(&target) {
                                    entry_candidate = Some(norm);
                                }
                            }

                            if entry_candidate.is_none() {
                                for candidate in &[
                                    "src/index.ts",
                                    "src/index.tsx",
                                    "src/index.js",
                                    "index.ts",
                                    "index.js",
                                ] {
                                    let target = pkg_dir.join(candidate);
                                    if let Some(norm) = ImportResolver::normalize_path(&target) {
                                        if known_files.contains(&norm) {
                                            entry_candidate = Some(norm);
                                            break;
                                        }
                                    }
                                }
                            }

                            if let Some(entry) = entry_candidate {
                                workspace_packages.insert(pkg_name.to_string(), entry);
                            }
                        }
                    }
                }
            }
        }

        // Discover Cargo.toml manifests and index Rust crate names and source directories
        let mut rust_crates = std::collections::HashMap::new();
        for file in &discovered_files {
            if file.filename == "Cargo.toml" {
                if let Ok(content) =
                    prebase_core::safe_read_file_to_string(root, &file.relative_path, 256 * 1024)
                {
                    if let Ok(toml_val) = toml::from_str::<toml::Value>(&content) {
                        let crate_dir = Path::new(&file.relative_path)
                            .parent()
                            .unwrap_or_else(|| Path::new(""))
                            .to_string_lossy()
                            .replace('\\', "/");

                        if let Some(pkg) = toml_val.get("package") {
                            if let Some(name) = pkg.get("name").and_then(|n| n.as_str()) {
                                let norm_name = name.replace('-', "_");
                                let src_dir = if crate_dir.is_empty() {
                                    "src".to_string()
                                } else {
                                    format!("{crate_dir}/src")
                                };

                                let lib_cand = format!("{src_dir}/lib.rs");
                                let lib_entry = if known_files.contains(&lib_cand) {
                                    Some(lib_cand)
                                } else {
                                    None
                                };

                                let main_cand = format!("{src_dir}/main.rs");
                                let main_entry = if known_files.contains(&main_cand) {
                                    Some(main_cand)
                                } else {
                                    None
                                };

                                rust_crates.insert(
                                    norm_name.clone(),
                                    RustCrateInfo {
                                        name: name.to_string(),
                                        normalized_name: norm_name,
                                        crate_dir,
                                        src_dir,
                                        lib_entry,
                                        main_entry,
                                    },
                                );
                            }
                        }
                    }
                }
            }
        }

        let resolver =
            ImportResolver::with_all(known_files, configs, workspace_packages, rust_crates);
        let mut parser = SourceParser::new();

        let analyzed_counter = AtomicUsize::new(0);
        let mut issues = Vec::new();

        for err_msg in traversal_errors {
            issues.push(AnalysisIssue {
                file_path: ".".to_string(),
                issue_kind: "TraversalError".to_string(),
                message: err_msg,
                line: None,
                column: None,
            });
        }

        for file in &discovered_files {
            if is_cancelled() {
                return Err("Analysis cancelled during AST parsing".to_string());
            }
            if !file.is_supported_language {
                continue;
            }

            let content = match prebase_core::safe_read_file_to_string(
                root,
                &file.relative_path,
                2 * 1024 * 1024,
            ) {
                Ok(c) => c,
                Err(e) => {
                    warn!("Could not read file {}: {e}", file.relative_path);
                    if let Some(node) = graph.get_node_mut(&file.relative_path) {
                        node.analysis_status = NodeAnalysisStatus::Failed;
                    }
                    issues.push(AnalysisIssue {
                        file_path: file.relative_path.clone(),
                        issue_kind: "FileReadError".to_string(),
                        message: format!("Failed to read file: {e}"),
                        line: None,
                        column: None,
                    });
                    continue;
                }
            };

            let (parsed_imports, has_syntax_errors) =
                match parser.parse_file_with_diagnostics(&file.extension, &content) {
                    Ok(res) => res,
                    Err(e) => {
                        warn!("Parser error in {}: {e}", file.relative_path);
                        if let Some(node) = graph.get_node_mut(&file.relative_path) {
                            node.analysis_status = NodeAnalysisStatus::Failed;
                        }
                        issues.push(AnalysisIssue {
                            file_path: file.relative_path.clone(),
                            issue_kind: "ParseError".to_string(),
                            message: e,
                            line: None,
                            column: None,
                        });
                        continue;
                    }
                };

            if has_syntax_errors {
                issues.push(AnalysisIssue {
                    file_path: file.relative_path.clone(),
                    issue_kind: "SyntaxWarning".to_string(),
                    message: "Source file contains syntax errors or unparseable tokens; partial AST analyzed".to_string(),
                    line: None,
                    column: None,
                });
                if let Some(node) = graph.get_node_mut(&file.relative_path) {
                    node.analysis_status = NodeAnalysisStatus::PartiallyAnalyzed;
                }
            } else if let Some(node) = graph.get_node_mut(&file.relative_path) {
                node.analysis_status = NodeAnalysisStatus::Analyzed;
            }
            analyzed_counter.fetch_add(1, Ordering::Relaxed);

            for imp in parsed_imports {
                let resolved = resolver.resolve(&file.relative_path, &imp.specifier);
                let evidence = prebase_core::model::DependencyEvidence {
                    source_file_id: file.relative_path.clone(),
                    import_specifier: imp.specifier.clone(),
                    line: imp.line,
                    column: imp.column,
                    relationship_kind: imp.relationship_kind,
                    is_type_only: imp.is_type_only,
                };

                match resolved {
                    ResolvedTarget::Internal(target_rel_path) => {
                        if !graph.has_node(&target_rel_path) {
                            issues.push(AnalysisIssue {
                                file_path: file.relative_path.clone(),
                                issue_kind: "UnresolvedInternalTarget".to_string(),
                                message: format!(
                                    "Import '{}' resolved to '{}', but target file is not indexed in repository",
                                    imp.specifier, target_rel_path
                                ),
                                line: Some(imp.line),
                                column: Some(imp.column),
                            });
                        } else {
                            graph.add_evidence_or_edge(
                                &file.relative_path,
                                &target_rel_path,
                                evidence,
                                imp.relationship_kind,
                                ResolutionStatus::ResolvedInternal,
                            );
                        }
                    }
                    ResolvedTarget::Unresolved(unresolved_kind, reason) => {
                        debug!("Unresolved import in {}: {reason}", file.relative_path);
                        let issue_kind = match unresolved_kind {
                            UnresolvedReasonKind::MissingInternalTarget
                            | UnresolvedReasonKind::MissingWorkspaceTarget
                            | UnresolvedReasonKind::MissingAliasTarget => {
                                "UnresolvedInternalTarget".to_string()
                            }
                            _ => "UnresolvedImport".to_string(),
                        };
                        issues.push(AnalysisIssue {
                            file_path: file.relative_path.clone(),
                            issue_kind,
                            message: reason,
                            line: Some(imp.line),
                            column: Some(imp.column),
                        });
                    }
                    ResolvedTarget::External(_) => {
                        // External package reference (e.g. "react"); not added to file-level internal graph
                    }
                    ResolvedTarget::Unsupported(reason) => {
                        issues.push(AnalysisIssue {
                            file_path: file.relative_path.clone(),
                            issue_kind: "UnsupportedImport".to_string(),
                            message: reason,
                            line: Some(imp.line),
                            column: Some(imp.column),
                        });
                    }
                }
            }
        }

        for issue in &issues {
            graph.add_issue(issue.clone());
        }

        let total_analyzed = analyzed_counter.load(Ordering::Relaxed);
        let supported_count = discovered_files
            .iter()
            .filter(|f| f.is_supported_language)
            .count();

        let coverage = AnalysisCoverage {
            total_discovered: discovered_files.len(),
            total_analyzed,
            total_excluded: excluded_count,
            total_issues: issues.len(),
            is_complete: issues.is_empty() && total_analyzed == supported_count,
        };

        let snapshot = graph.build_snapshot(repository_id, revision, coverage);
        let index = GraphIndex::build(&snapshot);

        Ok((snapshot, index))
    }

    fn infer_language(extension: &str) -> String {
        match extension {
            ".ts" | ".mts" | ".cts" => "typescript".to_string(),
            ".tsx" => "tsx".to_string(),
            ".js" | ".mjs" | ".cjs" => "javascript".to_string(),
            ".jsx" => "jsx".to_string(),
            ".rs" => "rust".to_string(),
            ".py" | ".pyi" => "python".to_string(),
            ".json" => "json".to_string(),
            ".toml" => "toml".to_string(),
            ".css" | ".scss" | ".less" => "css".to_string(),
            ".html" => "html".to_string(),
            ".md" | ".mdx" => "markdown".to_string(),
            _ => "other".to_string(),
        }
    }
}
