import { DependencyEdge, FileNode, RelationshipKind } from '../../types/graph';

export type RelationshipDepth = 1 | 2;
export type RelationshipDirection = 'both' | 'dependencies' | 'dependents';

export type RelationshipRole =
  | 'focus'
  | 'dependent-1'
  | 'dependent-2'
  | 'dependency-1'
  | 'dependency-2';

export interface RelationshipNode {
  node: FileNode;
  role: RelationshipRole;
  columnIndex: number; // -2 (dep2), -1 (dep1), 0 (focus), 1 (dep1), 2 (dep2)
  rowIndex: number;
  isDirectNeighbor: boolean;
  hopDistance: number;
}

export interface RelationshipEdge {
  edge: DependencyEdge;
  sourceRole: RelationshipRole;
  targetRole: RelationshipRole;
  isDirectToFocus: boolean;
  isMutual: boolean;
  isSelfLoop: boolean;
}

export interface OmissionStats {
  totalDirectDependents: number;
  omittedDirectDependents: number;
  totalDirectDependencies: number;
  omittedDirectDependencies: number;
  totalSecondHopDependents: number;
  omittedSecondHopDependents: number;
  totalSecondHopDependencies: number;
  omittedSecondHopDependencies: number;
  totalEdges: number;
  omittedEdges: number;
  isCapped: boolean;
}

export interface RelationshipColumn {
  role: RelationshipRole;
  columnIndex: number;
  title: string;
  subtitle: string;
  nodes: RelationshipNode[];
  omittedCount: number;
  totalCount: number;
}

export interface RelationshipGraphData {
  focusNode: FileNode | null;
  nodes: RelationshipNode[];
  edges: RelationshipEdge[];
  nodesById: Map<string, RelationshipNode>;
  columns: RelationshipColumn[];
  omission: OmissionStats;
  depth: RelationshipDepth;
  direction: RelationshipDirection;
}

export interface DeriveRelationshipOptions {
  depth?: RelationshipDepth;
  direction?: RelationshipDirection;
  filterKinds?: RelationshipKind[];
  maxNodes?: number;
  maxEdges?: number;
}

