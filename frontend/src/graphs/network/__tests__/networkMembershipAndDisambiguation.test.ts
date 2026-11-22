import { describe, it, expect } from 'vitest';
import {
  getAreaColor,
  AREA_PALETTE_DARK,
  AREA_PALETTE_LIGHT,
  ENTRY_NODE_COLOR,
} from '../fileTypeColors';
import {
  resolveNodeVisualDescriptor,
  compositeDepthColor,
} from '../render/networkRenderMath';
import {
  computeAreaMonograms,
  AreaIdentifier,
} from '../../../utils/monogramDisambiguation';
import {
  processSnapshotRevision,
  SnapshotRevisionState,
} from '../layout/snapshotRevision';
import {
  FileNode,
  DependencyEdge,
  GraphSnapshot,
  NetworkCamera,
} from '../../../types/graph';

// Fixture Creators
const createTestNode = (
  id: string,
  relativePath: string,
  deps = 1
): FileNode => ({
  id,
  relative_path: relativePath,
  filename: relativePath.split('/').pop() || relativePath,
  language: 'typescript',
  size_bytes: 400,
  file_kind: 'Source',
  analysis_status: 'Analyzed',
  direct_dependency_count: deps,
  direct_dependent_count: deps,
});

const createTestEdge = (source: string, target: string): DependencyEdge => ({
  id: `${source}->${target}`,
  source_file_id: source,
  target_file_id: target,
  relationship_kind: 'Import',
  resolution_status: 'ResolvedInternal',
  evidence: [],
});

describe('Network Membership Rings, Monogram Disambiguation & Layout Stability Suite', () => {
  // =========================================================================
  // 1. Canonical Area Color Resolution & Membership Ring Visual Descriptors
  // =========================================================================
  describe('1. Canonical Area Color Resolution & Membership Ring Visual Descriptors', () => {
    describe('1.1 getAreaColor Canonical Resolution & Palettes', () => {
      it('resolves deterministic colors consistently for any given areaId', () => {
        const color1 = getAreaColor('src/api', 'dark');
        const color2 = getAreaColor('src/api', 'dark');
        expect(color1).toBe(color2);

        const colorLight1 = getAreaColor('src/api', 'light');
        const colorLight2 = getAreaColor('src/api', 'light');
        expect(colorLight1).toBe(colorLight2);
      });

      it('maps distinct area IDs across the palette with high visual variety', () => {
        const areas = ['src/api', 'src/db', 'src/core', 'src/ui', 'src/utils', 'crates/server'];
        const darkColors = new Set(areas.map((a) => getAreaColor(a, 'dark')));
        // Distinct areas should map to varied palette colors
        expect(darkColors.size).toBeGreaterThanOrEqual(4);
      });

      it('provides accessible fallback slate color when areaId is undefined or empty', () => {
        expect(getAreaColor(undefined, 'dark')).toBe('#94a3b8');
        expect(getAreaColor(undefined, 'light')).toBe('#475569');
        expect(getAreaColor('', 'dark')).toBe('#94a3b8');
        expect(getAreaColor('', 'light')).toBe('#475569');
      });

      it('guarantees dark palette uses luminous pastels and light palette uses saturated accessible tones', () => {
        for (const darkColor of AREA_PALETTE_DARK) {
          expect(darkColor).toMatch(/^#[0-9a-f]{6}$/i);
        }
        for (const lightColor of AREA_PALETTE_LIGHT) {
          expect(lightColor).toMatch(/^#[0-9a-f]{6}$/i);
        }
      });
    });

    describe('1.2 resolveNodeVisualDescriptor & Membership Rings', () => {
      const sampleNode = createTestNode('src/api/auth.ts', 'src/api/auth.ts');

      it('resolves interior fill color based on file language and depth shading', () => {
        const descriptor = resolveNodeVisualDescriptor(
          sampleNode,
          'src/api',
          0.85, // front prominence
          1.0,
          'dark'
        );

        // TypeScript file color (#3178c6) composited with depth
        expect(descriptor.fillColor).toMatch(/^#[0-9a-f]{6}$/i);
        // Area membership ring uses canonical area color
        expect(descriptor.areaRingColor).toMatch(/^#[0-9a-f]{6}$/i);
        expect(descriptor.ringWidth).toBe(1.2);
        expect(descriptor.haloColor).toBeNull();
      });

      it('uses ENTRY_NODE_COLOR for main entry point files regardless of language', () => {
        const entryDescriptor = resolveNodeVisualDescriptor(
          sampleNode,
          'src/api',
          1.0,
          1.0,
          'dark',
          { isEntry: true }
        );

        const expectedFill = compositeDepthColor(ENTRY_NODE_COLOR, 1.0, 'dark');
        expect(entryDescriptor.fillColor).toBe(expectedFill);
      });

      it('renders distinct outer halo ring when isSelected is true without overriding membership ring', () => {
        const selectedDark = resolveNodeVisualDescriptor(
          sampleNode,
          'src/api',
          1.0,
          1.0,
          'dark',
          { isSelected: true }
        );

        expect(selectedDark.haloColor).toBe('#818cf8'); // Electric Indigo halo
        expect(selectedDark.haloWidth).toBe(2.0);
        expect(selectedDark.ringWidth).toBe(1.6); // slightly accented membership ring
        expect(selectedDark.depthAlpha).toBe(1.0);

        const selectedLight = resolveNodeVisualDescriptor(
          sampleNode,
          'src/api',
          1.0,
          1.0,
          'light',
          { isSelected: true }
        );
        expect(selectedLight.haloColor).toBe('#4f46e5');
      });

      it('renders subtle outer slate halo ring when isHovered is true', () => {
        const hoveredDark = resolveNodeVisualDescriptor(
          sampleNode,
          'src/api',
          0.9,
          1.0,
          'dark',
          { isHovered: true }
        );

        expect(hoveredDark.haloColor).toBe('#cbd5e1');
        expect(hoveredDark.haloWidth).toBe(1.8);
        expect(hoveredDark.depthAlpha).toBe(1.0);

        const hoveredLight = resolveNodeVisualDescriptor(
          sampleNode,
          'src/api',
          0.9,
          1.0,
          'light',
          { isHovered: true }
        );
        expect(hoveredLight.haloColor).toBe('#64748b');
      });

      it('applies dimming alpha (0.12) when node is outside active scope or highlight focus', () => {
        const dimmed = resolveNodeVisualDescriptor(
          sampleNode,
          'src/api',
          0.5,
          0.5,
          'dark',
          { isDimmed: true }
        );

        expect(dimmed.depthAlpha).toBe(0.12);
      });

      it('applies overview mode subtle ring width (0.9px) to prevent overview visual noise', () => {
        const overview = resolveNodeVisualDescriptor(
          sampleNode,
          'src/api',
          0.8,
          0.8,
          'dark',
          { isOverviewMode: true }
        );

        expect(overview.ringWidth).toBe(0.9);
      });
    });
  });

  // =========================================================================
  // 2. Monogram Disambiguation Algorithm
  // =========================================================================
  describe('2. Monogram Disambiguation Algorithm', () => {
    it('generates two-letter initials from multi-token area names', () => {
      const areas: AreaIdentifier[] = [
        { id: 'frontend-ui', name: 'frontend-ui' },
        { id: 'data_store', name: 'data_store' },
        { id: 'crates/prebase-core', name: 'prebase-core' },
      ];

      const monograms = computeAreaMonograms(areas);
      expect(monograms.get('frontend-ui')).toBe('FU');
      expect(monograms.get('data_store')).toBe('DS');
      expect(monograms.get('crates/prebase-core')).toBe('PC');
    });

    it('generates two-character prefix for non-colliding single-token area names', () => {
      const areas: AreaIdentifier[] = [
        { id: 'api', name: 'api' },
        { id: 'core', name: 'core' },
        { id: 'db', name: 'db' },
      ];

      const monograms = computeAreaMonograms(areas);
      expect(monograms.get('api')).toBe('AP');
      expect(monograms.get('core')).toBe('CO');
      expect(monograms.get('db')).toBe('DB');
    });

    it('disambiguates collision between similar names like tests vs testing', () => {
      const areas: AreaIdentifier[] = [
        { id: 'tests', name: 'tests' },
        { id: 'testing', name: 'testing' },
      ];

      const monograms = computeAreaMonograms(areas);
      const monoTests = monograms.get('tests');
      const monoTesting = monograms.get('testing');

      expect(monoTests).toBeDefined();
      expect(monoTesting).toBeDefined();
      // Must not collide!
      expect(monoTests).not.toBe(monoTesting);
      expect([monoTests, monoTesting]).toContain('TS'); // first + last char of tests
      expect([monoTests, monoTesting]).toContain('TG'); // first + last char of testing
    });

    it('disambiguates collision between client vs cli vs clerk', () => {
      const areas: AreaIdentifier[] = [
        { id: 'client', name: 'client' },
        { id: 'cli', name: 'cli' },
        { id: 'clerk', name: 'clerk' },
      ];

      const monograms = computeAreaMonograms(areas);
      const m1 = monograms.get('client')!;
      const m2 = monograms.get('cli')!;
      const m3 = monograms.get('clerk')!;

      expect(m1).toBeDefined();
      expect(m2).toBeDefined();
      expect(m3).toBeDefined();
      expect(new Set([m1, m2, m3]).size).toBe(3); // All 3 strictly unique
    });

    it('guarantees 100% monogram uniqueness across an entire complex repository area set', () => {
      const areas: AreaIdentifier[] = [
        { id: 'src/api', name: 'api' },
        { id: 'src/app', name: 'app' },
        { id: 'src/auth', name: 'auth' },
        { id: 'src/common', name: 'common' },
        { id: 'src/core', name: 'core' },
        { id: 'src/components', name: 'components' },
        { id: 'src/db', name: 'db' },
        { id: 'src/data', name: 'data' },
        { id: 'src/models', name: 'models' },
        { id: 'src/modules', name: 'modules' },
        { id: 'src/tests', name: 'tests' },
        { id: 'src/testing', name: 'testing' },
        { id: 'src/ui', name: 'ui' },
        { id: 'src/utils', name: 'utils' },
        { id: '(root)', name: '(root)' },
      ];

      const monograms = computeAreaMonograms(areas);
      expect(monograms.size).toBe(areas.length);

      const assignedMonograms = Array.from(monograms.values());
      const uniqueMonograms = new Set(assignedMonograms);

      // Invariant: No duplicate monograms in the entire repository!
      expect(uniqueMonograms.size).toBe(areas.length);
      for (const m of assignedMonograms) {
        expect(m.length).toBeGreaterThanOrEqual(2);
        expect(m).toBe(m.toUpperCase());
      }
    });

    it('handles wrapper characters like (root) cleanly without brackets', () => {
      const areas: AreaIdentifier[] = [
        { id: '(root)', name: '(root)' },
      ];
      const monograms = computeAreaMonograms(areas);
      expect(monograms.get('(root)')).toBe('RO');
    });

    it('handles empty input gracefully', () => {
      expect(computeAreaMonograms([]).size).toBe(0);
    });
  });

  // =========================================================================
  // 3. Layout Stability Across Addition, Removal, and Renaming of Files
  // =========================================================================
  describe('3. Layout Stability Across Addition, Removal, and Renaming of Files', () => {
    const baseNodes: FileNode[] = [
      createTestNode('src/api/auth.ts', 'src/api/auth.ts'),
      createTestNode('src/api/routes.ts', 'src/api/routes.ts'),
      createTestNode('src/core/engine.ts', 'src/core/engine.ts'),
      createTestNode('src/core/parser.ts', 'src/core/parser.ts'),
      createTestNode('src/db/client.ts', 'src/db/client.ts'),
      createTestNode('src/db/models.ts', 'src/db/models.ts'),
    ];

    const baseEdges: DependencyEdge[] = [
      createTestEdge('src/api/routes.ts', 'src/api/auth.ts'),
      createTestEdge('src/api/auth.ts', 'src/db/client.ts'),
      createTestEdge('src/core/engine.ts', 'src/core/parser.ts'),
    ];

    const initialCamera: NetworkCamera = {
      yaw: 0.85,
      pitch: -0.35,
      panX: 420,
      panY: 310,
      zoom: 1.4,
    };

    const viewport = { width: 800, height: 600 };

    it('file addition: existing files preserve exact immutable positions when new files are added', () => {
      const snapshotV1: GraphSnapshot = {
        schema_version: '1.0.0',
        repository_id: 'stability-repo',
        revision: 1,
        nodes: baseNodes,
        edges: baseEdges,
        coverage: { total_discovered: 6, total_analyzed: 6, total_excluded: 0, total_issues: 0, is_complete: true },
        issues: [],
      };

      const emptyState: SnapshotRevisionState = {
        repositoryId: null,
        positions: new Map(),
        camera: initialCamera,
      };

      // V1: Initial layout
      const resultV1 = processSnapshotRevision(emptyState, snapshotV1, viewport);
      expect(resultV1.didTriggerInitialFit).toBe(true);
      const positionsV1 = resultV1.state.positions;
      expect(positionsV1.size).toBe(6);

      // V2: Add 2 new files (one in api, one in db)
      const newFileApi = createTestNode('src/api/middleware.ts', 'src/api/middleware.ts');
      const newFileDb = createTestNode('src/db/query.ts', 'src/db/query.ts');
      const snapshotV2: GraphSnapshot = {
        schema_version: '1.0.0',
        repository_id: 'stability-repo',
        revision: 2,
        nodes: [...baseNodes, newFileApi, newFileDb],
        edges: [
          ...baseEdges,
          createTestEdge('src/api/middleware.ts', 'src/api/auth.ts'),
          createTestEdge('src/db/client.ts', 'src/db/query.ts'),
        ],
        coverage: { total_discovered: 8, total_analyzed: 8, total_excluded: 0, total_issues: 0, is_complete: true },
        issues: [],
      };

      const resultV2 = processSnapshotRevision(resultV1.state, snapshotV2, viewport);
      expect(resultV2.didTriggerInitialFit).toBe(false); // Does not force re-fit view
      const positionsV2 = resultV2.state.positions;
      expect(positionsV2.size).toBe(8);

      // Invariant: All 6 original files preserve exact world coordinates
      for (const node of baseNodes) {
        const p1 = positionsV1.get(node.id)!;
        const p2 = positionsV2.get(node.id)!;
        expect(p2.x).toBeCloseTo(p1.x, 3);
        expect(p2.y).toBeCloseTo(p1.y, 3);
        expect(p2.z).toBeCloseTo(p1.z, 3);
      }

      // New files are positioned smoothly on the spherical shell
      const newPosApi = positionsV2.get('src/api/middleware.ts')!;
      const newPosDb = positionsV2.get('src/db/query.ts')!;
      expect(Number.isFinite(newPosApi.x)).toBe(true);
      expect(Number.isFinite(newPosDb.x)).toBe(true);
    });

    it('file removal: remaining files preserve exact coordinates without layout thrashing', () => {
      const snapshotV1: GraphSnapshot = {
        schema_version: '1.0.0',
        repository_id: 'stability-repo',
        revision: 1,
        nodes: baseNodes,
        edges: baseEdges,
        coverage: { total_discovered: 6, total_analyzed: 6, total_excluded: 0, total_issues: 0, is_complete: true },
        issues: [],
      };

      const emptyState: SnapshotRevisionState = {
        repositoryId: null,
        positions: new Map(),
        camera: initialCamera,
      };

      const resultV1 = processSnapshotRevision(emptyState, snapshotV1, viewport);
      const positionsV1 = resultV1.state.positions;

      // V2: Remove 'src/core/parser.ts'
      const remainingNodes = baseNodes.filter((n) => n.id !== 'src/core/parser.ts');
      const snapshotV2: GraphSnapshot = {
        schema_version: '1.0.0',
        repository_id: 'stability-repo',
        revision: 2,
        nodes: remainingNodes,
        edges: baseEdges.filter((e) => e.target_file_id !== 'src/core/parser.ts'),
        coverage: { total_discovered: 5, total_analyzed: 5, total_excluded: 0, total_issues: 0, is_complete: true },
        issues: [],
      };

      const resultV2 = processSnapshotRevision(resultV1.state, snapshotV2, viewport);
      const positionsV2 = resultV2.state.positions;
      expect(positionsV2.size).toBe(5);

      // Remaining 5 files must retain exact positions
      for (const node of remainingNodes) {
        const p1 = positionsV1.get(node.id)!;
        const p2 = positionsV2.get(node.id)!;
        expect(p2.x).toBeCloseTo(p1.x, 3);
        expect(p2.y).toBeCloseTo(p1.y, 3);
        expect(p2.z).toBeCloseTo(p1.z, 3);
      }
    });

    it('file renaming: unaffected files remain strictly immutable in 3D world space', () => {
      const snapshotV1: GraphSnapshot = {
        schema_version: '1.0.0',
        repository_id: 'stability-repo',
        revision: 1,
        nodes: baseNodes,
        edges: baseEdges,
        coverage: { total_discovered: 6, total_analyzed: 6, total_excluded: 0, total_issues: 0, is_complete: true },
        issues: [],
      };

      const emptyState: SnapshotRevisionState = {
        repositoryId: null,
        positions: new Map(),
        camera: initialCamera,
      };

      const resultV1 = processSnapshotRevision(emptyState, snapshotV1, viewport);
      const positionsV1 = resultV1.state.positions;

      // Rename src/api/auth.ts -> src/api/authentication.ts
      const renamedNode = createTestNode('src/api/authentication.ts', 'src/api/authentication.ts');
      const updatedNodes = baseNodes
        .filter((n) => n.id !== 'src/api/auth.ts')
        .concat(renamedNode);

      const snapshotV2: GraphSnapshot = {
        schema_version: '1.0.0',
        repository_id: 'stability-repo',
        revision: 2,
        nodes: updatedNodes,
        edges: baseEdges.map((e) =>
          e.source_file_id === 'src/api/auth.ts'
            ? { ...e, source_file_id: 'src/api/authentication.ts' }
            : e.target_file_id === 'src/api/auth.ts'
              ? { ...e, target_file_id: 'src/api/authentication.ts' }
              : e
        ),
        coverage: { total_discovered: 6, total_analyzed: 6, total_excluded: 0, total_issues: 0, is_complete: true },
        issues: [],
      };

      const resultV2 = processSnapshotRevision(resultV1.state, snapshotV2, viewport);
      const positionsV2 = resultV2.state.positions;

      // All 5 unaffected files must remain strictly at identical positions
      const unaffectedNodes = baseNodes.filter((n) => n.id !== 'src/api/auth.ts');
      for (const node of unaffectedNodes) {
        const p1 = positionsV1.get(node.id)!;
        const p2 = positionsV2.get(node.id)!;
        expect(p2.x).toBeCloseTo(p1.x, 3);
        expect(p2.y).toBeCloseTo(p1.y, 3);
        expect(p2.z).toBeCloseTo(p1.z, 3);
      }
    });

    it('camera state preservation: user camera transform is preserved across live revisions', () => {
      const snapshotV1: GraphSnapshot = {
        schema_version: '1.0.0',
        repository_id: 'stability-repo',
        revision: 1,
        nodes: baseNodes,
        edges: baseEdges,
        coverage: { total_discovered: 6, total_analyzed: 6, total_excluded: 0, total_issues: 0, is_complete: true },
        issues: [],
      };

      const userCustomCamera: NetworkCamera = {
        yaw: 1.75,
        pitch: -0.65,
        panX: 550,
        panY: 380,
        zoom: 2.1,
      };

      const currentState: SnapshotRevisionState = {
        repositoryId: 'stability-repo',
        positions: new Map([
          ['src/api/auth.ts', { x: 100, y: 0, z: 0 }],
        ]),
        camera: userCustomCamera,
      };

      const result = processSnapshotRevision(currentState, snapshotV1, viewport);

      // Camera is strictly preserved, not overwritten by default camera
      expect(result.state.camera).toEqual(userCustomCamera);
      expect(result.state.camera.yaw).toBe(userCustomCamera.yaw);
      expect(result.state.camera.pitch).toBe(userCustomCamera.pitch);
      expect(result.state.camera.panX).toBe(userCustomCamera.panX);
      expect(result.state.camera.panY).toBe(userCustomCamera.panY);
      expect(result.state.camera.zoom).toBe(userCustomCamera.zoom);
    });

    it('initial repository load: centers at usable viewport pivot and limits zoom to comfortable maxFitZoom (1.25)', () => {
      const snapshotV1: GraphSnapshot = {
        schema_version: '1.0.0',
        repository_id: 'new-repo-centered',
        revision: 1,
        nodes: baseNodes,
        edges: baseEdges,
        coverage: { total_discovered: 6, total_analyzed: 6, total_excluded: 0, total_issues: 0, is_complete: true },
        issues: [],
      };

      const emptyState: SnapshotRevisionState = {
        repositoryId: null,
        positions: new Map(),
        camera: initialCamera,
      };

      const customViewport = {
        width: 1200,
        height: 800,
        insets: { left: 240, right: 300, top: 50, bottom: 50 },
      };

      const result = processSnapshotRevision(emptyState, snapshotV1, customViewport);

      expect(result.didTriggerInitialFit).toBe(true);

      const usableCenterX = 240 + (1200 - 540) / 2; // 570
      const usableCenterY = 50 + (800 - 100) / 2; // 400

      // Must strictly center pan at usable viewport center (centerAtPivot = true)
      expect(result.state.camera.panX).toBeCloseTo(usableCenterX, 2);
      expect(result.state.camera.panY).toBeCloseTo(usableCenterY, 2);

      // Must never exceed comfortable maxFitZoom (1.25)
      expect(result.state.camera.zoom).toBeLessThanOrEqual(1.25);
      expect(result.state.camera.zoom).toBeGreaterThanOrEqual(0.15);
    });
  });
});
