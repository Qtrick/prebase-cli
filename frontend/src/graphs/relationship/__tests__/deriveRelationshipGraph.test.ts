import { describe, it, expect } from 'vitest';
import { deriveRelationshipGraph } from '../deriveRelationshipGraph';
import { FileNode, GraphSnapshot, DependencyEdge } from '../../../types/graph';

const makeNode = (id: string, path = `${id}.ts`): FileNode => ({
  id,
  relative_path: path,
  filename: path.split('/').pop() || path,
  language: 'typescript',
  size_bytes: 100,
  file_kind: 'Source',
  analysis_status: 'Analyzed',
  direct_dependency_count: 0,
  direct_dependent_count: 0,
});

const makeEdge = (source: string, target: string, id = `${source}->${target}`): DependencyEdge => ({
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

describe('deriveRelationshipGraph', () => {
  describe('Directional Contract (Importer -> Imported)', () => {
    it('allocates incoming edges to Dependents (Column -1) and outgoing edges to Dependencies (Column 1)', () => {
      // D imports F (incoming to F) => D is Dependent
      // F imports M (outgoing from F) => M is Dependency
      const nodeD = makeNode('dep_d', 'src/dependent.ts');
      const nodeF = makeNode('focus_f', 'src/focus.ts');
      const nodeM = makeNode('module_m', 'src/dependency.ts');

      const edges = [
        makeEdge('dep_d', 'focus_f'),
        makeEdge('focus_f', 'module_m'),
      ];

      const snapshot = makeSnapshot([nodeD, nodeF, nodeM], edges);
      const result = deriveRelationshipGraph(snapshot, 'focus_f', { depth: 1, direction: 'both' });

      expect(result.focusNode?.id).toBe('focus_f');
      expect(result.nodes).toHaveLength(3);

      const relF = result.nodesById.get('focus_f')!;
      expect(relF.role).toBe('focus');
      expect(relF.columnIndex).toBe(0);
      expect(relF.isDirectNeighbor).toBe(false);
      expect(relF.hopDistance).toBe(0);

      const relD = result.nodesById.get('dep_d')!;
      expect(relD.role).toBe('dependent-1');
      expect(relD.columnIndex).toBe(-1);
      expect(relD.isDirectNeighbor).toBe(true);
      expect(relD.hopDistance).toBe(1);

      const relM = result.nodesById.get('module_m')!;
      expect(relM.role).toBe('dependency-1');
      expect(relM.columnIndex).toBe(1);
      expect(relM.isDirectNeighbor).toBe(true);
      expect(relM.hopDistance).toBe(1);

      // Verify Column metadata
      expect(result.columns.map((c) => c.columnIndex)).toEqual([-1, 0, 1]);
      expect(result.columns[0].title).toBe('Dependents');
      expect(result.columns[1].title).toBe('Focus File');
      expect(result.columns[2].title).toBe('Dependencies');
    });
  });

  describe('1-Hop vs 2-Hop Traversals', () => {
    it('restricts to direct neighbors when depth === 1 and excludes second-hop nodes', () => {
      // d2 -> d1 -> f -> m1 -> m2
      const nodes = [
        makeNode('d2', 'src/d2.ts'),
        makeNode('d1', 'src/d1.ts'),
        makeNode('f', 'src/f.ts'),
        makeNode('m1', 'src/m1.ts'),
        makeNode('m2', 'src/m2.ts'),
      ];
      const edges = [
        makeEdge('d2', 'd1'),
        makeEdge('d1', 'f'),
        makeEdge('f', 'm1'),
        makeEdge('m1', 'm2'),
      ];

      const snapshot = makeSnapshot(nodes, edges);
      const result = deriveRelationshipGraph(snapshot, 'f', { depth: 1, direction: 'both' });

      expect(result.depth).toBe(1);
      expect(result.nodes).toHaveLength(3); // only d1, f, m1
      expect(result.nodesById.has('d2')).toBe(false);
      expect(result.nodesById.has('m2')).toBe(false);
      expect(result.columns.map((c) => c.columnIndex)).toEqual([-1, 0, 1]);
    });

    it('discovers 2nd-hop dependents (Column -2) and dependencies (Column 2) when depth === 2', () => {
      const nodes = [
        makeNode('d2', 'src/d2.ts'),
        makeNode('d1', 'src/d1.ts'),
        makeNode('f', 'src/f.ts'),
        makeNode('m1', 'src/m1.ts'),
        makeNode('m2', 'src/m2.ts'),
      ];
      const edges = [
        makeEdge('d2', 'd1'),
        makeEdge('d1', 'f'),
        makeEdge('f', 'm1'),
        makeEdge('m1', 'm2'),
      ];

      const snapshot = makeSnapshot(nodes, edges);
      const result = deriveRelationshipGraph(snapshot, 'f', { depth: 2, direction: 'both' });

      expect(result.depth).toBe(2);
      expect(result.nodes).toHaveLength(5);

      const relD2 = result.nodesById.get('d2')!;
      expect(relD2.role).toBe('dependent-2');
      expect(relD2.columnIndex).toBe(-2);
      expect(relD2.hopDistance).toBe(2);
      expect(relD2.isDirectNeighbor).toBe(false);

      const relM2 = result.nodesById.get('m2')!;
      expect(relM2.role).toBe('dependency-2');
      expect(relM2.columnIndex).toBe(2);
      expect(relM2.hopDistance).toBe(2);
      expect(relM2.isDirectNeighbor).toBe(false);

      expect(result.columns.map((c) => c.columnIndex)).toEqual([-2, -1, 0, 1, 2]);
    });

    it('prioritizes direct hop distance so direct neighbors are not duplicated into 2nd-hop', () => {
      // f -> m1, and f -> m2, but also m1 -> m2
      // m2 is both a direct dependency of f and a 2nd-hop dependency via m1.
      // It must be placed in Column 1 (distance 1), not Column 2.
      const nodes = [
        makeNode('f', 'src/f.ts'),
        makeNode('m1', 'src/m1.ts'),
        makeNode('m2', 'src/m2.ts'),
      ];
      const edges = [
        makeEdge('f', 'm1'),
        makeEdge('f', 'm2'),
        makeEdge('m1', 'm2'),
      ];

      const snapshot = makeSnapshot(nodes, edges);
      const result = deriveRelationshipGraph(snapshot, 'f', { depth: 2, direction: 'both' });

      expect(result.nodes).toHaveLength(3);
      const relM2 = result.nodesById.get('m2')!;
      expect(relM2.role).toBe('dependency-1');
      expect(relM2.columnIndex).toBe(1);
    });
  });

  describe('Direction Filter', () => {
    const nodes = [
      makeNode('d1', 'src/d1.ts'),
      makeNode('f', 'src/f.ts'),
      makeNode('m1', 'src/m1.ts'),
    ];
    const edges = [makeEdge('d1', 'f'), makeEdge('f', 'm1')];
    const snapshot = makeSnapshot(nodes, edges);

    it('direction: "dependencies" includes only outgoing dependencies and focus', () => {
      const result = deriveRelationshipGraph(snapshot, 'f', { direction: 'dependencies' });

      expect(result.nodesById.has('d1')).toBe(false);
      expect(result.nodesById.has('f')).toBe(true);
      expect(result.nodesById.has('m1')).toBe(true);
      expect(result.columns.map((c) => c.columnIndex)).toEqual([0, 1]);
      expect(result.omission.totalDirectDependents).toBe(0);
      expect(result.omission.totalDirectDependencies).toBe(1);
    });

    it('direction: "dependents" includes only incoming dependents and focus', () => {
      const result = deriveRelationshipGraph(snapshot, 'f', { direction: 'dependents' });

      expect(result.nodesById.has('d1')).toBe(true);
      expect(result.nodesById.has('f')).toBe(true);
      expect(result.nodesById.has('m1')).toBe(false);
      expect(result.columns.map((c) => c.columnIndex)).toEqual([-1, 0]);
      expect(result.omission.totalDirectDependents).toBe(1);
      expect(result.omission.totalDirectDependencies).toBe(0);
    });
  });

  describe('Cycle and Complex Topology Handling', () => {
    it('identifies mutual circular dependencies (A -> B and B -> A)', () => {
      const nodes = [makeNode('a', 'src/a.ts'), makeNode('b', 'src/b.ts')];
      const edges = [makeEdge('a', 'b'), makeEdge('b', 'a')];
      const snapshot = makeSnapshot(nodes, edges);

      const result = deriveRelationshipGraph(snapshot, 'a');
      expect(result.edges).toHaveLength(2);

      for (const e of result.edges) {
        expect(e.isMutual).toBe(true);
        expect(e.isSelfLoop).toBe(false);
      }
    });

    it('handles self-loops (F -> F) without duplicating the focus node', () => {
      const nodes = [makeNode('f', 'src/f.ts'), makeNode('other', 'src/other.ts')];
      const edges = [
        makeEdge('f', 'f', 'self-loop'),
        makeEdge('f', 'other'),
      ];
      const snapshot = makeSnapshot(nodes, edges);

      const result = deriveRelationshipGraph(snapshot, 'f');

      // Focus node must not be in dependents or dependencies
      expect(result.nodes.filter((n) => n.node.id === 'f')).toHaveLength(1);

      const loopEdge = result.edges.find((e) => e.edge.id === 'self-loop');
      expect(loopEdge).toBeDefined();
      expect(loopEdge?.isSelfLoop).toBe(true);
      expect(loopEdge?.isDirectToFocus).toBe(true);
      expect(loopEdge?.sourceRole).toBe('focus');
      expect(loopEdge?.targetRole).toBe('focus');
    });

    it('handles complex multi-node cycles safely without infinite loops or duplicate nodes', () => {
      // f -> a -> b -> c -> f (circular loop)
      const nodes = [
        makeNode('f', 'src/f.ts'),
        makeNode('a', 'src/a.ts'),
        makeNode('b', 'src/b.ts'),
        makeNode('c', 'src/c.ts'),
      ];
      const edges = [
        makeEdge('f', 'a'),
        makeEdge('a', 'b'),
        makeEdge('b', 'c'),
        makeEdge('c', 'f'),
      ];
      const snapshot = makeSnapshot(nodes, edges);

      const result = deriveRelationshipGraph(snapshot, 'f', { depth: 2 });

      // Traversal terminates cleanly
      expect(result.focusNode?.id).toBe('f');
      expect(result.nodes.length).toBeLessThanOrEqual(4);
      const uniqueIds = new Set(result.nodes.map((n) => n.node.id));
      expect(uniqueIds.size).toBe(result.nodes.length);
    });
  });

  describe('Safety Caps & Omission Stats', () => {
    it('enforces maxNodes budget and accurately computes omission stats', () => {
      // 5 direct dependencies
      const deps = ['m1', 'm2', 'm3', 'm4', 'm5'].map((id) => makeNode(id, `src/${id}.ts`));
      const focus = makeNode('f', 'src/f.ts');
      const edges = deps.map((d) => makeEdge('f', d.id));
      const snapshot = makeSnapshot([focus, ...deps], edges);

      // maxNodes = 3 (1 focus + 2 deps kept, 3 omitted)
      const result = deriveRelationshipGraph(snapshot, 'f', { maxNodes: 3 });

      expect(result.nodes).toHaveLength(3);
      expect(result.omission.isCapped).toBe(true);
      expect(result.omission.totalDirectDependencies).toBe(5);
      expect(result.omission.omittedDirectDependencies).toBe(3);

      const depCol = result.columns.find((c) => c.role === 'dependency-1');
      expect(depCol?.omittedCount).toBe(3);
      expect(depCol?.totalCount).toBe(5);
    });

    it('enforces maxEdges budget and prioritizes edges touching focus', () => {
      const nodes = [
        makeNode('f', 'src/f.ts'),
        makeNode('d1', 'src/d1.ts'),
        makeNode('m1', 'src/m1.ts'),
      ];
      const edges = [
        makeEdge('d1', 'f', 'e-focus-1'),
        makeEdge('f', 'm1', 'e-focus-2'),
        makeEdge('d1', 'm1', 'e-lateral'),
      ];
      const snapshot = makeSnapshot(nodes, edges);

      // maxEdges = 2 (only the 2 edges touching focus should be kept)
      const result = deriveRelationshipGraph(snapshot, 'f', { maxEdges: 2 });

      expect(result.edges).toHaveLength(2);
      expect(result.omission.totalEdges).toBe(3);
      expect(result.omission.omittedEdges).toBe(1);
      expect(result.edges.every((e) => e.isDirectToFocus)).toBe(true);
    });

    it('sorts candidate nodes deterministically by relative_path when capped', () => {
      const deps = [
        makeNode('z', 'src/z.ts'),
        makeNode('a', 'src/a.ts'),
        makeNode('m', 'src/m.ts'),
      ];
      const focus = makeNode('f', 'src/f.ts');
      const edges = deps.map((d) => makeEdge('f', d.id));
      const snapshot = makeSnapshot([focus, ...deps], edges);

      // maxNodes = 2 (focus + 1 dep kept)
      const result = deriveRelationshipGraph(snapshot, 'f', { maxNodes: 2 });

      expect(result.nodes).toHaveLength(2);
      // 'src/a.ts' comes first alphabetically and must be kept
      expect(result.nodesById.has('a')).toBe(true);
      expect(result.nodesById.has('z')).toBe(false);
    });
  });

  describe('Missing, Deleted, or Disconnected Nodes', () => {
    it('returns empty graph safely when snapshot is null', () => {
      const result = deriveRelationshipGraph(null, 'f');
      expect(result.focusNode).toBeNull();
      expect(result.nodes).toHaveLength(0);
      expect(result.edges).toHaveLength(0);
      expect(result.columns).toHaveLength(0);
    });

    it('returns empty graph safely when focusNodeId is null', () => {
      const snapshot = makeSnapshot([makeNode('f')], []);
      const result = deriveRelationshipGraph(snapshot, null);
      expect(result.focusNode).toBeNull();
      expect(result.nodes).toHaveLength(0);
    });

    it('returns empty graph safely when focusNodeId does not exist in snapshot (deleted file)', () => {
      const snapshot = makeSnapshot([makeNode('other')], []);
      const result = deriveRelationshipGraph(snapshot, 'deleted_id');
      expect(result.focusNode).toBeNull();
      expect(result.nodes).toHaveLength(0);
    });

    it('handles disconnected node with zero dependencies and dependents', () => {
      const snapshot = makeSnapshot([makeNode('isolated')], []);
      const result = deriveRelationshipGraph(snapshot, 'isolated');

      expect(result.focusNode?.id).toBe('isolated');
      expect(result.nodes).toHaveLength(1);
      expect(result.edges).toHaveLength(0);
      // direction: 'both' provides 3 columns: Dependents (empty), Focus File (1 node), Dependencies (empty)
      expect(result.columns).toHaveLength(3);
      expect(result.columns[1].role).toBe('focus');
      expect(result.columns[0].nodes).toHaveLength(0);
      expect(result.columns[2].nodes).toHaveLength(0);
      expect(result.omission.isCapped).toBe(false);
    });
  });
});
