import { DependencyEdge, FileNode, RelationshipKind } from '../types/graph';
import {
  findEntryPointCandidates,
  EntryPointCandidate,
} from './entryPointDetection';

export interface AreaEdgeContributingFilePair {
  sourceFileId: string;
  targetFileId: string;
  relationshipKind: RelationshipKind;
  evidenceSpecifier: string;
  line?: number;
}

export interface AreaEdge {
  id: string;
  sourceAreaId: string;
  targetAreaId: string;
  edgeCount: number;
  sourceFilesCount: number;
  targetFilesCount: number;
  contributingEdges: DependencyEdge[];
  contributingFilePairs: AreaEdgeContributingFilePair[];
  summarySentence: string;
}

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
  outgoingAreaEdges: AreaEdge[];
  incomingAreaEdges: AreaEdge[];
  analyzedCount: number;
  unsupportedCount: number;
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
  entryPointCandidates: EntryPointCandidate[];
}

/**
 * Normalizes a relative file path to its canonical repository area identifier.
 * Uses an adaptive directory strategy:
 * - Root files (package.json, README.md, Cargo.toml) -> '(root)'
 * - Monorepo workspaces (crates/*, packages/*, apps/*, libs/*) -> 'crates/<name>'
 * - Nested fullstack apps (frontend/src/*, backend/src/*) -> 'frontend/src/components'
 * - Single-app structures (src/components/*, src/utils/*) -> 'src/components'
 * - Test directories (tests/*, e2e/*) -> 'tests'
 */
export function getAreaIdForPath(relativePath: string): string {
  const parts = relativePath.split('/').filter(Boolean);
  if (parts.length <= 1) {
    return '(root)';
  }

  const first = parts[0];

  // 1. Monorepo and workspace root packages (crates/*, packages/*, apps/*, libs/*, modules/*)
  if (
    (first === 'crates' || first === 'packages' || first === 'apps' || first === 'libs' || first === 'services' || first === 'modules') &&
    parts.length >= 3
  ) {
    return `${parts[0]}/${parts[1]}`;
  }

  // 2. Nested fullstack directories (frontend/src/*, backend/src/*, client/src/*, server/src/*)
  if (
    (first === 'frontend' || first === 'backend' || first === 'client' || first === 'server') &&
    parts.length >= 3
  ) {
    if (parts[1] === 'src' && parts.length >= 4) {
      return `${parts[0]}/src/${parts[2]}`;
    }
    return `${parts[0]}/${parts[1]}`;
  }

  // 3. Standard src/ nested directories (src/components/*, src/utils/*, src/routes/*)
  if (first === 'src') {
    if (parts.length >= 3) {
      return `src/${parts[1]}`;
    }
    return 'src';
  }

  // 4. Test suites
  if (first === 'tests' || first === 'test' || first === 'e2e' || first === '__tests__') {
    return first;
  }

  // 5. Default 2-level directory grouping
  if (parts.length >= 3) {
    return `${parts[0]}/${parts[1]}`;
  }

  return parts[0];
}

export function formatAreaEdgeSummarySentence(
  sourceFilesCount: number,
  srcName: string,
  targetFilesCount: number,
  tgtName: string,
  edgeCount: number,
  relationshipKinds: RelationshipKind[]
): string {
  const kinds = new Set(relationshipKinds);
  let verb = 'have confirmed source relationships with';
  if (kinds.size === 1) {
    const singleKind = relationshipKinds[0];
    if (singleKind === 'Import') {
      verb = 'import';
    } else if (singleKind === 'Export') {
      verb = 're-export from';
    } else if (singleKind === 'DynamicImport') {
      verb = 'dynamically import';
    } else if (singleKind === 'TypeOnly') {
      verb = 'import type definitions from';
    }
  }

  return `${sourceFilesCount} file${sourceFilesCount === 1 ? '' : 's'} in ${srcName} ${verb} ${targetFilesCount} file${targetFilesCount === 1 ? '' : 's'} in ${tgtName} across ${edgeCount} connection${edgeCount === 1 ? '' : 's'}.`;
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

    const analyzedCount = areaNodes.filter((n) => n.analysis_status === 'Analyzed').length;
    const unsupportedCount = areaNodes.filter((n) => n.analysis_status === 'Unsupported').length;

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
      outgoingAreaEdges: [],
      incomingAreaEdges: [],
      analyzedCount,
      unsupportedCount,
    };
    areas.push(area);
    areaMap.set(areaId, area);
  }

  // Aggregate file-level edges into area-level edges
  const edgeAggregates = new Map<
    string,
    {
      sourceAreaId: string;
      targetAreaId: string;
      edges: DependencyEdge[];
      sourceFiles: Set<string>;
      targetFiles: Set<string>;
    }
  >();

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
        agg = {
          sourceAreaId: srcArea,
          targetAreaId: tgtArea,
          edges: [],
          sourceFiles: new Set(),
          targetFiles: new Set(),
        };
        edgeAggregates.set(key, agg);
      }
      agg.edges.push(edge);
      agg.sourceFiles.add(edge.source_file_id);
      agg.targetFiles.add(edge.target_file_id);
    }
  }

  const areaEdges: AreaEdge[] = [];
  for (const [key, agg] of edgeAggregates.entries()) {
    const srcAreaObj = areaMap.get(agg.sourceAreaId);
    const tgtAreaObj = areaMap.get(agg.targetAreaId);
    const srcName = srcAreaObj ? srcAreaObj.name : agg.sourceAreaId;
    const tgtName = tgtAreaObj ? tgtAreaObj.name : agg.targetAreaId;

    const contributingFilePairs: AreaEdgeContributingFilePair[] = agg.edges.map((e) => ({
      sourceFileId: e.source_file_id,
      targetFileId: e.target_file_id,
      relationshipKind: e.relationship_kind,
      evidenceSpecifier: e.evidence[0]?.import_specifier || '',
      line: e.evidence[0]?.line,
    }));

    const edgeCount = agg.edges.length;
    const sourceFilesCount = agg.sourceFiles.size;
    const targetFilesCount = agg.targetFiles.size;

    const summarySentence = formatAreaEdgeSummarySentence(
      sourceFilesCount,
      srcName,
      targetFilesCount,
      tgtName,
      edgeCount,
      agg.edges.map((e) => e.relationship_kind)
    );

    const areaEdge: AreaEdge = {
      id: key,
      sourceAreaId: agg.sourceAreaId,
      targetAreaId: agg.targetAreaId,
      edgeCount,
      sourceFilesCount,
      targetFilesCount,
      contributingEdges: agg.edges,
      contributingFilePairs,
      summarySentence,
    };

    areaEdges.push(areaEdge);

    if (srcAreaObj) srcAreaObj.outgoingAreaEdges.push(areaEdge);
    if (tgtAreaObj) tgtAreaObj.incomingAreaEdges.push(areaEdge);
  }

  // Sort area edges in each area by edgeCount descending
  for (const area of areas) {
    area.outgoingAreaEdges.sort((a, b) => b.edgeCount - a.edgeCount);
    area.incomingAreaEdges.sort((a, b) => b.edgeCount - a.edgeCount);
  }

  // Sort areas by size (descending file count)
  areas.sort((a, b) => b.fileCount - a.fileCount);

  // Compute Grounded Exploration Suggestions
  const suggestions: ExplorationSuggestion[] = [];
  const entryCandidates = findEntryPointCandidates(nodes);
  const primaryEntry = entryCandidates.length > 0 ? entryCandidates[0] : null;

  for (const cand of entryCandidates.slice(0, 2)) {
    suggestions.push({
      nodeId: cand.nodeId,
      relativePath: cand.relativePath,
      filename: cand.filename,
      title: cand.displayTitle,
      reason: cand.heuristicReason,
      badge: cand.kind === 'library-crate-root' ? 'Crate Root' : 'Entry Candidate',
      kind: 'entrypoint',
    });
  }

  // Frequently imported files (files with high incoming dependent count)
  const candidateIds = new Set(entryCandidates.map((c) => c.nodeId));
  const sortedByDependents = [...nodes]
    .filter((n) => !candidateIds.has(n.id) && (n.direct_dependent_count || 0) > 0)
    .sort((a, b) => (b.direct_dependent_count || 0) - (a.direct_dependent_count || 0));

  for (const topNode of sortedByDependents.slice(0, 3)) {
    suggestions.push({
      nodeId: topNode.id,
      relativePath: topNode.relative_path,
      filename: topNode.filename,
      title: 'Frequently imported file',
      reason: `Imported by ${topNode.direct_dependent_count} indexed file${topNode.direct_dependent_count === 1 ? '' : 's'}`,
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
    entryPointCandidate: primaryEntry,
    entryPointCandidates: entryCandidates,
  };
}
