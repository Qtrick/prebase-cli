use std::collections::HashSet;
use std::fs;
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
use crate::resolver::{ImportResolver, ResolvedTarget};
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

        let tsconfig = TsConfig::load_from_dir(root);
        let resolver = ImportResolver::new(known_files, tsconfig);
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

            let content = match fs::read_to_string(&file.absolute_path) {
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

            let parsed_imports = match parser.parse_file(&file.extension, &content) {
                Ok(imps) => imps,
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

            if let Some(node) = graph.get_node_mut(&file.relative_path) {
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
                        graph.add_evidence_or_edge(
                            &file.relative_path,
                            &target_rel_path,
                            evidence,
                            imp.relationship_kind,
                            ResolutionStatus::ResolvedInternal,
                        );
                    }
                    ResolvedTarget::Unresolved(reason) => {
                        debug!("Unresolved import in {}: {reason}", file.relative_path);
                        issues.push(AnalysisIssue {
                            file_path: file.relative_path.clone(),
                            issue_kind: "UnresolvedImport".to_string(),
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
            ".json" => "json".to_string(),
            ".css" | ".scss" | ".less" => "css".to_string(),
            ".html" => "html".to_string(),
            ".md" | ".mdx" => "markdown".to_string(),
            _ => "other".to_string(),
        }
    }
}
