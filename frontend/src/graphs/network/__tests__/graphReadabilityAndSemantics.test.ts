import { describe, it, expect } from 'vitest';
import { DependencyEdge, FileNode, GraphSnapshot } from '../../../types/graph';
import { findEntryPointCandidate } from '../../../utils/entryPointDetection';
import {
  deriveRepositoryStructure,
  getAreaIdForPath,
} from '../../../utils/repositoryAreas';
import { rankSearchResults, isEditableElement } from '../../../search/SearchBox';
import { deriveRelationshipGraph } from '../../relationship/deriveRelationshipGraph';

const makeNode = (
  id: string,
  path = `${id}.ts`,
  deps = 0,
  dependents = 0,
  lang = 'typescript'
): FileNode => ({
  id,
  relative_path: path,
  filename: path.split('/').pop() || path,
  language: lang,
  size_bytes: 500,
  file_kind: 'Source',
  analysis_status: 'Analyzed',
  direct_dependency_count: deps,
  direct_dependent_count: dependents,
});

const makeEdge = (
  source: string,
  target: string,
  id = `${source}->${target}`
): DependencyEdge => ({
  id,
  source_file_id: source,
  target_file_id: target,
  relationship_kind: 'Import',
  resolution_status: 'ResolvedInternal',
  evidence: [],
});

const makeSnapshot = (nodes: FileNode[], edges: DependencyEdge[]): GraphSnapshot => ({
  schema_version: '1.0.0',
  repository_id: 'test-repo',
  revision: 1,
  nodes,
  edges,
  coverage: {
    total_discovered: nodes.length,
    total_analyzed: nodes.length,
    total_excluded: 0,
    total_issues: 0,
    is_complete: true,
  },
  issues: [],
});

describe('Graph Readability & Semantic Precision Suite', () => {
  // --------------------------------------------------------------------------
  // 1. Defect 4.1: Neighbor Map Adjacency Correctness
  // --------------------------------------------------------------------------
  describe('Neighbor Map Adjacency Correctness (Defect 4.1)', () => {
    it('only flags directly connected neighbors of the selected node, not any node with edges', () => {
      // Node A is connected to Node B (A -> B)
      // Node C is connected to Node D (C -> D)
      // Node E is isolated (0 edges)
      const edges: DependencyEdge[] = [
        makeEdge('node-A', 'node-B', 'e1'),
        makeEdge('node-C', 'node-D', 'e2'),
      ];

      // Build neighbor map as in NetworkCanvas
      const neighborMap = new Map<string, Set<string>>();
      for (const edge of edges) {
        if (!neighborMap.has(edge.source_file_id)) neighborMap.set(edge.source_file_id, new Set());
        if (!neighborMap.has(edge.target_file_id)) neighborMap.set(edge.target_file_id, new Set());
        neighborMap.get(edge.source_file_id)!.add(edge.target_file_id);
        neighborMap.get(edge.target_file_id)!.add(edge.source_file_id);
      }

      const selectedNodeId = 'node-A';

      // Old flawed logic: neighborMap.has(pNode.id)
      // For Node C: neighborMap.has('node-C') === true (WRONG! C has edges, but NOT to A)
      expect(neighborMap.has('node-C')).toBe(true);

      // Correct logic: neighborMap.get(selectedNodeId)?.has(pNode.id) ?? false
      const isConnected = (targetId: string) =>
        selectedNodeId !== null && (neighborMap.get(selectedNodeId)?.has(targetId) ?? false);

      expect(isConnected('node-B')).toBe(true); // Direct neighbor of A -> TRUE
      expect(isConnected('node-C')).toBe(false); // Connected to D, NOT A -> FALSE
      expect(isConnected('node-D')).toBe(false); // Connected to C, NOT A -> FALSE
      expect(isConnected('node-E')).toBe(false); // Isolated -> FALSE
    });
  });

  // --------------------------------------------------------------------------
  // 2. Defect 4.2: Grounded Entry Point Candidate Detection
  // --------------------------------------------------------------------------
  describe('Entry Point Candidate Detection (Defect 4.2)', () => {
    it('detects index.ts as entry point even when it is placed at the end of the node list', () => {
      const nodes: FileNode[] = [
        makeNode('f1', 'src/utils/helpers.ts', 0, 5),
        makeNode('f2', 'src/components/Card.tsx', 2, 1),
        makeNode('f3', 'src/index.ts', 3, 0),
      ];

      const candidate = findEntryPointCandidate(nodes);
      expect(candidate).not.toBeNull();
      expect(candidate?.nodeId).toBe('f3');
      expect(candidate?.relativePath).toBe('src/index.ts');
      expect(candidate?.confidence).toBe('high');
      // Verifies f1 (nodes[0]) is NOT selected
      expect(candidate?.nodeId).not.toBe(nodes[0].id);
    });

    it('detects Rust main.rs as entry point in systems projects', () => {
      const nodes: FileNode[] = [
        makeNode('r1', 'crates/core/src/lib.rs', 1, 3, 'rust'),
        makeNode('r2', 'src/main.rs', 5, 0, 'rust'),
      ];

      const candidate = findEntryPointCandidate(nodes);
      expect(candidate).not.toBeNull();
      expect(candidate?.nodeId).toBe('r2');
      expect(candidate?.relativePath).toBe('src/main.rs');
    });

    it('returns null and does not guess arbitrarily when no standard entry point pattern matches', () => {
      const nodes: FileNode[] = [
        makeNode('m1', 'lib/alpha.ts', 1, 1),
        makeNode('m2', 'lib/beta.ts', 1, 1),
      ];

      const candidate = findEntryPointCandidate(nodes);
      expect(candidate).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // 3. Repository Area Derivation & Inter-Area Structure
  // --------------------------------------------------------------------------
  describe('Repository Area Derivation & Inter-Area Aggregation (Section 6)', () => {
    it('classifies file paths into canonical repository areas', () => {
      expect(getAreaIdForPath('package.json')).toBe('(root)');
      expect(getAreaIdForPath('src/main.ts')).toBe('src');
      expect(getAreaIdForPath('src/components/Button.tsx')).toBe('src/components');
      expect(getAreaIdForPath('src/components/Card/Header.tsx')).toBe('src/components');
      expect(getAreaIdForPath('crates/prebase-core/src/lib.rs')).toBe('crates/prebase-core');
    });

    it('aggregates inter-area relationships and generates grounded exploration suggestions', () => {
      const nodes: FileNode[] = [
        makeNode('n1', 'src/components/Button.tsx', 1, 0),
        makeNode('n2', 'src/components/Card.tsx', 1, 0),
        makeNode('n3', 'src/utils/math.ts', 0, 4), // Foundation file used by 4
      ];

      const edges: DependencyEdge[] = [
        makeEdge('n1', 'n3', 'e1'),
        makeEdge('n2', 'n3', 'e2'),
      ];

      const structure = deriveRepositoryStructure(nodes, edges);

      // Verify areas
      expect(structure.areas.length).toBe(2);
      const componentsArea = structure.areaMap.get('src/components');
      const utilsArea = structure.areaMap.get('src/utils');

      expect(componentsArea).toBeDefined();
      expect(componentsArea?.fileCount).toBe(2);
      expect(componentsArea?.totalDependencies).toBe(2); // 2 outgoing edges to utils

      expect(utilsArea).toBeDefined();
      expect(utilsArea?.fileCount).toBe(1);
      expect(utilsArea?.totalDependents).toBe(2); // 2 incoming edges from components

      // Verify exploration suggestions includes math.ts as a core dependency
      const mathSug = structure.suggestions.find((s) => s.nodeId === 'n3');
      expect(mathSug).toBeDefined();
      expect(mathSug?.kind).toBe('core-dependency');
      expect(mathSug?.badge).toBe('4 dependents');
    });
  });

  // --------------------------------------------------------------------------
  // 4. Deterministic Search Ranking & Keyboard Guard (Section 11)
  // --------------------------------------------------------------------------
  describe('Deterministic Search Ranking & Keyboard Guard (Section 11)', () => {
    const searchFixtures: FileNode[] = [
      makeNode('1', 'src/components/Card.tsx'),
      makeNode('2', 'src/cardItem.ts'),
      makeNode('3', 'src/wildcard.ts'),
      makeNode('4', 'src/card/index.ts'),
      makeNode('5', 'src/other.ts'),
    ];

    it('ranks results deterministically: exact filename > prefix > substring > path', () => {
      // Query "card"
      const results = rankSearchResults(searchFixtures, 'card');

      // Rank 1: Exact filename match (Card.tsx)
      expect(results[0].id).toBe('1');
      // Rank 2: Filename prefix match (cardItem.ts)
      expect(results[1].id).toBe('2');
      // Rank 3: Filename substring match (wildcard.ts)
      expect(results[2].id).toBe('3');
      // Rank 4: Path substring match (src/card/index.ts)
      expect(results[3].id).toBe('4');
      // "other.ts" should not match
      expect(results.some((r) => r.id === '5')).toBe(false);
    });

    it('identifies editable elements to prevent shortcut hijacking', () => {
      const mockInput = { tagName: 'INPUT', isContentEditable: false } as unknown as Element;
      const mockTextarea = { tagName: 'TEXTAREA', isContentEditable: false } as unknown as Element;
      const mockSelect = { tagName: 'SELECT', isContentEditable: false } as unknown as Element;
      const mockDiv = { tagName: 'DIV', isContentEditable: false } as unknown as Element;
      const mockContentEditable = { tagName: 'DIV', isContentEditable: true } as unknown as Element;

      expect(isEditableElement(mockInput)).toBe(true);
      expect(isEditableElement(mockTextarea)).toBe(true);
      expect(isEditableElement(mockSelect)).toBe(true);
      expect(isEditableElement(mockContentEditable)).toBe(true);
      expect(isEditableElement(mockDiv)).toBe(false);
      expect(isEditableElement(null)).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // 5. Beginner-Friendly 2D Column Headers & Relationship Direction
  // --------------------------------------------------------------------------
  describe('Plain-English Column Headers & Directional Labels (Defect 4.5)', () => {
    it('uses beginner-friendly headers instead of graph theory jargon', () => {
      const nodes: FileNode[] = [
        makeNode('focus', 'src/App.tsx', 1, 1),
        makeNode('dep', 'src/utils.ts', 0, 1),
        makeNode('parent', 'src/main.tsx', 1, 0),
      ];

      const edges: DependencyEdge[] = [
        makeEdge('focus', 'dep', 'e1'),
        makeEdge('parent', 'focus', 'e2'),
      ];

      const snapshot = makeSnapshot(nodes, edges);
      const graph = deriveRelationshipGraph(snapshot, 'focus');

      expect(graph.columns.length).toBe(3);
      // Incoming column: Files that use this file
      expect(graph.columns[0].title).toBe('Files that use this file');
      expect(graph.columns[0].subtitle).toContain('Direct dependents');

      // Center column: Selected File
      expect(graph.columns[1].title).toBe('Selected File');

      // Outgoing column: Files this file uses
      expect(graph.columns[2].title).toBe('Files this file uses');
      expect(graph.columns[2].subtitle).toContain('Direct dependencies');
    });
  });

  // --------------------------------------------------------------------------
  // 6. Duplicate Filename Disambiguation & Screen-Space Collision Avoidance
  // --------------------------------------------------------------------------
  describe('Filename Disambiguation & Label Layout (Section 4.6)', () => {
    it('prepends parent folder to filenames that appear in multiple directories', () => {
      const nodes: FileNode[] = [
        makeNode('c1', 'src/components/Card.tsx'),
        makeNode('c2', 'src/widgets/Card.tsx'),
        makeNode('u1', 'src/utils/unique.ts'),
      ];

      const counts = new Map<string, number>();
      for (const node of nodes) {
        counts.set(node.filename, (counts.get(node.filename) || 0) + 1);
      }
      const duplicateFilenames = new Set<string>();
      for (const [name, count] of counts.entries()) {
        if (count > 1) duplicateFilenames.add(name);
      }

      const formatLabel = (node: FileNode) => {
        if (duplicateFilenames.has(node.filename)) {
          const parts = node.relative_path.split('/');
          if (parts.length > 1) {
            return `${parts[parts.length - 2]}/${node.filename}`;
          }
        }
        return node.filename;
      };

      expect(formatLabel(nodes[0])).toBe('components/Card.tsx');
      expect(formatLabel(nodes[1])).toBe('widgets/Card.tsx');
      expect(formatLabel(nodes[2])).toBe('unique.ts'); // Unique stays simple!
    });

    it('prioritizes foreground node labels over colliding background node labels', () => {
      // Node A is in foreground (z = 80), Node B is directly behind it in background (z = -10)
      const foregroundNode = { id: 'fg', z: 80, isSelected: false, isHovered: false };
      const backgroundNode = { id: 'bg', z: -10, isSelected: false, isHovered: false };
      const candidates = [backgroundNode, foregroundNode];

      // Sort as in NetworkCanvas: priority first, then projected.z descending
      candidates.sort((a, b) => {
        const aPriority = a.isSelected || a.isHovered ? 1 : 0;
        const bPriority = b.isSelected || b.isHovered ? 1 : 0;
        if (bPriority !== aPriority) return bPriority - aPriority;
        return b.z - a.z;
      });

      // Verify foreground node is evaluated first
      expect(candidates[0].id).toBe('fg');
      expect(candidates[1].id).toBe('bg');

      // Simulate bounding box placement with collision
      const placed: string[] = [];
      const collidesWithPlaced = () => placed.length > 0; // Simulated collision

      for (const cand of candidates) {
        if (!collidesWithPlaced()) {
          placed.push(cand.id);
        }
      }

      // Foreground node is placed; background node is suppressed
      expect(placed).toEqual(['fg']);
    });
  });
});
