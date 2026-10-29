import { describe, it, expect } from 'vitest';
import { layoutOrganic } from '../layout/organicLayout';
import { projectPoint3D, computeNetworkVisualRadius } from '../render/networkRenderMath';
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
});
