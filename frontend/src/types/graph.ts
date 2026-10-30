export type NodeKind = 'Source' | 'Test' | 'Config' | 'Doc' | 'Other';
export type NodeAnalysisStatus =
  | 'Pending'
  | 'Recognized'
  | 'Parsed'
  | 'Analyzed'
  | 'PartiallyAnalyzed'
  | 'Unsupported'
  | 'Excluded'
  | 'Failed';

export interface FileNode {
  id: string;
  relative_path: string;
  filename: string;
  language: string;
  size_bytes: number;
  file_kind: NodeKind;
  analysis_status: NodeAnalysisStatus;
  direct_dependency_count: number;
  direct_dependent_count: number;
}

export type RelationshipKind =
  | 'Import'
  | 'Export'
  | 'DynamicImport'
  | 'TypeOnly'
  | 'Include'
  | 'ModuleDeclaration'
  | 'Require'
  | 'PackageImport'
  | 'ProjectReference';
export type ResolutionStatus = 'ResolvedInternal' | 'ExternalPackage' | 'Unresolved' | 'Unsupported';

export interface DependencyEvidence {
  source_file_id: string;
  import_specifier: string;
  line: number;
  column: number;
  relationship_kind: RelationshipKind;
  is_type_only: boolean;
}

export interface DependencyEdge {
  id: string;
  source_file_id: string;
  target_file_id: string;
  relationship_kind: RelationshipKind;
  resolution_status: ResolutionStatus;
  evidence: DependencyEvidence[];
}

export interface AnalysisCoverage {
  total_discovered: number;
  total_analyzed: number;
  total_excluded: number;
  total_issues: number;
  is_complete: boolean;
}

export interface AnalysisIssue {
  file_path: string;
  issue_kind: string;
  message: string;
  line?: number | null;
  column?: number | null;
}

export interface GraphSnapshot {
  schema_version: string;
  repository_id: string;
  revision: number;
  nodes: FileNode[];
  edges: DependencyEdge[];
  coverage: AnalysisCoverage;
  issues: AnalysisIssue[];
}

export type WatcherHealth = 'active' | 'degraded' | 'disabled';

export interface RepositoryInfo {
  repository_id: string;
  repository_root_display: string;
  repository_name: string;
  analysis_revision: number;
  indexing_status: 'NotStarted' | 'Scanning' | 'Parsing' | 'Resolving' | 'Ready' | 'Partial' | 'Failed';
  watcher_health: WatcherHealth;
}

export interface FileInspection {
  file: FileNode;
  dependencies: FileNode[];
  dependents: FileNode[];
  outgoing_edges: DependencyEdge[];
  incoming_edges: DependencyEdge[];
}

export interface Point2D {
  x: number;
  y: number;
}

export interface Point3D {
  x: number;
  y: number;
  z: number;
}

export interface Transform {
  x: number;
  y: number;
  k: number;
}

