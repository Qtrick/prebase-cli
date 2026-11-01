import { describe, it, expect } from 'vitest';
import { computeRelationshipLayout } from '../relationshipLayout';
import { deriveRelationshipGraph } from '../deriveRelationshipGraph';
import { FileNode, GraphSnapshot, DependencyEdge } from '../../../types/graph';

const makeNode = (id: string, path = `${id}.ts`): FileNode => ({
  id,
  relative_path: path,
  filename: path.split('/').pop() || path,
  language: 'typescript',
  size_bytes: 150,
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
  repository_id: 'test-layout',
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

describe('computeRelationshipLayout', () => {
  const desktopViewport = { width: 1200, height: 800 };

  describe('Column Positions and Monotonic Ordering', () => {
    it('positions columns with strictly monotonic X coordinates (-2 < -1 < 0 < 1 < 2)', () => {
      // 5-column graph: d2 -> d1 -> f -> m1 -> m2
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
      const graphData = deriveRelationshipGraph(snapshot, 'f', { depth: 2, direction: 'both' });

      const layout = computeRelationshipLayout(graphData, desktopViewport);

      expect(layout.isVertical).toBe(false);
      expect(layout.nodes).toHaveLength(5);

      const nodeD2 = layout.nodes.find((n) => n.id === 'd2')!;
      const nodeD1 = layout.nodes.find((n) => n.id === 'd1')!;
      const nodeF = layout.nodes.find((n) => n.id === 'f')!;
      const nodeM1 = layout.nodes.find((n) => n.id === 'm1')!;
      const nodeM2 = layout.nodes.find((n) => n.id === 'm2')!;

      // Column spacing is 270px
      expect(nodeD2.x).toBe(-540);
      expect(nodeD1.x).toBe(-270);
      expect(nodeF.x).toBe(0);
      expect(nodeM1.x).toBe(270);
      expect(nodeM2.x).toBe(540);

      // Strictly monotonic ordering from Dependents to Focus to Dependencies
      expect(nodeD2.x).toBeLessThan(nodeD1.x);
      expect(nodeD1.x).toBeLessThan(nodeF.x);
      expect(nodeF.x).toBeLessThan(nodeM1.x);
      expect(nodeM1.x).toBeLessThan(nodeM2.x);
    });
  });

  describe('Card Dimensions and Port Positions', () => {
    it('sets prominent dimensions for focus card and standard dimensions for neighbor cards', () => {
      const nodes = [
        makeNode('d1', 'src/d1.ts'),
        makeNode('f', 'src/f.ts'),
        makeNode('m1', 'src/m1.ts'),
      ];
      const edges = [makeEdge('d1', 'f'), makeEdge('f', 'm1')];
      const snapshot = makeSnapshot(nodes, edges);
      const graphData = deriveRelationshipGraph(snapshot, 'f');

      const layout = computeRelationshipLayout(graphData, desktopViewport);

      const focusNode = layout.nodes.find((n) => n.id === 'f')!;
      const neighborNode = layout.nodes.find((n) => n.id === 'm1')!;

      // Focus card is wider and taller (230x56 vs 196x44)
      expect(focusNode.isFocus).toBe(true);
      expect(focusNode.width).toBe(230);
      expect(focusNode.height).toBe(56);

      expect(neighborNode.isFocus).toBe(false);
      expect(neighborNode.width).toBe(196);
      expect(neighborNode.height).toBe(44);

      // Horizontal ports: inPort at left edge, outPort at right edge, centered vertically
      expect(focusNode.inPort.x).toBe(focusNode.x - focusNode.width / 2);
      expect(focusNode.inPort.y).toBe(focusNode.y);
      expect(focusNode.outPort.x).toBe(focusNode.x + focusNode.width / 2);
      expect(focusNode.outPort.y).toBe(focusNode.y);

      expect(neighborNode.inPort.x).toBe(neighborNode.x - neighborNode.width / 2);
      expect(neighborNode.outPort.x).toBe(neighborNode.x + neighborNode.width / 2);
    });
  });

  describe('Edge Routing and Bezier Control Points', () => {
    it('routes standard forward edges from left outPort to right inPort with smooth S-curves', () => {
      const nodes = [makeNode('d1', 'src/d1.ts'), makeNode('f', 'src/f.ts')];
      const edges = [makeEdge('d1', 'f')];
      const snapshot = makeSnapshot(nodes, edges);
      const graphData = deriveRelationshipGraph(snapshot, 'f');

      const layout = computeRelationshipLayout(graphData, desktopViewport);
      expect(layout.edges).toHaveLength(1);

      const edge = layout.edges[0];
      const src = layout.nodes.find((n) => n.id === 'd1')!;
      const tgt = layout.nodes.find((n) => n.id === 'f')!;

      expect(edge.startX).toBe(src.outPort.x);
      expect(edge.startY).toBe(src.outPort.y);
      expect(edge.endX).toBe(tgt.inPort.x);
      expect(edge.endY).toBe(tgt.inPort.y);

      // S-curve control points extend horizontally
      expect(edge.cp1X).toBeGreaterThan(edge.startX);
      expect(edge.cp2X).toBeLessThan(edge.endX);
      expect(edge.startX).toBeLessThan(edge.endX);

      // Arrow angle points horizontally towards positive X
      expect(Math.abs(edge.arrowAngle)).toBeLessThan(0.3);
    });

    it('routes same-column lateral edges with tangent arrowAngle', () => {
      // Two dependents d1 and d2 where d1 also imports d2
      const nodes = [
        makeNode('d1', 'src/d1.ts'),
        makeNode('d2', 'src/d2.ts'),
        makeNode('f', 'src/f.ts'),
      ];
      const edges = [
        makeEdge('d1', 'f', 'd1->f'),
        makeEdge('d2', 'f', 'd2->f'),
        makeEdge('d1', 'd2', 'd1->d2'),
      ];
      const snapshot = makeSnapshot(nodes, edges);
      const graphData = deriveRelationshipGraph(snapshot, 'f');
      const layout = computeRelationshipLayout(graphData, desktopViewport);

      const lateralEdge = layout.edges.find((e) => e.sourceId === 'd1' && e.targetId === 'd2')!;
      expect(lateralEdge).toBeDefined();
      expect(lateralEdge.startX).toBe(lateralEdge.endX);
      const expectedAngle = Math.atan2(
        lateralEdge.endY - lateralEdge.cp2Y,
        lateralEdge.endX - lateralEdge.cp2X
      );
      expect(lateralEdge.arrowAngle).toBeCloseTo(expectedAngle, 4);
    });

    it('routes reverse cycle edges (Right -> Left) with overhead clearance arcs', () => {
      // d1 imports f, f imports m1, and m1 imports d1 (feedback cycle from right to left)
      const nodes = [
        makeNode('d1', 'src/d1.ts'),
        makeNode('f', 'src/f.ts'),
        makeNode('m1', 'src/m1.ts'),
      ];
      const edges = [
        makeEdge('d1', 'f', 'd1->f'),
        makeEdge('f', 'm1', 'f->m1'),
        makeEdge('m1', 'd1', 'm1->d1'),
      ];
      const snapshot = makeSnapshot(nodes, edges);
      const graphData = deriveRelationshipGraph(snapshot, 'f');

      const layout = computeRelationshipLayout(graphData, desktopViewport);
      expect(layout.edges).toHaveLength(3);

      const reverseEdge = layout.edges.find((e) => e.sourceId === 'm1' && e.targetId === 'd1')!;
      expect(reverseEdge).toBeDefined();

      const src = layout.nodes.find((n) => n.id === 'm1')!; // Column 1 (x = 270)
      const tgt = layout.nodes.find((n) => n.id === 'd1')!; // Column -1 (x = -270)

      // Right -> Left: starts at inPort of source (left side of m1) and connects to outPort of target (right side of d1)
      expect(reverseEdge.startX).toBe(src.inPort.x);
      expect(reverseEdge.endX).toBe(tgt.outPort.x);
      expect(reverseEdge.startX).toBeGreaterThan(reverseEdge.endX);

      // Arcs upward above cards
      const expectedArcY = Math.min(reverseEdge.startY, reverseEdge.endY) - 50;
      expect(reverseEdge.cp1Y).toBe(expectedArcY);
      expect(reverseEdge.cp2Y).toBe(expectedArcY);
    });

    it('routes self-loops above card with centered loop arc', () => {
      const nodes = [makeNode('f', 'src/f.ts')];
      const edges = [makeEdge('f', 'f', 'loop-edge')];
      const snapshot = makeSnapshot(nodes, edges);
      const graphData = deriveRelationshipGraph(snapshot, 'f');

      const layout = computeRelationshipLayout(graphData, desktopViewport);
      expect(layout.edges).toHaveLength(1);

      const loop = layout.edges[0];
      expect(loop.isSelfLoop).toBe(true);
      const focus = layout.nodes.find((n) => n.id === 'f')!;

      const loopY = focus.y - focus.height / 2;
      expect(loop.startY).toBe(loopY);
      expect(loop.endY).toBe(loopY);
      expect(loop.startX).toBe(focus.x - 24);
      expect(loop.endX).toBe(focus.x + 24);

      // Loops upward
      expect(loop.cp1Y).toBe(loopY - 40);
      expect(loop.cp2Y).toBe(loopY - 40);
      // Arrow points down into card
      expect(loop.arrowAngle).toBeCloseTo(Math.PI / 2, 4);
    });
  });

  describe('Responsive Fallback (Vertical Mode < 640px)', () => {
    it('switches to vertical layout when viewport width is below 640px threshold', () => {
      const narrowViewport = { width: 500, height: 750 };
      const nodes = [
        makeNode('d1', 'src/d1.ts'),
        makeNode('f', 'src/f.ts'),
        makeNode('m1', 'src/m1.ts'),
      ];
      const edges = [makeEdge('d1', 'f'), makeEdge('f', 'm1')];
      const snapshot = makeSnapshot(nodes, edges);
      const graphData = deriveRelationshipGraph(snapshot, 'f');

      const layout = computeRelationshipLayout(graphData, narrowViewport);

      expect(layout.isVertical).toBe(true);

      const nodeD1 = layout.nodes.find((n) => n.id === 'd1')!;
      const nodeF = layout.nodes.find((n) => n.id === 'f')!;
      const nodeM1 = layout.nodes.find((n) => n.id === 'm1')!;

      // Vertical row positioning: ROW_SPACING = 180
      // Dependents at top (negative Y), Focus at 0, Dependencies at bottom (positive Y)
      expect(nodeD1.y).toBe(-180);
      expect(nodeF.y).toBe(0);
      expect(nodeM1.y).toBe(180);

      expect(nodeD1.y).toBeLessThan(nodeF.y);
      expect(nodeF.y).toBeLessThan(nodeM1.y);

      // Ports in vertical mode: inPort at top, outPort at bottom
      expect(nodeF.inPort.y).toBe(nodeF.y - nodeF.height / 2);
      expect(nodeF.outPort.y).toBe(nodeF.y + nodeF.height / 2);
    });
  });

  describe('Bounds and Center Calculation', () => {
    it('computes accurate bounds enclosing all nodes and headers', () => {
      const nodes = [
        makeNode('d1', 'src/d1.ts'),
        makeNode('f', 'src/f.ts'),
        makeNode('m1', 'src/m1.ts'),
      ];
      const edges = [makeEdge('d1', 'f'), makeEdge('f', 'm1')];
      const snapshot = makeSnapshot(nodes, edges);
      const graphData = deriveRelationshipGraph(snapshot, 'f');

      const layout = computeRelationshipLayout(graphData, desktopViewport);
      const { bounds } = layout;

      expect(bounds.width).toBe(bounds.maxX - bounds.minX);
      expect(bounds.height).toBe(bounds.maxY - bounds.minY);
      expect(bounds.centerX).toBe((bounds.minX + bounds.maxX) / 2);
      expect(bounds.centerY).toBe((bounds.minY + bounds.maxY) / 2);

      // Every layout node must be strictly within bounds
      for (const node of layout.nodes) {
        expect(node.x - node.width / 2).toBeGreaterThanOrEqual(bounds.minX);
        expect(node.x + node.width / 2).toBeLessThanOrEqual(bounds.maxX);
        expect(node.y - node.height / 2).toBeGreaterThanOrEqual(bounds.minY);
        expect(node.y + node.height / 2).toBeLessThanOrEqual(bounds.maxY);
      }
    });

    it('returns zero bounds safely when graph is empty without producing NaN', () => {
      const emptyGraphData = deriveRelationshipGraph(null, null);
      const layout = computeRelationshipLayout(emptyGraphData, desktopViewport);

      expect(layout.nodes).toHaveLength(0);
      expect(layout.bounds).toEqual({
        minX: 0,
        maxX: 0,
        minY: 0,
        maxY: 0,
        width: 0,
        height: 0,
        centerX: 0,
        centerY: 0,
      });
      expect(Number.isNaN(layout.bounds.centerX)).toBe(false);
      expect(Number.isNaN(layout.bounds.centerY)).toBe(false);
    });
  });
});
