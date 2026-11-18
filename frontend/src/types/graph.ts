export type NodeKind = 'Source' | 'Test' | 'Config' | 'Doc' | 'Other';
export type NodeAnalysisStatus = 'Pending' | 'Analyzed' | 'PartiallyAnalyzed' | 'Excluded' | 'Failed' | 'Unsupported';

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

export type RelationshipKind = 'Import' | 'Export' | 'DynamicImport' | 'TypeOnly';
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

export type CycleClassification = 'RuntimeRelevant' | 'TypeOnly' | 'MixedStructural';

export interface CycleGroup {
  id: string;
  files: string[];
  example_cycle: string[];
  is_type_only: boolean;
  edge_count: number;
  classification?: CycleClassification;
}

export interface HighlyDependedFile {
  file_id: string;
  relative_path: string;
  dependent_count: number;
  dependency_count: number;
}

export interface ConnectedArea {
  area_id: string;
  outbound_count: number;
  inbound_count: number;
}

export interface AreaCoupling {
  area_id: string;
  file_count: number;
  analyzed_file_count: number;
  internal_edge_count: number;
  outbound_edge_count: number;
  inbound_edge_count: number;
  connected_areas: ConnectedArea[];
}

export interface DiagnosticsSummary {
  total_discovered: number;
  total_analyzed: number;
  total_fully_analyzed?: number;
  total_partially_analyzed: number;
  total_unsupported: number;
  total_failed: number;
  total_unresolved_imports: number;
  total_issues: number;
}

export type PathDirection = 'outgoing' | 'incoming';

export interface DependencyPath {
  nodes: string[];
  edges: DependencyEdge[];
  hops: number;
  is_type_only: boolean;
}

export type DependencyPathResult =
  | { status: 'found'; path: DependencyPath }
  | { status: 'not_found'; from: string; to: string }
  | { status: 'same_file'; file_id: string; hops: 0 }
  | { status: 'missing_endpoint'; missing_file_id: string };

export interface ArchitecturalInsights {
  cycle_groups: CycleGroup[];
  total_cycle_files: number;
  highly_depended_files: HighlyDependedFile[];
  area_couplings: AreaCoupling[];
  diagnostics_summary: DiagnosticsSummary;
}

export interface ImpactItem {
  file_id: string;
  relative_path: string;
  depth: number;
  is_type_only: boolean;
}

export interface FileImpactAnalysis {
  file_id: string;
  direct_dependents_count: number;
  transitive_dependents_count: number;
  total_impact_count: number;
  is_part_of_cycle: boolean;
  cycle_group_id?: string | null;
  impacted_files: ImpactItem[];
}

export interface GraphSnapshot {
  schema_version: string;
  repository_id: string;
  revision: number;
  nodes: FileNode[];
  edges: DependencyEdge[];
  coverage: AnalysisCoverage;
  issues: AnalysisIssue[];
  insights?: ArchitecturalInsights;
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

export interface NetworkCamera {
  yaw: number;
  pitch: number;
  panX: number;
  panY: number;
  zoom: number;
}

export interface ViewportInsets {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

