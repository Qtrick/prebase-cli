import { describe, it, expect } from 'vitest';
import { layoutOrganic } from '../layout/organicLayout';
import { layoutSphere } from '../layout/sphereLayout';
import { minimumShellRadius } from '../layout/networkNormalization';
import { projectPoint3D, computeNetworkVisualRadius, computeGraphCentroid } from '../render/networkRenderMath';
import { resolveNetworkEdgeVisual } from '../render/networkEdgeVisual';
import { FileNode } from '../../../types/graph';

describe('Network Layout & Render Math', () => {
  it('computes deterministic organic positions', () => {
    const nodes = [
      { id: 'a', val: 5, isEntry: true },
      { id: 'b', val: 2 },
      { id: 'c', val: 1 },
    ];
    const links = [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ];

    const pos1 = layoutOrganic(nodes, links);
    const pos2 = layoutOrganic(nodes, links);

    expect(pos1.size).toBe(3);
    for (const [id, pt] of pos1) {
      const pt2 = pos2.get(id);
      expect(pt2).toBeDefined();
      expect(pt.x).toBeCloseTo(pt2!.x, 4);
      expect(pt.y).toBeCloseTo(pt2!.y, 4);
      expect(pt.z).toBeCloseTo(pt2!.z, 4);
    }
  });

  it('projects 3D points with perspective scaling', () => {
    const p1 = projectPoint3D(0, 0, -200);
    const p2 = projectPoint3D(0, 0, 200);

    // Objects closer (smaller z or negative z depending on camera) should have larger depthScale
    expect(p1.depthScale).toBeGreaterThan(p2.depthScale);
  });

  it('resolves edge visuals accurately for highlighted vs normal edges', () => {
    const edge = {
      id: 'a->b',
      source_file_id: 'a',
      target_file_id: 'b',
      relationship_kind: 'Import' as const,
      resolution_status: 'ResolvedInternal' as const,
      evidence: [],
    };

    const normalDesc = resolveNetworkEdgeVisual(edge, false, null, 1.0);
    expect(normalDesc).toBeDefined();
    expect(normalDesc?.alpha).toBeLessThan(1.0);

    const highlightDesc = resolveNetworkEdgeVisual(edge, true, 'a', 1.0);
    expect(highlightDesc).toBeDefined();
    expect(highlightDesc?.color).toBe('#2dd4bf');
    expect(highlightDesc?.alpha).toBe(1.0);
  });

  it('calculates node radius with zoom compensation', () => {
    const node: FileNode = {
      id: 'src/index.ts',
      relative_path: 'src/index.ts',
      filename: 'index.ts',
      language: 'typescript',
      size_bytes: 500,
      file_kind: 'Source',
      analysis_status: 'Analyzed',
      direct_dependency_count: 5,
      direct_dependent_count: 2,
    };

    const rZoomedOut = computeNetworkVisualRadius(node, 1.0, { zoom: 0.5 });
    const rZoomedIn = computeNetworkVisualRadius(node, 1.0, { zoom: 2.0 });

    // World-space radius should be larger when zoomed out so it stays legible
    expect(rZoomedOut).toBeGreaterThan(rZoomedIn);
  });

  it('layoutOrganic strictly preserves existing coordinates when re-running without new nodes', () => {
    const existingNodes = [
      { id: 'node-1', val: 5 },
      { id: 'node-2', val: 3 },
      { id: 'node-3', val: 2 },
    ];
    const existingLinks = [
      { source: 'node-1', target: 'node-2' },
      { source: 'node-2', target: 'node-3' },
    ];

    const initialPositions = layoutOrganic(existingNodes, existingLinks);

    // When existingPositions is passed and no new nodes are added, positions are strictly preserved
    const rerunPositions = layoutOrganic(existingNodes, existingLinks, undefined, initialPositions);
    expect(rerunPositions.size).toBe(3);

    for (const [id, originalPos] of initialPositions) {
      const rerunPos = rerunPositions.get(id);
      expect(rerunPos).toBeDefined();
      expect(rerunPos!.x).toBe(originalPos.x);
      expect(rerunPos!.y).toBe(originalPos.y);
      expect(rerunPos!.z).toBe(originalPos.z);
    }
  });

  it('layoutOrganic with existingPositions places new nodes near connected neighbors while preserving layout stability', () => {
    const initialNodes = [
      { id: 'auth-service', val: 10, isEntry: true },
      { id: 'user-db', val: 6 },
      { id: 'metrics', val: 2 },
    ];
    const initialLinks = [
      { source: 'auth-service', target: 'user-db' },
      { source: 'auth-service', target: 'metrics' },
    ];

    const initialPositions = layoutOrganic(initialNodes, initialLinks);
    const authPos = initialPositions.get('auth-service')!;
    const dbPos = initialPositions.get('user-db')!;
    const metricsPos = initialPositions.get('metrics')!;

    // Introduce a new node connected ONLY to user-db
    const updatedNodes = [
      ...initialNodes,
      { id: 'user-cache', val: 3 },
    ];
    const updatedLinks = [
      ...initialLinks,
      { source: 'user-db', target: 'user-cache' },
    ];

    // Layout WITH existingPositions:
    const incrementalPositions = layoutOrganic(updatedNodes, updatedLinks, undefined, initialPositions);
    expect(incrementalPositions.size).toBe(4);

    const newCachePos = incrementalPositions.get('user-cache')!;
    const incDbPos = incrementalPositions.get('user-db')!;
    const incAuthPos = incrementalPositions.get('auth-service')!;
    const incMetricsPos = incrementalPositions.get('metrics')!;

    // 1. Existing nodes that do not interact with the new node remain strictly unchanged
    // metrics is not linked to user-cache and is far from it
    expect(incMetricsPos.x).toBeCloseTo(metricsPos.x, 1);
    expect(incMetricsPos.y).toBeCloseTo(metricsPos.y, 1);
    expect(incMetricsPos.z).toBeCloseTo(metricsPos.z, 1);

    // 2. Connected existing nodes maintain high spatial stability (preserved orientation, delta < 1.5 units)
    expect(Math.hypot(incDbPos.x - dbPos.x, incDbPos.y - dbPos.y)).toBeLessThan(1.5);
    expect(Math.hypot(incAuthPos.x - authPos.x, incAuthPos.y - authPos.y)).toBeLessThan(1.5);

    // 3. New node is placed in immediate proximity to its connected neighbor (user-db)
    const distToConnectedNeighbor = Math.hypot(
      newCachePos.x - incDbPos.x,
      newCachePos.y - incDbPos.y,
      newCachePos.z - incDbPos.z
    );
    const distToFarNode = Math.hypot(
      newCachePos.x - incAuthPos.x,
      newCachePos.y - incAuthPos.y,
      newCachePos.z - incAuthPos.z
    );

    // Connected neighbor distance should be significantly smaller than distance to far nodes
    expect(distToConnectedNeighbor).toBeLessThan(distToFarNode);
    expect(distToConnectedNeighbor).toBeLessThan(60);

    // 4. Contrast: re-computing from scratch without existingPositions causes drastic layout churn
    const scratchPositions = layoutOrganic(updatedNodes, updatedLinks);
    const scratchDbPos = scratchPositions.get('user-db')!;

    // Recomputing from scratch yields completely shifted coordinates across the global sphere
    const scratchShift = Math.hypot(
      scratchDbPos.x - dbPos.x,
      scratchDbPos.y - dbPos.y,
      scratchDbPos.z - dbPos.z
    );
    expect(scratchShift).toBeGreaterThan(15);
  });

  describe('Sphere Layout & Mathematical Precision', () => {
    it('centers 3D centroid precisely at (0, 0, 0)', () => {
      const nodes = Array.from({ length: 40 }, (_, i) => ({ id: `node-${i}` }));
      const links = Array.from({ length: 39 }, (_, i) => ({
        source: `node-${i}`,
        target: `node-${i + 1}`,
      }));

      const positions = layoutSphere(nodes, links);
      const centroid = computeGraphCentroid(positions.values());

      expect(centroid.x).toBeCloseTo(0, 5);
      expect(centroid.y).toBeCloseTo(0, 5);
      expect(centroid.z).toBeCloseTo(0, 5);
    });

    it('distributes nodes along a Fibonacci spherical shell bounded by minimumShellRadius', () => {
      const n = 50;
      const collisionRadius = 24;
      const minRadius = minimumShellRadius(n, collisionRadius * 2);

      const nodes = Array.from({ length: n }, (_, i) => ({ id: `node-${i}` }));
      const positions = layoutSphere(nodes, [], { collisionRadius });

      expect(positions.size).toBe(n);
      for (const pt of positions.values()) {
        const dist = Math.hypot(pt.x, pt.y, pt.z);
        // All nodes are distributed on or near the spherical shell
        expect(dist).toBeGreaterThan(minRadius * 0.5);
        expect(dist).toBeLessThan(minRadius * 2.5);
      }
    });

    it('preserves existing positions strictly on incremental revision', () => {
      const nodes1 = [
        { id: 'app', val: 5 },
        { id: 'lib', val: 3 },
        { id: 'util', val: 2 },
      ];
      const links1 = [{ source: 'app', target: 'lib' }];
      const pos1 = layoutSphere(nodes1, links1);

      const nodes2 = [...nodes1, { id: 'new-module', val: 1 }];
      const links2 = [...links1, { source: 'lib', target: 'new-module' }];
      const pos2 = layoutSphere(nodes2, links2, undefined, pos1);

      expect(pos2.size).toBe(4);
      for (const node of nodes1) {
        const p1 = pos1.get(node.id)!;
        const p2 = pos2.get(node.id)!;
        expect(p2.x).toBe(p1.x);
        expect(p2.y).toBe(p1.y);
        expect(p2.z).toBe(p1.z);
      }
    });
  });
});

