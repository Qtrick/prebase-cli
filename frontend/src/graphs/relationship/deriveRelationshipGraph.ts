import { DependencyEdge, FileNode, GraphSnapshot } from '../../types/graph';
import {
  DeriveRelationshipOptions,
  OmissionStats,
  RelationshipColumn,
  RelationshipDepth,
  RelationshipDirection,
  RelationshipEdge,
  RelationshipGraphData,
  RelationshipNode,
} from './relationshipTypes';

const DEFAULT_MAX_NODES = 120;
const DEFAULT_MAX_EDGES = 240;

export function deriveRelationshipGraph(
  snapshot: GraphSnapshot | null,
  focusNodeId: string | null,
  options: DeriveRelationshipOptions = {}
): RelationshipGraphData {
  const depth: RelationshipDepth = options.depth ?? 1;
  const direction: RelationshipDirection = options.direction ?? 'both';
  const filterKinds = options.filterKinds && options.filterKinds.length > 0 ? options.filterKinds : null;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const maxEdges = options.maxEdges ?? DEFAULT_MAX_EDGES;

  const emptyOmission: OmissionStats = {
    totalDirectDependents: 0,
    omittedDirectDependents: 0,
    totalDirectDependencies: 0,
    omittedDirectDependencies: 0,
    totalSecondHopDependents: 0,
    omittedSecondHopDependents: 0,
    totalSecondHopDependencies: 0,
    omittedSecondHopDependencies: 0,
    totalEdges: 0,
    omittedEdges: 0,
    isCapped: false,
  };

  if (!snapshot || !focusNodeId) {
    return {
      focusNode: null,
      nodes: [],
      edges: [],
      nodesById: new Map(),
      columns: [],
      omission: emptyOmission,
      depth,
      direction,
    };
  }

  const nodeMap = new Map<string, FileNode>();
  for (const node of snapshot.nodes) {
    nodeMap.set(node.id, node);
  }

  const focusNode = nodeMap.get(focusNodeId) || null;
  if (!focusNode) {
    return {
      focusNode: null,
      nodes: [],
      edges: [],
      nodesById: new Map(),
      columns: [],
      omission: emptyOmission,
      depth,
      direction,
    };
  }

  // Pre-filter snapshot edges by relationship kind if requested
  const relevantEdges = filterKinds
    ? snapshot.edges.filter((e) => filterKinds.includes(e.relationship_kind))
    : snapshot.edges;

  // 1. Discover Direct Dependents (incoming: source -> focus) and Direct Dependencies (outgoing: focus -> target)
  const directDependentIds = new Set<string>();
  const directDependencyIds = new Set<string>();

  for (const edge of relevantEdges) {
    if (edge.target_file_id === focusNodeId && edge.source_file_id !== focusNodeId) {
      if (nodeMap.has(edge.source_file_id)) {
        directDependentIds.add(edge.source_file_id);
      }
    }
    if (edge.source_file_id === focusNodeId && edge.target_file_id !== focusNodeId) {
      if (nodeMap.has(edge.target_file_id)) {
        directDependencyIds.add(edge.target_file_id);
      }
    }
  }

  const includeDependents = direction === 'both' || direction === 'dependents';
  const includeDependencies = direction === 'both' || direction === 'dependencies';

  // 2. Discover Second-Hop Nodes if depth === 2
  const secondHopDependentIds = new Set<string>();
  const secondHopDependencyIds = new Set<string>();

  if (depth === 2) {
    if (includeDependents) {
      for (const edge of relevantEdges) {
        if (
          directDependentIds.has(edge.target_file_id) &&
          edge.source_file_id !== focusNodeId &&
          !directDependentIds.has(edge.source_file_id) &&
          !directDependencyIds.has(edge.source_file_id) &&
          nodeMap.has(edge.source_file_id)
        ) {
          secondHopDependentIds.add(edge.source_file_id);
        }
      }
    }

    if (includeDependencies) {
      for (const edge of relevantEdges) {
        if (
          directDependencyIds.has(edge.source_file_id) &&
          edge.target_file_id !== focusNodeId &&
          !directDependencyIds.has(edge.target_file_id) &&
          !directDependentIds.has(edge.target_file_id) &&
          !secondHopDependentIds.has(edge.target_file_id) &&
          nodeMap.has(edge.target_file_id)
        ) {
          secondHopDependencyIds.add(edge.target_file_id);
        }
      }
    }
  }

  // Sort candidate nodes deterministically by relative_path
  const sortNodesByPath = (ids: Set<string>): FileNode[] => {
    return Array.from(ids)
      .map((id) => nodeMap.get(id)!)
      .filter(Boolean)
      .sort((a, b) => a.relative_path.localeCompare(b.relative_path));
  };

  const allDirectDependents = includeDependents ? sortNodesByPath(directDependentIds) : [];
  const allDirectDependencies = includeDependencies ? sortNodesByPath(directDependencyIds) : [];
  const allSecondHopDependents = includeDependents && depth === 2 ? sortNodesByPath(secondHopDependentIds) : [];
  const allSecondHopDependencies = includeDependencies && depth === 2 ? sortNodesByPath(secondHopDependencyIds) : [];

  // Quota allocation for caps
  // Focus takes 1 node
  let remainingNodeBudget = Math.max(0, maxNodes - 1);

  // Allocate direct neighbors first
  const totalDirect = allDirectDependents.length + allDirectDependencies.length;
  let keptDirectDependents: FileNode[] = [];
  let keptDirectDependencies: FileNode[] = [];

  if (totalDirect <= remainingNodeBudget) {
    keptDirectDependents = allDirectDependents;
    keptDirectDependencies = allDirectDependencies;
    remainingNodeBudget -= totalDirect;
  } else {
    // Proportional allocation or fair split
    const halfBudget = Math.floor(remainingNodeBudget / 2);
    if (allDirectDependents.length <= halfBudget) {
      keptDirectDependents = allDirectDependents;
      keptDirectDependencies = allDirectDependencies.slice(0, remainingNodeBudget - keptDirectDependents.length);
    } else if (allDirectDependencies.length <= halfBudget) {
      keptDirectDependencies = allDirectDependencies;
      keptDirectDependents = allDirectDependents.slice(0, remainingNodeBudget - keptDirectDependencies.length);
    } else {
      keptDirectDependents = allDirectDependents.slice(0, halfBudget);
      keptDirectDependencies = allDirectDependencies.slice(0, remainingNodeBudget - halfBudget);
    }
    remainingNodeBudget = 0;
  }

  // Allocate second-hop neighbors with remaining budget
  let keptSecondHopDependents: FileNode[] = [];
  let keptSecondHopDependencies: FileNode[] = [];

  if (remainingNodeBudget > 0 && depth === 2) {
    const totalSecondHop = allSecondHopDependents.length + allSecondHopDependencies.length;
    if (totalSecondHop <= remainingNodeBudget) {
      keptSecondHopDependents = allSecondHopDependents;
      keptSecondHopDependencies = allSecondHopDependencies;
      remainingNodeBudget -= totalSecondHop;
    } else {
      const halfBudget = Math.floor(remainingNodeBudget / 2);
      if (allSecondHopDependents.length <= halfBudget) {
        keptSecondHopDependents = allSecondHopDependents;
        keptSecondHopDependencies = allSecondHopDependencies.slice(0, remainingNodeBudget - keptSecondHopDependents.length);
      } else if (allSecondHopDependencies.length <= halfBudget) {
        keptSecondHopDependencies = allSecondHopDependencies;
        keptSecondHopDependents = allSecondHopDependents.slice(0, remainingNodeBudget - keptSecondHopDependencies.length);
      } else {
        keptSecondHopDependents = allSecondHopDependents.slice(0, halfBudget);
        keptSecondHopDependencies = allSecondHopDependencies.slice(0, remainingNodeBudget - halfBudget);
      }
      remainingNodeBudget = 0;
    }
  }

  // Build finalized nodes list and map
  const finalNodes: RelationshipNode[] = [];
  const nodesById = new Map<string, RelationshipNode>();

  // Add Focus
  const focusRelNode: RelationshipNode = {
    node: focusNode,
    role: 'focus',
    columnIndex: 0,
    rowIndex: 0,
    isDirectNeighbor: false,
    hopDistance: 0,
  };
  finalNodes.push(focusRelNode);
  nodesById.set(focusNode.id, focusRelNode);

  // Add Direct Dependents (Column -1)
  keptDirectDependents.forEach((n) => {
    if (nodesById.has(n.id)) return;
    const relNode: RelationshipNode = {
      node: n,
      role: 'dependent-1',
      columnIndex: -1,
      rowIndex: finalNodes.filter((x) => x.role === 'dependent-1').length,
      isDirectNeighbor: true,
      hopDistance: 1,
    };
    finalNodes.push(relNode);
    nodesById.set(n.id, relNode);
  });

  // Add Direct Dependencies (Column 1)
  keptDirectDependencies.forEach((n) => {
    if (nodesById.has(n.id)) return;
    const relNode: RelationshipNode = {
      node: n,
      role: 'dependency-1',
      columnIndex: 1,
      rowIndex: finalNodes.filter((x) => x.role === 'dependency-1').length,
      isDirectNeighbor: true,
      hopDistance: 1,
    };
    finalNodes.push(relNode);
    nodesById.set(n.id, relNode);
  });

  // Add Second-Hop Dependents (Column -2)
  keptSecondHopDependents.forEach((n) => {
    if (nodesById.has(n.id)) return;
    const relNode: RelationshipNode = {
      node: n,
      role: 'dependent-2',
      columnIndex: -2,
      rowIndex: finalNodes.filter((x) => x.role === 'dependent-2').length,
      isDirectNeighbor: false,
      hopDistance: 2,
    };
    finalNodes.push(relNode);
    nodesById.set(n.id, relNode);
  });

  // Add Second-Hop Dependencies (Column 2)
  keptSecondHopDependencies.forEach((n) => {
    if (nodesById.has(n.id)) return;
    const relNode: RelationshipNode = {
      node: n,
      role: 'dependency-2',
      columnIndex: 2,
      rowIndex: finalNodes.filter((x) => x.role === 'dependency-2').length,
      isDirectNeighbor: false,
      hopDistance: 2,
    };
    finalNodes.push(relNode);
    nodesById.set(n.id, relNode);
  });

  // 3. Collect and classify edges between all included nodes
  // Detect bidirectional/mutual pairs: (source, target) & (target, source)
  const edgePairKeys = new Set<string>();
  const mutualPairKeys = new Set<string>();

  for (const edge of relevantEdges) {
    if (nodesById.has(edge.source_file_id) && nodesById.has(edge.target_file_id)) {
      const pairKey = `${edge.source_file_id}->${edge.target_file_id}`;
      const reverseKey = `${edge.target_file_id}->${edge.source_file_id}`;
      edgePairKeys.add(pairKey);
      if (edgePairKeys.has(reverseKey)) {
        mutualPairKeys.add(pairKey);
        mutualPairKeys.add(reverseKey);
      }
    }
  }

  // Prioritize edges:
  // Priority 1: edges connected directly to focus
  // Priority 2: edges between direct neighbors
  // Priority 3: second hop edges
  const edgePriority = (edge: DependencyEdge): number => {
    const touchesFocus = edge.source_file_id === focusNodeId || edge.target_file_id === focusNodeId;
    if (touchesFocus) return 1;
    const src = nodesById.get(edge.source_file_id);
    const tgt = nodesById.get(edge.target_file_id);
    if (src?.isDirectNeighbor && tgt?.isDirectNeighbor) return 2;
    return 3;
  };

  const candidateEdges = relevantEdges
    .filter((edge) => nodesById.has(edge.source_file_id) && nodesById.has(edge.target_file_id))
    .sort((a, b) => edgePriority(a) - edgePriority(b));

  const totalCandidateEdges = candidateEdges.length;
  const keptEdgesList = candidateEdges.slice(0, maxEdges);
  const omittedEdgesCount = Math.max(0, totalCandidateEdges - maxEdges);

  const finalEdges: RelationshipEdge[] = keptEdgesList.map((edge) => {
    const srcNode = nodesById.get(edge.source_file_id)!;
    const tgtNode = nodesById.get(edge.target_file_id)!;
    const isDirectToFocus = edge.source_file_id === focusNodeId || edge.target_file_id === focusNodeId;
    const isSelfLoop = edge.source_file_id === edge.target_file_id;
    const isMutual = mutualPairKeys.has(`${edge.source_file_id}->${edge.target_file_id}`);

    return {
      edge,
      sourceRole: srcNode.role,
      targetRole: tgtNode.role,
      isDirectToFocus,
      isMutual,
      isSelfLoop,
    };
  });

  // Calculate Omission Stats
  const omittedDirectDependents = allDirectDependents.length - keptDirectDependents.length;
  const omittedDirectDependencies = allDirectDependencies.length - keptDirectDependencies.length;
  const omittedSecondHopDependents = allSecondHopDependents.length - keptSecondHopDependents.length;
  const omittedSecondHopDependencies = allSecondHopDependencies.length - keptSecondHopDependencies.length;

  const isCapped =
    omittedDirectDependents > 0 ||
    omittedDirectDependencies > 0 ||
    omittedSecondHopDependents > 0 ||
    omittedSecondHopDependencies > 0 ||
    omittedEdgesCount > 0;

  const omission: OmissionStats = {
    totalDirectDependents: allDirectDependents.length,
    omittedDirectDependents,
    totalDirectDependencies: allDirectDependencies.length,
    omittedDirectDependencies,
    totalSecondHopDependents: allSecondHopDependents.length,
    omittedSecondHopDependents,
    totalSecondHopDependencies: allSecondHopDependencies.length,
    omittedSecondHopDependencies,
    totalEdges: totalCandidateEdges,
    omittedEdges: omittedEdgesCount,
    isCapped,
  };

  // Build Column metadata
  const columns: RelationshipColumn[] = [];

  if (includeDependents && depth === 2) {
    columns.push({
      role: 'dependent-2',
      columnIndex: -2,
      title: '2nd-Hop Dependents',
      subtitle: 'Files importing dependents',
      nodes: finalNodes.filter((n) => n.role === 'dependent-2'),
      omittedCount: omittedSecondHopDependents,
      totalCount: allSecondHopDependents.length,
    });
  }

  if (includeDependents) {
    columns.push({
      role: 'dependent-1',
      columnIndex: -1,
      title: 'Dependents',
      subtitle: 'Files that import this file',
      nodes: finalNodes.filter((n) => n.role === 'dependent-1'),
      omittedCount: omittedDirectDependents,
      totalCount: allDirectDependents.length,
    });
  }

  columns.push({
    role: 'focus',
    columnIndex: 0,
    title: 'Focus File',
    subtitle: focusNode.relative_path,
    nodes: [focusRelNode],
    omittedCount: 0,
    totalCount: 1,
  });

  if (includeDependencies) {
    columns.push({
      role: 'dependency-1',
      columnIndex: 1,
      title: 'Dependencies',
      subtitle: 'Files imported by this file',
      nodes: finalNodes.filter((n) => n.role === 'dependency-1'),
      omittedCount: omittedDirectDependencies,
      totalCount: allDirectDependencies.length,
    });
  }

  if (includeDependencies && depth === 2) {
    columns.push({
      role: 'dependency-2',
      columnIndex: 2,
      title: '2nd-Hop Dependencies',
      subtitle: 'Files imported by dependencies',
      nodes: finalNodes.filter((n) => n.role === 'dependency-2'),
      omittedCount: omittedSecondHopDependencies,
      totalCount: allSecondHopDependencies.length,
    });
  }

  return {
    focusNode,
    nodes: finalNodes,
    edges: finalEdges,
    nodesById,
    columns,
    omission,
    depth,
    direction,
  };
}
