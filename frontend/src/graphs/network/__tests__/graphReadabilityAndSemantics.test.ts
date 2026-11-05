import { describe, it, expect } from 'vitest';
import { DependencyEdge, FileNode, GraphSnapshot, RelationshipKind } from '../../../types/graph';
import { findEntryPointCandidate, findEntryPointCandidates } from '../../../utils/entryPointDetection';
import {
  deriveRepositoryStructure,
  getAreaIdForPath,
} from '../../../utils/repositoryAreas';
import { rankSearchResults, isEditableElement } from '../../../search/SearchBox';
import { deriveRelationshipGraph } from '../../relationship/deriveRelationshipGraph';
import { computeDisambiguatedLabels } from '../../../utils/pathDisambiguation';
import {
  computeLabelPriorityScore,
  LabelCollisionGrid,
} from '../render/networkRenderMath';
import { getEdgeRelationshipSentence } from '../../../inspector/Inspector';

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

      const labels = computeDisambiguatedLabels(nodes);

      expect(labels.get('c1')).toBe('components/Card.tsx');
      expect(labels.get('c2')).toBe('widgets/Card.tsx');
      expect(labels.get('u1')).toBe('unique.ts'); // Unique stays simple!
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

  // --------------------------------------------------------------------------
  // 7. Grouping Acceptance Test Suite (Section 3.5)
  // --------------------------------------------------------------------------
  describe('Grouping Acceptance Test Suite (Section 3.5)', () => {
    it('accurately groups complex repositories with cross-area, internal, isolated, and similar-name areas', () => {
      const nodes: FileNode[] = [
        // Area 1: frontend/src/components
        makeNode('fc1', 'frontend/src/components/Button.tsx', 1, 0),
        makeNode('fc2', 'frontend/src/components/Card.tsx', 2, 0),
        // Area 2: frontend/src/utils
        makeNode('fu1', 'frontend/src/utils/math.ts', 0, 2),
        makeNode('fu2', 'frontend/src/utils/strings.ts', 0, 1),
        // Area 3: backend/src/api
        makeNode('ba1', 'backend/src/api/server.ts', 1, 0),
        // Area 4: backend/src/db
        makeNode('bd1', 'backend/src/db/connection.ts', 0, 1),
        // Area 5: isolated area with similar name: frontend/src/components-v2
        makeNode('fcv1', 'frontend/src/components-v2/NewButton.tsx', 0, 0),
      ];

      const edges: DependencyEdge[] = [
        // fc1 imports fu1
        {
          id: 'fc1->fu1',
          source_file_id: 'fc1',
          target_file_id: 'fu1',
          relationship_kind: 'Import',
          resolution_status: 'ResolvedInternal',
          evidence: [
            {
              source_file_id: 'fc1',
              import_specifier: '../utils/math',
              line: 1,
              column: 1,
              relationship_kind: 'Import',
              is_type_only: false,
            },
          ],
        },
        // fc2 imports fu1 and fu2
        {
          id: 'fc2->fu1',
          source_file_id: 'fc2',
          target_file_id: 'fu1',
          relationship_kind: 'Import',
          resolution_status: 'ResolvedInternal',
          evidence: [
            {
              source_file_id: 'fc2',
              import_specifier: '../utils/math',
              line: 2,
              column: 1,
              relationship_kind: 'Import',
              is_type_only: false,
            },
          ],
        },
        {
          id: 'fc2->fu2',
          source_file_id: 'fc2',
          target_file_id: 'fu2',
          relationship_kind: 'Import',
          resolution_status: 'ResolvedInternal',
          evidence: [
            {
              source_file_id: 'fc2',
              import_specifier: '../utils/strings',
              line: 3,
              column: 1,
              relationship_kind: 'Import',
              is_type_only: false,
            },
          ],
        },
        // ba1 imports bd1
        {
          id: 'ba1->bd1',
          source_file_id: 'ba1',
          target_file_id: 'bd1',
          relationship_kind: 'Import',
          resolution_status: 'ResolvedInternal',
          evidence: [
            {
              source_file_id: 'ba1',
              import_specifier: '../db/connection',
              line: 1,
              column: 1,
              relationship_kind: 'Import',
              is_type_only: false,
            },
          ],
        },
      ];

      const structure = deriveRepositoryStructure(nodes, edges);

      // 1. Correct area membership
      expect(structure.fileToAreaId.get('fc1')).toBe('frontend/src/components');
      expect(structure.fileToAreaId.get('fc2')).toBe('frontend/src/components');
      expect(structure.fileToAreaId.get('fu1')).toBe('frontend/src/utils');
      expect(structure.fileToAreaId.get('fu2')).toBe('frontend/src/utils');
      expect(structure.fileToAreaId.get('ba1')).toBe('backend/src/api');
      expect(structure.fileToAreaId.get('bd1')).toBe('backend/src/db');
      expect(structure.fileToAreaId.get('fcv1')).toBe('frontend/src/components-v2');

      // Verify similar names do not collide or merge incorrectly
      expect(structure.areaMap.has('frontend/src/components')).toBe(true);
      expect(structure.areaMap.has('frontend/src/components-v2')).toBe(true);
      expect(structure.areaMap.get('frontend/src/components')?.fileCount).toBe(2);
      expect(structure.areaMap.get('frontend/src/components-v2')?.fileCount).toBe(1);

      // 2. Correct aggregate edge counts
      const componentsToUtilsEdge = structure.areaEdges.find(
        (e) => e.sourceAreaId === 'frontend/src/components' && e.targetAreaId === 'frontend/src/utils'
      );
      expect(componentsToUtilsEdge).toBeDefined();
      expect(componentsToUtilsEdge?.edgeCount).toBe(3); // 3 total edges
      expect(componentsToUtilsEdge?.sourceFilesCount).toBe(2); // fc1 and fc2
      expect(componentsToUtilsEdge?.targetFilesCount).toBe(2); // fu1 and fu2

      // 3. Correct relationship direction
      expect(componentsToUtilsEdge?.sourceAreaId).toBe('frontend/src/components');
      expect(componentsToUtilsEdge?.targetAreaId).toBe('frontend/src/utils');

      // 4. Correct source evidence preserved
      expect(componentsToUtilsEdge?.contributingFilePairs.length).toBe(3);
      expect(componentsToUtilsEdge?.contributingFilePairs[0].evidenceSpecifier).toBe('../utils/math');

      // 5. Isolated area has 0 area edges
      const isolatedArea = structure.areaMap.get('frontend/src/components-v2');
      expect(isolatedArea?.outgoingAreaEdges.length).toBe(0);
      expect(isolatedArea?.incomingAreaEdges.length).toBe(0);

      // 6. No fabricated area relationships (e.g. no connection between frontend and backend)
      const fabricatedEdge = structure.areaEdges.find(
        (e) =>
          (e.sourceAreaId.startsWith('frontend') && e.targetAreaId.startsWith('backend')) ||
          (e.sourceAreaId.startsWith('backend') && e.targetAreaId.startsWith('frontend'))
      );
      expect(fabricatedEdge).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // 8. Screen-Space Spatial Hash Collision Grid & Label Priority (Section 5)
  // --------------------------------------------------------------------------
  describe('Screen-Space Spatial Hash & Label Priority Scoring (Section 5)', () => {
    it('detects collisions accurately and isolates checks by grid cell', () => {
      const grid = new LabelCollisionGrid(80);

      const rect1 = { x1: 100, y1: 100, x2: 180, y2: 120 };
      const rect2Overlapping = { x1: 150, y1: 110, x2: 230, y2: 130 };
      const rect3FarAway = { x1: 500, y1: 500, x2: 580, y2: 520 };

      grid.insert(rect1);

      expect(grid.collides(rect2Overlapping)).toBe(true);
      expect(grid.collides(rect3FarAway)).toBe(false);

      grid.insert(rect3FarAway);
      expect(grid.collides({ x1: 510, y1: 510, x2: 570, y2: 530 })).toBe(true);
    });

    it('scores selected, hovered, and foreground nodes with higher priority than background nodes', () => {
      const selectedScore = computeLabelPriorityScore({
        isSelected: true,
        isHovered: false,
        isConnectedToSelected: false,
        isInFocusedArea: false,
        projectedZ: -30, // even in background!
        depthScale: 0.8,
        totalDegree: 2,
      });

      const backgroundScore = computeLabelPriorityScore({
        isSelected: false,
        isHovered: false,
        isConnectedToSelected: false,
        isInFocusedArea: false,
        projectedZ: -80,
        depthScale: 0.7,
        totalDegree: 10,
      });

      const foregroundScore = computeLabelPriorityScore({
        isSelected: false,
        isHovered: false,
        isConnectedToSelected: false,
        isInFocusedArea: false,
        projectedZ: 80,
        depthScale: 1.2,
        totalDegree: 2,
      });

      // Selected node must beat background and regular foreground
      expect(selectedScore).toBeGreaterThan(foregroundScore);
      expect(selectedScore).toBeGreaterThan(backgroundScore);

      // Regular foreground node must beat background node
      expect(foregroundScore).toBeGreaterThan(backgroundScore);
    });
  });

  // --------------------------------------------------------------------------
  // 9. Semantic Relationship Descriptions (Section 8.4)
  // --------------------------------------------------------------------------
  describe('Semantic Edge Explanations (Section 8.4)', () => {
    it('distinguishes Re-export, DynamicImport, TypeOnly, and Direct Import accurately', () => {
      const baseEdge = (kind: RelationshipKind, isTypeOnly = false): DependencyEdge => ({
        id: 'a->b',
        source_file_id: 'src/a.ts',
        target_file_id: 'src/b.ts',
        relationship_kind: kind,
        resolution_status: 'ResolvedInternal',
        evidence: [
          {
            source_file_id: 'src/a.ts',
            import_specifier: './b',
            line: 1,
            column: 1,
            relationship_kind: kind,
            is_type_only: isTypeOnly,
          },
        ],
      });

      expect(getEdgeRelationshipSentence(baseEdge('Export'))).toBe(
        '"src/a.ts" re-exports from "src/b.ts".'
      );
      expect(getEdgeRelationshipSentence(baseEdge('DynamicImport'))).toBe(
        '"src/a.ts" dynamically imports "src/b.ts".'
      );
      expect(getEdgeRelationshipSentence(baseEdge('TypeOnly', true))).toBe(
        '"src/a.ts" imports type definitions from "src/b.ts".'
      );
      expect(getEdgeRelationshipSentence(baseEdge('Import', false))).toBe(
        '"src/a.ts" directly imports from "src/b.ts".'
      );
    });
  });

  // --------------------------------------------------------------------------
  // 10. Multiple Entry Candidates and Library Roots (Section 6)
  // --------------------------------------------------------------------------
  describe('Multiple Entry Candidates & Crate Roots (Section 6)', () => {
    it('identifies multiple candidates across client, server, and library crate roots', () => {
      const nodes: FileNode[] = [
        makeNode('1', 'src/main.rs', 0, 0, 'rust'),
        makeNode('2', 'crates/core/src/lib.rs', 0, 0, 'rust'),
        makeNode('3', 'frontend/src/main.tsx', 0, 0, 'tsx'),
        makeNode('4', 'src/utils/math.ts', 0, 0, 'typescript'),
      ];

      const candidates = findEntryPointCandidates(nodes);
      expect(candidates.length).toBe(3);

      const mainRs = candidates.find((c) => c.relativePath === 'src/main.rs');
      expect(mainRs).toBeDefined();
      expect(mainRs?.kind).toBe('executable-startup');

      const libRs = candidates.find((c) => c.relativePath === 'crates/core/src/lib.rs');
      expect(libRs).toBeDefined();
      expect(libRs?.kind).toBe('library-crate-root');
      expect(libRs?.displayTitle).toBe('Library Crate Root Candidate');

      const frontendMain = candidates.find((c) => c.relativePath === 'frontend/src/main.tsx');
      expect(frontendMain).toBeDefined();
      expect(frontendMain?.kind).toBe('nested-app-root');
    });
  });
});
