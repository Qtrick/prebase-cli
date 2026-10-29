use serde::{Deserialize, Serialize};

pub const CURRENT_SCHEMA_VERSION: &str = "1.0.0";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum IndexingStatus {
    NotStarted,
    Scanning,
    Parsing,
    Resolving,
    Ready,
    Partial,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepositoryInfo {
    pub repository_id: String,
    pub repository_root_display: String,
    pub repository_name: String,
    pub analysis_revision: u64,
    pub indexing_status: IndexingStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FileKind {
    Source,
    Test,
    Config,
    Doc,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum NodeAnalysisStatus {
    Pending,
    Analyzed,
    Excluded,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileNode {
    pub id: String,
    pub relative_path: String,
    pub filename: String,
    pub language: String,
    pub size_bytes: u64,
    pub file_kind: FileKind,
    pub analysis_status: NodeAnalysisStatus,
    pub direct_dependency_count: usize,
    pub direct_dependent_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RelationshipKind {
    Import,
    Export,
    DynamicImport,
    TypeOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ResolutionStatus {
    ResolvedInternal,
    ExternalPackage,
    Unresolved,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DependencyEvidence {
    pub source_file_id: String,
    pub import_specifier: String,
    pub line: usize,
    pub column: usize,
    pub relationship_kind: RelationshipKind,
    pub is_type_only: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DependencyEdge {
    pub id: String,
    pub source_file_id: String,
    pub target_file_id: String,
    pub relationship_kind: RelationshipKind,
    pub resolution_status: ResolutionStatus,
    pub evidence: Vec<DependencyEvidence>,
}

impl DependencyEdge {
    pub fn make_edge_id(source: &str, target: &str) -> String {
        format!("{source}->{target}")
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AnalysisCoverage {
    pub total_discovered: usize,
    pub total_analyzed: usize,
    pub total_excluded: usize,
    pub total_issues: usize,
    pub is_complete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AnalysisIssue {
    pub file_path: String,
    pub issue_kind: String,
    pub message: String,
    pub line: Option<usize>,
    pub column: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphSnapshot {
    pub schema_version: String,
    pub repository_id: String,
    pub revision: u64,
    pub nodes: Vec<FileNode>,
    pub edges: Vec<DependencyEdge>,
    pub coverage: AnalysisCoverage,
    pub issues: Vec<AnalysisIssue>,
}

