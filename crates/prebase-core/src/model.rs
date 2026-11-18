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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum WatcherHealth {
    Active,
    Degraded,
    #[default]
    Disabled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepositoryInfo {
    pub repository_id: String,
    pub repository_root_display: String,
    pub repository_name: String,
    pub analysis_revision: u64,
    pub indexing_status: IndexingStatus,
    pub watcher_health: WatcherHealth,
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
    PartiallyAnalyzed,
    Excluded,
    Failed,
    Unsupported,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub insights: Option<ArchitecturalInsights>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CycleGroup {
    pub id: String,
    pub files: Vec<String>,
    pub example_cycle: Vec<String>,
    pub is_type_only: bool,
    pub edge_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HighlyDependedFile {
    pub file_id: String,
    pub relative_path: String,
    pub dependent_count: usize,
    pub dependency_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConnectedArea {
    pub area_id: String,
    pub outbound_count: usize,
    pub inbound_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AreaCoupling {
    pub area_id: String,
    pub file_count: usize,
    pub analyzed_file_count: usize,
    pub internal_edge_count: usize,
    pub outbound_edge_count: usize,
    pub inbound_edge_count: usize,
    pub connected_areas: Vec<ConnectedArea>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiagnosticsSummary {
    pub total_discovered: usize,
    pub total_analyzed: usize,
    pub total_partially_analyzed: usize,
    pub total_unsupported: usize,
    pub total_failed: usize,
    pub total_unresolved_imports: usize,
    pub total_issues: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArchitecturalInsights {
    pub cycle_groups: Vec<CycleGroup>,
    pub total_cycle_files: usize,
    pub highly_depended_files: Vec<HighlyDependedFile>,
    pub area_couplings: Vec<AreaCoupling>,
    pub diagnostics_summary: DiagnosticsSummary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImpactItem {
    pub file_id: String,
    pub relative_path: String,
    pub depth: usize,
    pub is_type_only: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileImpactAnalysis {
    pub file_id: String,
    pub direct_dependents_count: usize,
    pub transitive_dependents_count: usize,
    pub total_impact_count: usize,
    pub is_part_of_cycle: bool,
    pub cycle_group_id: Option<String>,
    pub impacted_files: Vec<ImpactItem>,
}
