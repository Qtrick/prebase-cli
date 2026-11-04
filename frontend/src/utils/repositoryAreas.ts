import { DependencyEdge, FileNode } from '../types/graph';
import { findEntryPointCandidate, EntryPointCandidate } from './entryPointDetection';

export interface RepositoryArea {
  id: string;
  name: string;
  displayPath: string;
  fileCount: number;
  nodeIds: string[];
  nodes: FileNode[];
  languages: string[];
  totalDependencies: number; // Outgoing connections to files outside this area
  totalDependents: number;   // Incoming connections from files outside this area
  internalConnections: number; // Connections between files within the same area
}

export interface AreaEdge {
  id: string;
  sourceAreaId: string;
  targetAreaId: string;
  edgeCount: number;
  contributingEdges: DependencyEdge[];
}

export interface ExplorationSuggestion {
  nodeId: string;
  relativePath: string;
  filename: string;
  title: string;
  reason: string;
  badge: string;
  kind: 'entrypoint' | 'core-dependency' | 'area-hub';
}

export interface DerivedRepositoryStructure {
  areas: RepositoryArea[];
  areaMap: Map<string, RepositoryArea>;
  fileToAreaId: Map<string, string>;
  areaEdges: AreaEdge[];
  suggestions: ExplorationSuggestion[];
  entryPointCandidate: EntryPointCandidate | null;
}

/**
 * Normalizes a relative file path to its canonical repository area identifier.
 * Example:
 * - "src/components/Card.tsx" -> "src/components"
 * - "crates/prebase-core/src/model.rs" -> "crates/prebase-core"
 * - "package.json" -> "(root)"
 */
export function getAreaIdForPath(relativePath: string): string {
  const parts = relativePath.split('/').filter(Boolean);
  if (parts.length <= 1) {
    return '(root)';
  }

  // Handle common monorepo or workspace namespaces
  const first = parts[0];
  if (
    (first === 'crates' || first === 'packages' || first === 'apps' || first === 'libs') &&
    parts.length >= 3
  ) {
    return `${parts[0]}/${parts[1]}`;
  }

  // Handle standard nested src/ directory structures
  if (first === 'src' && parts.length >= 3) {
    return `src/${parts[1]}`;
  }

  // If 2 levels: e.g. "src/index.ts" -> "src"
  if (parts.length === 2) {
    return parts[0];
  }

  // Fallback to top-level directory
  return parts[0];
}

/**
 * Derives repository areas, inter-area relationships, and exploration suggestions
 * from static snapshot nodes and confirmed dependency edges.
 */
export function deriveRepositoryStructure(
  nodes: readonly FileNode[],
  edges: readonly DependencyEdge[]
): DerivedRepositoryStructure {
  const fileToAreaId = new Map<string, string>();
  const areaBuckets = new Map<string, FileNode[]>();

  for (const node of nodes) {
    const areaId = getAreaIdForPath(node.relative_path);
    fileToAreaId.set(node.id, areaId);
    let list = areaBuckets.get(areaId);
    if (!list) {
      list = [];
      areaBuckets.set(areaId, list);
    }
    list.push(node);
  }

  // Build RepositoryArea objects
  const areas: RepositoryArea[] = [];
  const areaMap = new Map<string, RepositoryArea>();

  for (const [areaId, areaNodes] of areaBuckets.entries()) {
    const languages = Array.from(new Set(areaNodes.map((n) => n.language).filter(Boolean)));
    const displayPath = areaId === '(root)' ? 'Root Directory' : `${areaId}/`;
    const name = areaId === '(root)' ? 'Root' : areaId.split('/').pop() || areaId;

    const area: RepositoryArea = {
      id: areaId,
      name,
      displayPath,
      fileCount: areaNodes.length,
      nodeIds: areaNodes.map((n) => n.id),
      nodes: areaNodes,
      languages,
      totalDependencies: 0,
      totalDependents: 0,
      internalConnections: 0,
    };
    areas.push(area);
    areaMap.set(areaId, area);
  }

  // Aggregate file-level edges into area-level edges
  const edgeAggregates = new Map<string, { count: number; edges: DependencyEdge[] }>();

  for (const edge of edges) {
    const srcArea = fileToAreaId.get(edge.source_file_id);
    const tgtArea = fileToAreaId.get(edge.target_file_id);
    if (!srcArea || !tgtArea) continue;

    if (srcArea === tgtArea) {
      const area = areaMap.get(srcArea);
      if (area) area.internalConnections++;
    } else {
      const srcObj = areaMap.get(srcArea);
      if (srcObj) srcObj.totalDependencies++;

      const tgtObj = areaMap.get(tgtArea);
      if (tgtObj) tgtObj.totalDependents++;

      const key = `${srcArea}-->${tgtArea}`;
      let agg = edgeAggregates.get(key);
      if (!agg) {
        agg = { count: 0, edges: [] };
        edgeAggregates.set(key, agg);
      }
      agg.count++;
      agg.edges.push(edge);
    }
  }

  const areaEdges: AreaEdge[] = [];
  for (const [key, agg] of edgeAggregates.entries()) {
    const [sourceAreaId, targetAreaId] = key.split('-->');
    areaEdges.push({
      id: key,
      sourceAreaId,
      targetAreaId,
      edgeCount: agg.count,
      contributingEdges: agg.edges,
    });
  }

  // Sort areas by size (descending file count)
  areas.sort((a, b) => b.fileCount - a.fileCount);

  // Compute Grounded Exploration Suggestions
  const suggestions: ExplorationSuggestion[] = [];
  const entryCandidate = findEntryPointCandidate(nodes);

  if (entryCandidate) {
    suggestions.push({
      nodeId: entryCandidate.nodeId,
      relativePath: entryCandidate.relativePath,
      filename: entryCandidate.filename,
      title: 'Entry Point Candidate',
      reason: entryCandidate.heuristicReason,
      badge: 'Entry Candidate',
      kind: 'entrypoint',
    });
  }

  // Top core dependencies (files with high incoming dependent count)
  const sortedByDependents = [...nodes]
    .filter((n) => n.id !== entryCandidate?.nodeId && (n.direct_dependent_count || 0) > 0)
    .sort((a, b) => (b.direct_dependent_count || 0) - (a.direct_dependent_count || 0));

  for (const topNode of sortedByDependents.slice(0, 3)) {
    suggestions.push({
      nodeId: topNode.id,
      relativePath: topNode.relative_path,
      filename: topNode.filename,
      title: 'Core Shared File',
      reason: `Used directly by ${topNode.direct_dependent_count} other file${topNode.direct_dependent_count === 1 ? '' : 's'}`,
      badge: `${topNode.direct_dependent_count} dependents`,
      kind: 'core-dependency',
    });
  }

  return {
    areas,
    areaMap,
    fileToAreaId,
    areaEdges,
    suggestions,
    entryPointCandidate: entryCandidate,
  };
}

