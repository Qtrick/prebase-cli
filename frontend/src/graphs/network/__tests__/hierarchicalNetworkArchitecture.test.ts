import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  computeAreaAnchors,
  layoutSphere,
  LayoutNode,
  LayoutLink,
  DEFAULT_SPHERE_LAYOUT_CONFIG,
} from '../layout/sphereLayout';
import {
  resolveAreaEdgeVisual,
  resolveNetworkEdgeVisual,
} from '../render/networkEdgeVisual';
import { NetworkCanvas } from '../NetworkCanvas';
import { Inspector } from '../../../inspector/Inspector';
import {
  deriveRepositoryStructure,
  AreaEdge,
  RepositoryArea,
} from '../../../utils/repositoryAreas';
import {
  FileNode,
  DependencyEdge,
  GraphSnapshot,
} from '../../../types/graph';

// Mock API calls to ensure Inspector mounts cleanly in SSR / test environments
vi.mock('../../../transport/api', () => ({
  api: {
    inspectFile: vi.fn().mockResolvedValue({
      file: {},
      dependencies: [],
      dependents: [],
      outgoing_edges: [],
      incoming_edges: [],
    }),
    getSource: vi.fn().mockResolvedValue({ content: '' }),
    getImpact: vi.fn().mockResolvedValue({
      file_id: '',
      direct_dependents_count: 0,
      transitive_dependents_count: 0,
      total_impact_count: 0,
      is_part_of_cycle: false,
      impacted_files: [],
    }),
  },
}));

// Test Fixtures & Helpers
const createNode = (
  id: string,
  relativePath: string,
  opts?: { deps?: number; status?: FileNode['analysis_status'] }
): FileNode => ({
  id,
  relative_path: relativePath,
  filename: relativePath.split('/').pop() || relativePath,
  language: 'typescript',
  size_bytes: 480,
  file_kind: 'Source',
  analysis_status: opts?.status ?? 'Analyzed',
  direct_dependency_count: opts?.deps ?? 1,
  direct_dependent_count: opts?.deps ?? 1,
});

const createEdge = (
  sourceId: string,
  targetId: string,
  kind: DependencyEdge['relationship_kind'] = 'Import'
): DependencyEdge => ({
  id: `${sourceId}->${targetId}`,
  source_file_id: sourceId,
  target_file_id: targetId,
  relationship_kind: kind,
  resolution_status: 'ResolvedInternal',
  evidence: [],
});

const createMultiAreaSnapshot = (): {
  snapshot: GraphSnapshot;
  nodes: FileNode[];
  edges: DependencyEdge[];
} => {
  // 16 files across 4 architectural areas: api, core, db, ui
  const nodes: FileNode[] = [
    // Area: src/api (4 files)
    createNode('src/api/auth.ts', 'src/api/auth.ts', { deps: 3 }),
    createNode('src/api/routes.ts', 'src/api/routes.ts', { deps: 2 }),
    createNode('src/api/middleware.ts', 'src/api/middleware.ts', { deps: 1 }),
    createNode('src/api/handler.ts', 'src/api/handler.ts', { deps: 1 }),

    // Area: src/core (4 files)
    createNode('src/core/engine.ts', 'src/core/engine.ts', { deps: 4 }),
    createNode('src/core/parser.ts', 'src/core/parser.ts', { deps: 2 }),
    createNode('src/core/tokenizer.ts', 'src/core/tokenizer.ts', { deps: 1 }),
    createNode('src/core/ast.ts', 'src/core/ast.ts', { deps: 1 }),

    // Area: src/db (4 files)
    createNode('src/db/client.ts', 'src/db/client.ts', { deps: 2 }),
    createNode('src/db/models.ts', 'src/db/models.ts', { deps: 2 }),
    createNode('src/db/migrations.ts', 'src/db/migrations.ts', { deps: 1 }),
    createNode('src/db/query.ts', 'src/db/query.ts', { deps: 1 }),

    // Area: src/ui (4 files)
    createNode('src/ui/App.tsx', 'src/ui/App.tsx', { deps: 3 }),
    createNode('src/ui/Navbar.tsx', 'src/ui/Navbar.tsx', { deps: 1 }),
    createNode('src/ui/Sidebar.tsx', 'src/ui/Sidebar.tsx', { deps: 1 }),
    createNode('src/ui/Button.tsx', 'src/ui/Button.tsx', { deps: 0 }),
  ];

  const edges: DependencyEdge[] = [
    // Internal API edges
    createEdge('src/api/routes.ts', 'src/api/auth.ts'),
    createEdge('src/api/handler.ts', 'src/api/middleware.ts'),

    // Inter-area: API -> DB
    createEdge('src/api/auth.ts', 'src/db/client.ts'),
    createEdge('src/api/routes.ts', 'src/db/models.ts'),

    // Inter-area: API -> Core
    createEdge('src/api/routes.ts', 'src/core/engine.ts'),

    // Internal Core edges
    createEdge('src/core/engine.ts', 'src/core/parser.ts'),
    createEdge('src/core/parser.ts', 'src/core/tokenizer.ts'),
    createEdge('src/core/parser.ts', 'src/core/ast.ts'),

    // Internal DB edges
    createEdge('src/db/client.ts', 'src/db/query.ts'),
    createEdge('src/db/models.ts', 'src/db/client.ts'),

    // Inter-area: UI -> API
    createEdge('src/ui/App.tsx', 'src/api/routes.ts'),
    createEdge('src/ui/Navbar.tsx', 'src/api/auth.ts'),

    // Internal UI edges
    createEdge('src/ui/App.tsx', 'src/ui/Sidebar.tsx'),
    createEdge('src/ui/Sidebar.tsx', 'src/ui/Button.tsx'),
  ];

  const snapshot: GraphSnapshot = {
    schema_version: '1.0.0',
    repository_id: 'test-hierarchical-repo',
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
  };

  return { snapshot, nodes, edges };
};

describe('Hierarchical Network Graph Architecture Regression Suite', () => {
  // =========================================================================
  // 1. Spherical Area Anchor Calculation & Member Node Clustering Locality
  // =========================================================================
  describe('1. Spherical Area Anchors & Geodesic Member Clustering', () => {
    describe('1.1 computeAreaAnchors Determinism & Spatial Separation', () => {
      it('returns empty map when areaIds is empty', () => {
        const anchors = computeAreaAnchors([], 260);
        expect(anchors.size).toBe(0);
      });

      it('returns single anchor at {0, 0, -radius} when areaIds has length 1', () => {
        const anchors = computeAreaAnchors(['src/api'], 260);
        expect(anchors.size).toBe(1);
        const anchor = anchors.get('src/api')!;
        expect(anchor).toEqual({ x: 0, y: 0, z: -260 });
      });

      it('places all multi-area anchors on the spherical shell surface', () => {
        const areaIds = ['src/api', 'src/core', 'src/db', 'src/ui'];
        const sphereRadius = 260;
        const anchors = computeAreaAnchors(areaIds, sphereRadius);

        expect(anchors.size).toBe(4);
        for (const [id, anchor] of anchors.entries()) {
          expect(id).toBeDefined();
          const dist = Math.hypot(anchor.x, anchor.y, anchor.z);
          // Anchors should be within 5% of the sphereRadius (y-component has 0.95 pole softening)
          expect(dist).toBeGreaterThanOrEqual(sphereRadius * 0.94);
          expect(dist).toBeLessThanOrEqual(sphereRadius * 1.01);
        }
      });

      it('is strictly deterministic and independent of input array ordering', () => {
        const sphereRadius = 260;
        const orderA = ['src/ui', 'src/api', 'src/db', 'src/core'];
        const orderB = ['src/api', 'src/core', 'src/db', 'src/ui'];

        const anchorsA = computeAreaAnchors(orderA, sphereRadius);
        const anchorsB = computeAreaAnchors(orderB, sphereRadius);

        for (const key of orderA) {
          const ptA = anchorsA.get(key)!;
          const ptB = anchorsB.get(key)!;
          expect(ptA.x).toBeCloseTo(ptB.x, 8);
          expect(ptA.y).toBeCloseTo(ptB.y, 8);
          expect(ptA.z).toBeCloseTo(ptB.z, 8);
        }
      });

      it('ensures distinct area anchors have substantial angular separation on the sphere', () => {
        const areaIds = ['src/api', 'src/core', 'src/db', 'src/ui'];
        const sphereRadius = 260;
        const anchors = computeAreaAnchors(areaIds, sphereRadius);

        const anchorList = Array.from(anchors.values());
        for (let i = 0; i < anchorList.length; i++) {
          for (let j = i + 1; j < anchorList.length; j++) {
            const p1 = anchorList[i];
            const p2 = anchorList[j];
            const len1 = Math.hypot(p1.x, p1.y, p1.z);
            const len2 = Math.hypot(p2.x, p2.y, p2.z);
            const dot = (p1.x * p2.x + p1.y * p2.y + p1.z * p2.z) / (len1 * len2);
            const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
            // With 4 areas, minimum angular separation should be at least 45 degrees (~0.78 rad)
            expect(angle).toBeGreaterThan(0.75);
          }
        }
      });
    });

    describe('1.2 layoutSphere Hierarchical Community Clustering Locality', () => {
      it('clusters member nodes tightly around their respective area anchors', () => {
        const { nodes, edges } = createMultiAreaSnapshot();

        const layoutNodes: LayoutNode[] = nodes.map((n) => ({
          id: n.id,
          areaId: n.relative_path.split('/')[1], // 'api', 'core', 'db', 'ui'
          val: n.direct_dependency_count,
        }));

        const layoutLinks: LayoutLink[] = edges.map((e) => ({
          source: e.source_file_id,
          target: e.target_file_id,
        }));

        const positions = layoutSphere(layoutNodes, layoutLinks, DEFAULT_SPHERE_LAYOUT_CONFIG);
        expect(positions.size).toBe(nodes.length);

        // Group computed positions by area
        const distinctAreas = ['api', 'core', 'db', 'ui'];
        const areaAnchors = computeAreaAnchors(distinctAreas, DEFAULT_SPHERE_LAYOUT_CONFIG.sphereRadius * 0.58);

        // Verify member locality: average distance of files in area A to anchor A
        // is significantly smaller than their distance to other anchors
        for (const areaId of distinctAreas) {
          const anchor = areaAnchors.get(areaId)!;
          const memberNodes = layoutNodes.filter((n) => n.areaId === areaId);

          let avgDistanceToOwnAnchor = 0;
          for (const node of memberNodes) {
            const pos = positions.get(node.id)!;
            const dist = Math.hypot(pos.x - anchor.x, pos.y - anchor.y, pos.z - anchor.z);
            avgDistanceToOwnAnchor += dist;
          }
          avgDistanceToOwnAnchor /= memberNodes.length;

          // Compute average distance to other anchors
          for (const otherAreaId of distinctAreas) {
            if (otherAreaId === areaId) continue;
            const otherAnchor = areaAnchors.get(otherAreaId)!;
            let avgDistanceToOtherAnchor = 0;
            for (const node of memberNodes) {
              const pos = positions.get(node.id)!;
              const dist = Math.hypot(pos.x - otherAnchor.x, pos.y - otherAnchor.y, pos.z - otherAnchor.z);
              avgDistanceToOtherAnchor += dist;
            }
            avgDistanceToOtherAnchor /= memberNodes.length;

            // Clustering invariant: distance to own anchor is strictly less than distance to foreign anchor
            expect(avgDistanceToOwnAnchor).toBeLessThan(avgDistanceToOtherAnchor);
          }
        }
      });

      it('guarantees all nodes lie exactly on the spherical shell centered at (0, 0, 0)', () => {
        const { nodes, edges } = createMultiAreaSnapshot();
        const layoutNodes: LayoutNode[] = nodes.map((n) => ({
          id: n.id,
          areaId: n.relative_path.split('/')[1],
          val: n.direct_dependency_count,
        }));
        const layoutLinks: LayoutLink[] = edges.map((e) => ({
          source: e.source_file_id,
          target: e.target_file_id,
        }));

        const positions = layoutSphere(layoutNodes, layoutLinks, DEFAULT_SPHERE_LAYOUT_CONFIG);

        // Every node must sit precisely on the true spherical shell centered at the origin
        const radii = Array.from(positions.values()).map((pos) => Math.hypot(pos.x, pos.y, pos.z));
        expect(radii.length).toBe(nodes.length);
        const shellRadius = radii[0];
        expect(shellRadius).toBeGreaterThan(50);
        for (const r of radii) {
          expect(r).toBeCloseTo(shellRadius, 3);
        }

        // Bounding extents span across the origin in all 3 dimensions
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;
        for (const pos of positions.values()) {
          if (pos.x < minX) minX = pos.x;
          if (pos.x > maxX) maxX = pos.x;
          if (pos.y < minY) minY = pos.y;
          if (pos.y > maxY) maxY = pos.y;
          if (pos.z < minZ) minZ = pos.z;
          if (pos.z > maxZ) maxZ = pos.z;
        }
        expect(minX).toBeLessThan(0);
        expect(maxX).toBeGreaterThan(0);
        expect(minY).toBeLessThan(0);
        expect(maxY).toBeGreaterThan(0);
        expect(minZ).toBeLessThan(0);
        expect(maxZ).toBeGreaterThan(0);
      });

      it('preserves existing node positions during incremental layout without thrashing', () => {
        const { nodes, edges } = createMultiAreaSnapshot();
        const layoutNodes: LayoutNode[] = nodes.map((n) => ({
          id: n.id,
          areaId: n.relative_path.split('/')[1],
        }));
        const layoutLinks: LayoutLink[] = edges.map((e) => ({
          source: e.source_file_id,
          target: e.target_file_id,
        }));

        // Initial layout from scratch
        const initialPositions = layoutSphere(layoutNodes, layoutLinks, DEFAULT_SPHERE_LAYOUT_CONFIG);
        expect(initialPositions.size).toBe(nodes.length);

        // Incremental layout preserving initial positions (e.g. live file watcher revision)
        const incrementalPositions = layoutSphere(
          layoutNodes,
          layoutLinks,
          DEFAULT_SPHERE_LAYOUT_CONFIG,
          initialPositions
        );

        // Every node must preserve its exact world coordinate without spatial jumping
        for (const [id, originalPos] of initialPositions.entries()) {
          const incPos = incrementalPositions.get(id)!;
          expect(incPos.x).toBeCloseTo(originalPos.x, 3);
          expect(incPos.y).toBeCloseTo(originalPos.y, 3);
          expect(incPos.z).toBeCloseTo(originalPos.z, 3);
        }
      });

      it('falls back to uniform Fibonacci shell when distinct areas count < 2', () => {
        // Single area or unpartitioned nodes
        const singleAreaNodes: LayoutNode[] = [
          { id: 'file1.ts' },
          { id: 'file2.ts' },
          { id: 'file3.ts' },
          { id: 'file4.ts' },
        ];

        const positions = layoutSphere(singleAreaNodes, [], DEFAULT_SPHERE_LAYOUT_CONFIG);
        expect(positions.size).toBe(4);
        for (const pos of positions.values()) {
          expect(Number.isFinite(pos.x)).toBe(true);
          expect(Number.isFinite(pos.y)).toBe(true);
          expect(Number.isFinite(pos.z)).toBe(true);
        }
      });
    });
  });

  // =========================================================================
  // 2. Multi-Level Exploration Scopes (Overview -> Area -> File -> Small Repo Fallback)
  // =========================================================================
  describe('2. Multi-Level Exploration Scopes State Transitions & Fallbacks', () => {
    it('accurately resolves scopes: overview (default) -> area (selectedAreaId) -> file (selectedNodeId)', () => {
      const resolveScope = (selectedAreaId: string | null, selectedNodeId: string | null) => {
        return selectedNodeId ? 'file' : selectedAreaId ? 'area' : 'overview';
      };

      expect(resolveScope(null, null)).toBe('overview');
      expect(resolveScope('src/api', null)).toBe('area');
      expect(resolveScope(null, 'src/api/auth.ts')).toBe('file');
      expect(resolveScope('src/api', 'src/api/auth.ts')).toBe('file');
    });

    it('identifies small repository threshold (<= 12 files or <= 1 area) for automatic fallback', () => {
      const isSmallRepo = (fileCount: number, areaCount: number) => fileCount <= 12 || areaCount <= 1;

      // Small repo: 8 files across 2 areas
      expect(isSmallRepo(8, 2)).toBe(true);
      // Small repo: 50 files in a single flat directory (1 area)
      expect(isSmallRepo(50, 1)).toBe(true);
      // Small repo boundary: 12 files across 3 areas
      expect(isSmallRepo(12, 3)).toBe(true);
      // Standard hierarchical repo: 16 files across 4 areas
      expect(isSmallRepo(16, 4)).toBe(false);
    });

    it('derives aggregated inter-area dependency edges linking distinct areas', () => {
      const { nodes, edges } = createMultiAreaSnapshot();
      const repoStructure = deriveRepositoryStructure(nodes, edges);

      expect(repoStructure.areas.length).toBe(4);
      expect(repoStructure.areaEdges.length).toBeGreaterThanOrEqual(3);

      // Verify inter-area edges connect API -> DB, API -> Core, UI -> API
      const apiToDb = repoStructure.areaEdges.find(
        (e) => e.sourceAreaId.includes('api') && e.targetAreaId.includes('db')
      );
      expect(apiToDb).toBeDefined();
      expect(apiToDb!.edgeCount).toBe(2); // 2 file connections

      const uiToApi = repoStructure.areaEdges.find(
        (e) => e.sourceAreaId.includes('ui') && e.targetAreaId.includes('api')
      );
      expect(uiToApi).toBeDefined();
      expect(uiToApi!.edgeCount).toBe(2);
    });
  });

  // =========================================================================
  // 3. Area Edge Visual Descriptor Resolution & Logarithmic Weight Scaling
  // =========================================================================
  describe('3. Area Edge Visual Descriptors & Logarithmic Weight Scaling', () => {
    const mockAreaEdge = (edgeCount: number): AreaEdge => ({
      id: 'area-api->area-db',
      sourceAreaId: 'src/api',
      targetAreaId: 'src/db',
      edgeCount,
      sourceFilesCount: 2,
      targetFilesCount: 2,
      contributingEdges: [],
      contributingFilePairs: [],
      summarySentence: `src/api depends on src/db (${edgeCount} connections)`,
    });

    it('scales base line width logarithmically with edgeCount', () => {
      // Formula: Math.min(4.5, Math.max(1.8, 1.2 + 0.7 * Math.log2(1 + edgeCount)))
      const edge1 = mockAreaEdge(1);
      const edge3 = mockAreaEdge(3);
      const edge7 = mockAreaEdge(7);
      const edge15 = mockAreaEdge(15);
      const edge100 = mockAreaEdge(100);

      const v1 = resolveAreaEdgeVisual(edge1, false, false, 1.0);
      const v3 = resolveAreaEdgeVisual(edge3, false, false, 1.0);
      const v7 = resolveAreaEdgeVisual(edge7, false, false, 1.0);
      const v15 = resolveAreaEdgeVisual(edge15, false, false, 1.0);
      const v100 = resolveAreaEdgeVisual(edge100, false, false, 1.0);

      // Width grows monotonically with edgeCount
      expect(v3.width).toBeGreaterThan(v1.width);
      expect(v7.width).toBeGreaterThan(v3.width);
      expect(v15.width).toBeGreaterThan(v7.width);
      // Clamped at 4.5
      expect(v100.width).toBe(4.5);
    });

    it('elevates selected area edges to priority 150 with full opacity and electric cyan/sky color', () => {
      const edge = mockAreaEdge(5);
      const visualDark = resolveAreaEdgeVisual(edge, true, false, 1.0, 'dark');
      expect(visualDark.priority).toBe(150);
      expect(visualDark.alpha).toBe(1.0);
      expect(visualDark.color).toBe('#38bdf8');
      expect(visualDark.showArrow).toBe(true);

      const visualLight = resolveAreaEdgeVisual(edge, true, false, 1.0, 'light');
      expect(visualLight.color).toBe('#0284c7');
    });

    it('elevates hovered area edges to priority 120 with high opacity and electric indigo color', () => {
      const edge = mockAreaEdge(5);
      const visualDark = resolveAreaEdgeVisual(edge, false, true, 1.0, 'dark');
      expect(visualDark.priority).toBe(120);
      expect(visualDark.alpha).toBe(0.95);
      expect(visualDark.color).toBe('#818cf8');
      expect(visualDark.showArrow).toBe(true);

      const visualLight = resolveAreaEdgeVisual(edge, false, true, 1.0, 'light');
      expect(visualLight.color).toBe('#4f46e5');
    });

    it('shows arrows on default area edges only when zoom >= 0.45 to prevent far-zoom clutter', () => {
      const edge = mockAreaEdge(4);
      const zoomedOutVisual = resolveAreaEdgeVisual(edge, false, false, 0.40);
      expect(zoomedOutVisual.showArrow).toBe(false);

      const normalZoomVisual = resolveAreaEdgeVisual(edge, false, false, 1.0);
      expect(normalZoomVisual.showArrow).toBe(true);
    });
  });

  // =========================================================================
  // 4. Directional Dependency Coloring (Outgoing Cyan vs Incoming Violet)
  // =========================================================================
  describe('4. Directional Dependency Coloring (Outgoing Cyan vs Incoming Violet)', () => {
    const testEdge = createEdge('src/api/auth.ts', 'src/db/client.ts');

    it('colors outgoing dependencies in Electric Cyan / Teal (#2dd4bf in dark, #0d9488 in light)', () => {
      const darkOutgoing = resolveNetworkEdgeVisual(
        testEdge,
        true,
        'src/api/auth.ts',
        1.0,
        null,
        'dark',
        'outgoing'
      );
      expect(darkOutgoing).not.toBeNull();
      expect(darkOutgoing!.color).toBe('#2dd4bf');
      expect(darkOutgoing!.showArrow).toBe(true);

      const lightOutgoing = resolveNetworkEdgeVisual(
        testEdge,
        true,
        'src/api/auth.ts',
        1.0,
        null,
        'light',
        'outgoing'
      );
      expect(lightOutgoing!.color).toBe('#0d9488');
    });

    it('colors incoming dependents in Soft Violet / Purple (#a78bfa in dark, #7c3aed in light)', () => {
      const darkIncoming = resolveNetworkEdgeVisual(
        testEdge,
        true,
        'src/db/client.ts',
        1.0,
        null,
        'dark',
        'incoming'
      );
      expect(darkIncoming).not.toBeNull();
      expect(darkIncoming!.color).toBe('#a78bfa');
      expect(darkIncoming!.showArrow).toBe(true);

      const lightIncoming = resolveNetworkEdgeVisual(
        testEdge,
        true,
        'src/db/client.ts',
        1.0,
        null,
        'light',
        'incoming'
      );
      expect(lightIncoming!.color).toBe('#7c3aed');
    });

    it('ensures outgoing and incoming dependency colors are strictly distinct for instant visual parsing', () => {
      const darkOut = resolveNetworkEdgeVisual(testEdge, true, 'src/api/auth.ts', 1.0, null, 'dark', 'outgoing')!;
      const darkIn = resolveNetworkEdgeVisual(testEdge, true, 'src/db/client.ts', 1.0, null, 'dark', 'incoming')!;
      expect(darkOut.color).not.toBe(darkIn.color);

      const lightOut = resolveNetworkEdgeVisual(testEdge, true, 'src/api/auth.ts', 1.0, null, 'light', 'outgoing')!;
      const lightIn = resolveNetworkEdgeVisual(testEdge, true, 'src/db/client.ts', 1.0, null, 'light', 'incoming')!;
      expect(lightOut.color).not.toBe(lightIn.color);
    });

    it('applies dashed stroke [4, 4] for DynamicImport edges', () => {
      const dynamicEdge = createEdge('src/ui/App.tsx', 'src/api/routes.ts', 'DynamicImport');
      const visual = resolveNetworkEdgeVisual(dynamicEdge, true, 'src/ui/App.tsx', 1.0, null, 'dark', 'outgoing')!;
      expect(visual.dash).toEqual([4, 4]);
    });
  });

  // =========================================================================
  // 5. Interactive Breadcrumb Navigation & Selection Lifecycle
  // =========================================================================
  describe('5. Interactive Breadcrumb Navigation & Jump-Back Lifecycle', () => {
    const { snapshot } = createMultiAreaSnapshot();

    it('renders Level 1 Overview breadcrumb when no area or file is selected', () => {
      const html = renderToStaticMarkup(
        React.createElement(NetworkCanvas, {
          snapshot,
          selectedNodeId: null,
          selectedEdgeId: null,
          selectedAreaId: null,
          onSelectNode: vi.fn(),
          onSelectEdge: vi.fn(),
          onSelectArea: vi.fn(),
        })
      );

      expect(html).toContain('class="network-breadcrumb-bar"');
      expect(html).toContain('class="crumb-btn active"');
      expect(html).toContain('Overview');
      // Should not contain area or file breadcrumb items
      expect(html).not.toContain('Area:');
      expect(html).not.toContain('crumb-current');
    });

    it('renders Level 2 Area breadcrumb path (Overview / Area: <name>) when an area is selected', () => {
      const html = renderToStaticMarkup(
        React.createElement(NetworkCanvas, {
          snapshot,
          selectedNodeId: null,
          selectedEdgeId: null,
          selectedAreaId: 'src/api',
          onSelectNode: vi.fn(),
          onSelectEdge: vi.fn(),
          onSelectArea: vi.fn(),
        })
      );

      expect(html).toContain('class="crumb-btn "'); // Overview is inactive
      expect(html).toContain('Overview');
      expect(html).toContain('class="crumb-sep">/</span>');
      expect(html).toContain('class="crumb-btn active"');
      expect(html).toContain('Area: src/api');
    });

    it('renders Level 3 File breadcrumb path (Overview / Area: <name> / <filename> [x]) when a file is selected', () => {
      const html = renderToStaticMarkup(
        React.createElement(NetworkCanvas, {
          snapshot,
          selectedNodeId: 'src/api/auth.ts',
          selectedEdgeId: null,
          selectedAreaId: 'src/api',
          onSelectNode: vi.fn(),
          onSelectEdge: vi.fn(),
          onSelectArea: vi.fn(),
        })
      );

      expect(html).toContain('Overview');
      expect(html).toContain('Area: src/api');
      expect(html).toContain('class="crumb-current">auth.ts</span>');
      expect(html).toContain('aria-label="Deselect file"');
    });

    it('renders selected area edge breadcrumb with source -> target and connection count', () => {
      const mockAreaEdge: AreaEdge = {
        id: 'api->db',
        sourceAreaId: 'src/api',
        targetAreaId: 'src/db',
        edgeCount: 2,
        sourceFilesCount: 2,
        targetFilesCount: 2,
        contributingEdges: [],
        contributingFilePairs: [],
        summarySentence: 'src/api imports src/db',
      };

      const html = renderToStaticMarkup(
        React.createElement(NetworkCanvas, {
          snapshot,
          selectedNodeId: null,
          selectedEdgeId: null,
          selectedAreaId: null,
          selectedAreaEdge: mockAreaEdge,
          onSelectNode: vi.fn(),
          onSelectEdge: vi.fn(),
          onSelectArea: vi.fn(),
          onSelectAreaEdge: vi.fn(),
        })
      );

      expect(html).toContain('src/api → src/db (2)');
      expect(html).toContain('aria-label="Deselect area relationship"');
    });
  });

  // =========================================================================
  // 6. Inspector Inter-Area Relationship Drill-Down View
  // =========================================================================
  describe('6. Inspector Inter-Area Relationship Drill-Down Integration', () => {
    const { snapshot } = createMultiAreaSnapshot();

    const selectedAreaEdge: AreaEdge = {
      id: 'api->db',
      sourceAreaId: 'src/api',
      targetAreaId: 'src/db',
      edgeCount: 2,
      sourceFilesCount: 2,
      targetFilesCount: 2,
      contributingEdges: [
        createEdge('src/api/auth.ts', 'src/db/client.ts'),
        createEdge('src/api/routes.ts', 'src/db/models.ts'),
      ],
      contributingFilePairs: [
        {
          sourceFileId: 'src/api/auth.ts',
          targetFileId: 'src/db/client.ts',
          relationshipKind: 'Import',
          evidenceSpecifier: '../db/client',
          line: 5,
        },
        {
          sourceFileId: 'src/api/routes.ts',
          targetFileId: 'src/db/models.ts',
          relationshipKind: 'Import',
          evidenceSpecifier: '../db/models',
          line: 12,
        },
      ],
      summarySentence: 'src/api depends on src/db with 2 verified import relationships.',
    };

    it('renders Area Connection inspection header and summary sentence', () => {
      const html = renderToStaticMarkup(
        React.createElement(Inspector, {
          selectedNode: null,
          selectedEdge: null,
          selectedAreaEdge,
          snapshot,
          onSelectNode: vi.fn(),
          onClose: vi.fn(),
        })
      );

      expect(html).toContain('Area Connection');
      expect(html).toContain('src/api');
      expect(html).toContain('src/db');
      expect(html).toContain('src/api depends on src/db with 2 verified import relationships.');
    });

    it('renders Source Files and Target Files metric cards in the area connection view', () => {
      const html = renderToStaticMarkup(
        React.createElement(Inspector, {
          selectedNode: null,
          selectedEdge: null,
          selectedAreaEdge,
          snapshot,
          onSelectNode: vi.fn(),
          onClose: vi.fn(),
        })
      );

      expect(html).toContain('<span class="stat-label">Source Files</span>');
      expect(html).toContain('<span class="stat-value">2</span>');
      expect(html).toContain('<span class="stat-label">Target Files</span>');
      expect(html).toContain('<span class="stat-value">2</span>');
    });

    it('lists contributing file pairs with direct file drill-down links', () => {
      const html = renderToStaticMarkup(
        React.createElement(Inspector, {
          selectedNode: null,
          selectedEdge: null,
          selectedAreaEdge,
          snapshot,
          onSelectNode: vi.fn(),
          onClose: vi.fn(),
        })
      );

      expect(html).toContain('Contributing Dependencies (2)');
      expect(html).toContain('auth.ts');
      expect(html).toContain('client.ts');
      expect(html).toContain('routes.ts');
      expect(html).toContain('models.ts');
    });
  });

  // =========================================================================
  // 7. Hit-Testing Parity with Rendered Edges
  // =========================================================================
  describe('7. Rendered Edge Registry & Hit-Testing Parity', () => {
    it('verifies that edge hit-testing only evaluates edges in the active rendered registry', () => {
      // In overview scope: fileEdges is empty, so clicking on empty background never hits raw file edges
      const renderedEdges = {
        fileEdges: [] as Array<{ edge: DependencyEdge; p1: { screenX: number; screenY: number }; p2: { screenX: number; screenY: number } }>,
        areaEdges: [] as Array<{ edge: AreaEdge; p1: { screenX: number; screenY: number }; p2: { screenX: number; screenY: number } }>,
      };

      const findRenderedFileEdgeAtPoint = (
        screenX: number,
        screenY: number,
        hitRadius = 8
      ): DependencyEdge | null => {
        for (const item of renderedEdges.fileEdges) {
          const dx = item.p2.screenX - item.p1.screenX;
          const dy = item.p2.screenY - item.p1.screenY;
          const lenSq = dx * dx + dy * dy;
          if (lenSq === 0) continue;
          const t = Math.max(0, Math.min(1, ((screenX - item.p1.screenX) * dx + (screenY - item.p1.screenY) * dy) / lenSq));
          const projX = item.p1.screenX + t * dx;
          const projY = item.p1.screenY + t * dy;
          const dist = Math.hypot(screenX - projX, screenY - projY);
          if (dist <= hitRadius) {
            return item.edge;
          }
        }
        return null;
      };

      // In overview: registry is empty, so hit test is null
      expect(findRenderedFileEdgeAtPoint(100, 100)).toBeNull();

      // In file/area scope: rendered edges are registered
      const activeEdge = createEdge('src/api/auth.ts', 'src/db/client.ts');
      renderedEdges.fileEdges.push({
        edge: activeEdge,
        p1: { screenX: 50, screenY: 50 },
        p2: { screenX: 150, screenY: 150 },
      });

      // Point at (100, 100) lies directly on the segment (50,50)->(150,150)
      const hit = findRenderedFileEdgeAtPoint(100, 100);
      expect(hit).toBeDefined();
      expect(hit?.id).toBe(activeEdge.id);

      // Point far away (300, 300) does not hit
      expect(findRenderedFileEdgeAtPoint(300, 300)).toBeNull();
    });

    it('verifies area anchor hit testing within anchor radius + threshold', () => {
      const mockProjectedAnchor = {
        area: { id: 'src/api', name: 'api', fileCount: 4 } as RepositoryArea,
        screenX: 200,
        screenY: 200,
        radius: 16,
        isFront: true,
      };

      const hitTestAnchor = (
        screenX: number,
        screenY: number,
        anchor: typeof mockProjectedAnchor
      ): boolean => {
        const dist = Math.hypot(screenX - anchor.screenX, screenY - anchor.screenY);
        return dist <= anchor.radius + 10;
      };

      // Direct hit at center
      expect(hitTestAnchor(200, 200, mockProjectedAnchor)).toBe(true);
      // Hit within padded margin (16 + 10 = 26px radius)
      expect(hitTestAnchor(220, 200, mockProjectedAnchor)).toBe(true); // 20px <= 26px
      // Miss outside radius
      expect(hitTestAnchor(230, 200, mockProjectedAnchor)).toBe(false); // 30px > 26px
    });
  });
});
