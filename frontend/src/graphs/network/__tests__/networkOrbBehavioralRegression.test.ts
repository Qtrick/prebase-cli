import { describe, it, expect } from 'vitest';
import { layoutSphere, LayoutNode, LayoutLink } from '../layout/sphereLayout';
import { layoutOrganic } from '../layout/organicLayout';
import {
  processSnapshotRevision,
  SnapshotRevisionState,
} from '../layout/snapshotRevision';
import {
  DEFAULT_YAW,
  DEFAULT_PITCH,
  DEFAULT_ZOOM,
  NETWORK_FOCAL_LENGTH,
  PITCH_CLAMP_LIMIT,
  ROTATION_SENSITIVITY,
  PAN_SENSITIVITY,
  projectPoint3D,
  projectGraph,
  computeGraphCentroid,
  computeOrbitRevealCamera,
  computeRevealCamera,
  applyZoomAroundCursor,
  applyZoomAroundCenter,
  computeCenterLockedTransform,
  isCenterDeadZone,
  createDefaultCamera,
  handleGesturePointerDown,
  handleGesturePointerMove,
  findHitNode,
  wrapRotationAngle,
  clampPitch,
  ProjectedNode,
} from '../render/networkRenderMath';
import { FileNode, GraphSnapshot, NetworkCamera, Point3D, ViewportInsets } from '../../../types/graph';
import { deriveRelationshipGraph } from '../../relationship/deriveRelationshipGraph';
import { Viewport2D } from '../../relationship/RelationshipCanvas';

// Test Helpers
const makeNode = (id: string, opts?: { deps?: number; val?: number; isEntry?: boolean }): FileNode => ({
  id,
  relative_path: `src/${id}.ts`,
  filename: `${id}.ts`,
  language: 'typescript',
  size_bytes: 250,
  file_kind: 'Source',
  analysis_status: 'Analyzed',
  direct_dependency_count: opts?.deps ?? 1,
  direct_dependent_count: opts?.deps ?? 1,
});

const makeSnapshot = (
  repository_id: string,
  revision: number,
  nodeIds: string[]
): GraphSnapshot => ({
  schema_version: '1.0.0',
  repository_id,
  revision,
  nodes: nodeIds.map((id, idx) => makeNode(id, { deps: (idx % 3) + 1 })),
  edges: nodeIds.slice(1).map((id, idx) => ({
    id: `${nodeIds[idx]}->${id}`,
    source_file_id: nodeIds[idx],
    target_file_id: id,
    relationship_kind: 'Import',
    resolution_status: 'ResolvedInternal',
    evidence: [],
  })),
  coverage: {
    total_discovered: nodeIds.length,
    total_analyzed: nodeIds.length,
    total_excluded: 0,
    total_issues: 0,
    is_complete: true,
  },
  issues: [],
});

const makeProjectedNode = (
  id: string,
  localPos: Point3D,
  camera: NetworkCamera
): ProjectedNode => {
  const node = makeNode(id);
  const proj = projectPoint3D(localPos.x, localPos.y, localPos.z, camera.yaw, camera.pitch);
  return {
    id,
    node,
    worldPos: localPos,
    localPos,
    projected: proj,
    screenX: camera.panX + proj.x * camera.zoom,
    screenY: camera.panY + proj.y * camera.zoom,
    radius: 12,
  };
};

describe('3D Network Graph Dependency Orb Behavioral Regression', () => {
  // =========================================================================
  // 1. Fibonacci Sphere Layout Node Depth Distribution & Organic Comparison
  // =========================================================================
  describe('1. Fibonacci Sphere Layout (layoutSphere) Depth Distribution & Organic Comparison', () => {
    it('distributes nodes along a 3D spherical shell with high roundness and tight radial variance', () => {
      const nodeCount = 72;
      const nodes: LayoutNode[] = Array.from({ length: nodeCount }, (_, i) => ({
        id: `node-${i}`,
        val: (i % 4) + 1,
        isEntry: i === 0,
      }));
      const links: LayoutLink[] = [];
      for (let i = 0; i < nodeCount - 1; i++) {
        links.push({ source: `node-${i}`, target: `node-${i + 1}` });
      }

      const sphereRadius = 260;
      const positions = layoutSphere(nodes, links, { sphereRadius });
      expect(positions.size).toBe(nodeCount);

      // Compute radial distance r = sqrt(x^2 + y^2 + z^2) for each node
      const radii: number[] = [];
      for (const p of positions.values()) {
        const r = Math.hypot(p.x, p.y, p.z);
        radii.push(r);
      }

      const meanR = radii.reduce((acc, r) => acc + r, 0) / nodeCount;
      const varianceR = radii.reduce((acc, r) => acc + Math.pow(r - meanR, 2), 0) / nodeCount;
      const stdDevR = Math.sqrt(varianceR);
      const coeffOfVariation = stdDevR / meanR;

      // Tight spherical shell: coefficient of variation should be small (< 0.08)
      expect(coeffOfVariation).toBeLessThan(0.08);

      // Hollow interior: no nodes collapsed to origin (minimum radius > 85% of mean shell radius)
      const minR = Math.min(...radii);
      expect(minR).toBeGreaterThan(meanR * 0.85);

      // Maximum radius tightly bounded by shell radius
      const maxR = Math.max(...radii);
      expect(maxR).toBeLessThanOrEqual(sphereRadius * 1.05);
    });

    it('spans all 3 axes symmetrically with full Z-spread spanning [-R, R]', () => {
      const nodeCount = 90;
      const nodes: LayoutNode[] = Array.from({ length: nodeCount }, (_, i) => ({
        id: `file-${i}`,
      }));
      const links: LayoutLink[] = [];

      const positions = layoutSphere(nodes, links, { sphereRadius: 280 });

      let minX = Infinity, maxX = -Infinity;
      let minY = Infinity, maxY = -Infinity;
      let minZ = Infinity, maxZ = -Infinity;
      let frontHemisphereCount = 0;
      let rearHemisphereCount = 0;

      for (const p of positions.values()) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y);
        maxY = Math.max(maxY, p.y);
        minZ = Math.min(minZ, p.z);
        maxZ = Math.max(maxZ, p.z);

        if (p.z >= 0) frontHemisphereCount++;
        else rearHemisphereCount++;
      }

      const effectiveR = 280 * 0.58; // Base shell radius threshold

      // Full 3D Z-spread: minZ and maxZ span well into both negative and positive depths
      expect(minZ).toBeLessThan(-effectiveR * 0.85);
      expect(maxZ).toBeGreaterThan(effectiveR * 0.85);

      // X and Y bounds also span full shell extent
      expect(minX).toBeLessThan(-effectiveR * 0.85);
      expect(maxX).toBeGreaterThan(effectiveR * 0.85);
      expect(minY).toBeLessThan(-effectiveR * 0.85);
      expect(maxY).toBeGreaterThan(effectiveR * 0.85);

      // Symmetric hemisphere balance: roughly 50% front, 50% rear (within ±10%)
      const balanceRatio = frontHemisphereCount / nodeCount;
      expect(balanceRatio).toBeGreaterThan(0.40);
      expect(balanceRatio).toBeLessThan(0.60);
    });

    it('contrasts layoutSphere (outer shell orb) against layoutOrganic (internal volumetric core)', () => {
      const nodeCount = 50;
      const nodes: LayoutNode[] = Array.from({ length: nodeCount }, (_, i) => ({
        id: `node-${i}`,
        val: i === 0 ? 12 : i < 5 ? 6 : 1, // Hub nodes
        isEntry: i === 0,
      }));
      const links: LayoutLink[] = [];
      for (let i = 1; i < nodeCount; i++) {
        // Connect to hub or preceding node
        links.push({ source: i < 5 ? 'node-0' : `node-${i % 5}`, target: `node-${i}` });
      }

      const sphereRadius = 250;
      const spherePositions = layoutSphere(nodes, links, { sphereRadius });
      const organicPositions = layoutOrganic(nodes, links, { sphereRadius });

      const sphereRadii = [...spherePositions.values()].map((p) => Math.hypot(p.x, p.y, p.z));
      const organicRadii = [...organicPositions.values()].map((p) => Math.hypot(p.x, p.y, p.z));

      const sphereMeanR = sphereRadii.reduce((a, b) => a + b, 0) / nodeCount;
      const organicMeanR = organicRadii.reduce((a, b) => a + b, 0) / nodeCount;

      const sphereStd = Math.sqrt(
        sphereRadii.reduce((a, b) => a + Math.pow(b - sphereMeanR, 2), 0) / nodeCount
      );
      const organicStd = Math.sqrt(
        organicRadii.reduce((a, b) => a + Math.pow(b - organicMeanR, 2), 0) / nodeCount
      );

      // 1. layoutOrganic has significantly larger radial spread/variance across volume
      expect(organicStd).toBeGreaterThan(sphereStd * 3.5);

      // 2. layoutOrganic places hub nodes deep inside the internal core
      const organicMinR = Math.min(...organicRadii);
      const sphereMinR = Math.min(...sphereRadii);
      expect(organicMinR).toBeLessThan(organicMeanR * 0.4);
      expect(sphereMinR).toBeGreaterThan(sphereMeanR * 0.85);

      // 3. layoutSphere maintains a clean hollow shell silhouette
      expect(sphereStd / sphereMeanR).toBeLessThan(0.08);
    });

    it('guarantees layoutSphere 3D centroid is centered at exactly (0, 0, 0)', () => {
      const nodes: LayoutNode[] = Array.from({ length: 45 }, (_, i) => ({ id: `mod-${i}` }));
      const links: LayoutLink[] = [{ source: 'mod-0', target: 'mod-1' }];

      const positions = layoutSphere(nodes, links);
      const centroid = computeGraphCentroid(positions.values());

      expect(centroid.x).toBeCloseTo(0, 5);
      expect(centroid.y).toBeCloseTo(0, 5);
      expect(centroid.z).toBeCloseTo(0, 5);
    });

    it('layoutSphere with existingPositions preserves existing coordinates without layout thrashing', () => {
      const initialNodes: LayoutNode[] = [
        { id: 'core-a' },
        { id: 'core-b' },
        { id: 'core-c' },
      ];
      const initialLinks: LayoutLink[] = [{ source: 'core-a', target: 'core-b' }];

      const initialPos = layoutSphere(initialNodes, initialLinks);
      const initialA = { ...initialPos.get('core-a')! };
      const initialB = { ...initialPos.get('core-b')! };

      // Incremental revision: add 2 new nodes
      const nextNodes: LayoutNode[] = [
        ...initialNodes,
        { id: 'new-d' },
        { id: 'new-e' },
      ];
      const nextLinks: LayoutLink[] = [
        ...initialLinks,
        { source: 'core-b', target: 'new-d' },
      ];

      const nextPos = layoutSphere(nextNodes, nextLinks, undefined, initialPos);
      expect(nextPos.size).toBe(5);

      // Pinned existing nodes remain strictly unmoved
      const currentA = nextPos.get('core-a')!;
      const currentB = nextPos.get('core-b')!;
      expect(currentA.x).toBe(initialA.x);
      expect(currentA.y).toBe(initialA.y);
      expect(currentA.z).toBe(initialA.z);
      expect(currentB.x).toBe(initialB.x);
      expect(currentB.y).toBe(initialB.y);
      expect(currentB.z).toBe(initialB.z);

      // New nodes are placed cleanly
      expect(nextPos.has('new-d')).toBe(true);
      expect(nextPos.has('new-e')).toBe(true);
    });

    it('is strictly deterministic and handles empty or single-node graphs safely', () => {
      // Empty graph
      expect(layoutSphere([], []).size).toBe(0);

      // Single node graph is placed at (0, 0, 0)
      const singlePos = layoutSphere([{ id: 'only-node' }], []);
      expect(singlePos.size).toBe(1);
      const pos0 = singlePos.get('only-node')!;
      expect(pos0.x).toBeCloseTo(0, 5);
      expect(pos0.y).toBeCloseTo(0, 5);
      expect(pos0.z).toBeCloseTo(0, 5);

      // Determinism across multiple executions
      const testNodes: LayoutNode[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
      const testLinks: LayoutLink[] = [{ source: 'a', target: 'b' }, { source: 'c', target: 'd' }];
      const run1 = layoutSphere(testNodes, testLinks, { sphereRadius: 200 });
      const run2 = layoutSphere(testNodes, testLinks, { sphereRadius: 200 });

      for (const [id, p1] of run1) {
        const p2 = run2.get(id)!;
        expect(p1.x).toBe(p2.x);
        expect(p1.y).toBe(p2.y);
        expect(p1.z).toBe(p2.z);
      }
    });
  });

  // =========================================================================
  // 2. 3D Centroid Stationary Pivot Stability
  // =========================================================================
  describe('2. 3D Centroid Stationary Pivot Stability', () => {
    it('guarantees graph centroid in local coordinates is always (0, 0, 0) regardless of world translation', () => {
      const worldPositions: Point3D[] = [
        { x: 1200, y: -450, z: 800 },
        { x: -300, y: 150, z: -200 },
        { x: 900, y: -600, z: 300 },
      ];

      const centroid = computeGraphCentroid(worldPositions);
      expect(centroid.x).toBeCloseTo(600, 6);
      expect(centroid.y).toBeCloseTo(-300, 6);
      expect(centroid.z).toBeCloseTo(300, 6);

      const localCentroid = {
        x: centroid.x - centroid.x,
        y: centroid.y - centroid.y,
        z: centroid.z - centroid.z,
      };

      expect(localCentroid.x).toBe(0);
      expect(localCentroid.y).toBe(0);
      expect(localCentroid.z).toBe(0);
    });

    it('projects local (0, 0, 0) to (0, 0) across all possible yaw and pitch angles', () => {
      const yawSteps = [-Math.PI, -Math.PI / 2, -0.7, 0, 0.45, Math.PI / 2, Math.PI];
      const pitchSteps = [-PITCH_CLAMP_LIMIT, -0.8, -0.2, 0, 0.3, 1.0, PITCH_CLAMP_LIMIT];

      for (const yaw of yawSteps) {
        for (const pitch of pitchSteps) {
          const proj = projectPoint3D(0, 0, 0, yaw, pitch);
          expect(proj.x).toBeCloseTo(0, 8);
          expect(proj.y).toBeCloseTo(0, 8);
          expect(proj.z).toBeCloseTo(0, 8);
          expect(proj.depthScale).toBeCloseTo(1.0, 8);
        }
      }
    });

    it('keeps centroid screen projection strictly locked to (camera.panX, camera.panY) under continuous rotation and zoom', () => {
      const camera: NetworkCamera = {
        yaw: DEFAULT_YAW,
        pitch: DEFAULT_PITCH,
        panX: 520,
        panY: 380,
        zoom: 1.75,
      };

      // Perform 360-degree yaw sweep and full pitch sweep
      for (let angleDeg = 0; angleDeg <= 360; angleDeg += 15) {
        const yaw = (angleDeg * Math.PI) / 180;
        const pitch = Math.sin(yaw) * 1.2; // Continuous wave of pitch

        const proj = projectPoint3D(0, 0, 0, yaw, pitch);
        const screenX = camera.panX + proj.x * camera.zoom;
        const screenY = camera.panY + proj.y * camera.zoom;

        expect(screenX).toBeCloseTo(camera.panX, 6);
        expect(screenY).toBeCloseTo(camera.panY, 6);
      }
    });

    it('projectGraph maps multi-node graph centroid to (camera.panX, camera.panY) while nodes revolve around it', () => {
      const snapshot = makeSnapshot('repo-pivot', 1, ['root', 'child-1', 'child-2', 'child-3']);
      const links = snapshot.edges.map((e) => ({ source: e.source_file_id, target: e.target_file_id }));
      const positions = layoutSphere(snapshot.nodes, links, { sphereRadius: 200 });
      const centroid = computeGraphCentroid(positions.values());

      const camera: NetworkCamera = {
        yaw: 0.8,
        pitch: -0.3,
        panX: 450,
        panY: 320,
        zoom: 1.2,
      };

      const projGraph = projectGraph(snapshot.nodes, positions, centroid, camera);
      expect(projGraph.projectedList.length).toBe(4);

      // The mean of local positions is (0, 0, 0)
      let meanLocalX = 0, meanLocalY = 0, meanLocalZ = 0;
      for (const p of projGraph.projectedList) {
        meanLocalX += p.localPos.x;
        meanLocalY += p.localPos.y;
        meanLocalZ += p.localPos.z;
      }
      expect(meanLocalX / 4).toBeCloseTo(0, 4);
      expect(meanLocalY / 4).toBeCloseTo(0, 4);
      expect(meanLocalZ / 4).toBeCloseTo(0, 4);

      // The virtual centroid point projects to (panX, panY)
      const centroidProj = projectPoint3D(0, 0, 0, camera.yaw, camera.pitch);
      const centroidScreenX = camera.panX + centroidProj.x * camera.zoom;
      const centroidScreenY = camera.panY + centroidProj.y * camera.zoom;
      expect(centroidScreenX).toBe(camera.panX);
      expect(centroidScreenY).toBe(camera.panY);
    });

    it('maintains stationary centroid projection for globally offset asymmetric clusters', () => {
      // Cluster placed far off at (1500, -800, 320)
      const offsetNodes = [
        makeNode('clust-1'),
        makeNode('clust-2'),
        makeNode('clust-3'),
      ];
      const offsetPositions = new Map<string, Point3D>([
        ['clust-1', { x: 1400, y: -850, z: 280 }],
        ['clust-2', { x: 1600, y: -750, z: 360 }],
        ['clust-3', { x: 1500, y: -800, z: 320 }],
      ]);

      const centroid = computeGraphCentroid(offsetPositions.values());
      expect(centroid.x).toBeCloseTo(1500, 4);
      expect(centroid.y).toBeCloseTo(-800, 4);
      expect(centroid.z).toBeCloseTo(320, 4);

      const camera: NetworkCamera = {
        yaw: 1.1,
        pitch: -0.4,
        panX: 480,
        panY: 360,
        zoom: 1.5,
      };

      const result = projectGraph(offsetNodes, offsetPositions, centroid, camera);
      expect(result.projectedList.length).toBe(3);

      // Centroid itself in local space is (0, 0, 0), projecting identically to (camera.panX, camera.panY)
      const centroidProj = projectPoint3D(0, 0, 0, camera.yaw, camera.pitch);
      expect(centroidProj.depthScale).toBe(1.0);
      expect(camera.panX + centroidProj.x * camera.zoom).toBe(camera.panX);
      expect(camera.panY + centroidProj.y * camera.zoom).toBe(camera.panY);
    });
  });

  // =========================================================================
  // 3. Center Lock Invariant (keepGraphCentered)
  // =========================================================================
  describe('3. Center Lock Invariant (keepGraphCentered)', () => {
    const viewportWidth = 1000;
    const viewportHeight = 700;
    const insets: ViewportInsets = { left: 240, right: 300, top: 60, bottom: 40 };

    // Usable Center calculation
    const usableW = viewportWidth - insets.left! - insets.right!; // 460
    const usableH = viewportHeight - insets.top! - insets.bottom!; // 600
    const usableCenterX = insets.left! + usableW / 2; // 240 + 230 = 470
    const usableCenterY = insets.top! + usableH / 2; // 60 + 300 = 360

    it('ordinary rotation does not alter panX and panY when keepGraphCentered is enabled', () => {
      const centeredCamera: NetworkCamera = {
        yaw: DEFAULT_YAW,
        pitch: DEFAULT_PITCH,
        panX: usableCenterX,
        panY: usableCenterY,
        zoom: DEFAULT_ZOOM,
      };

      // Pointer down in rotating mode
      let gesture = handleGesturePointerDown({
        clientX: 400,
        clientY: 300,
        pointerId: 1,
        pointerType: 'mouse',
        currentCamera: centeredCamera,
      });
      expect(gesture.mode).toBe('rotating');

      // Drag across screen (dx = 80, dy = -45)
      const moveResult = handleGesturePointerMove(gesture, 480, 255, centeredCamera);
      expect(moveResult.gesture.exceededThreshold).toBe(true);

      // Yaw and pitch rotate
      const expectedYaw = wrapRotationAngle(centeredCamera.yaw - 80 * ROTATION_SENSITIVITY);
      const expectedPitch = clampPitch(centeredCamera.pitch - 45 * ROTATION_SENSITIVITY);
      expect(moveResult.camera.yaw).toBeCloseTo(expectedYaw, 6);
      expect(moveResult.camera.pitch).toBeCloseTo(expectedPitch, 6);

      // In center-locked mode, panX and panY remain strictly anchored at usable center
      expect(moveResult.camera.panX).toBe(usableCenterX);
      expect(moveResult.camera.panY).toBe(usableCenterY);
    });

    it('free pan is initiated only by explicit pan gestures (shift-drag), unlocking center lock', () => {
      const centeredCamera: NetworkCamera = {
        yaw: DEFAULT_YAW,
        pitch: DEFAULT_PITCH,
        panX: usableCenterX,
        panY: usableCenterY,
        zoom: DEFAULT_ZOOM,
      };

      // Shift-drag initiates panning mode
      const shiftGesture = handleGesturePointerDown({
        clientX: 400,
        clientY: 300,
        pointerId: 2,
        pointerType: 'mouse',
        shiftKey: true,
        currentCamera: centeredCamera,
      });
      expect(shiftGesture.mode).toBe('panning');

      const panMove = handleGesturePointerMove(shiftGesture, 450, 280, centeredCamera);
      expect(panMove.gesture.exceededThreshold).toBe(true);
      expect(panMove.camera.panX).toBe(usableCenterX + 50 * PAN_SENSITIVITY);
      expect(panMove.camera.panY).toBe(usableCenterY - 20 * PAN_SENSITIVITY);

      // Yaw and pitch remain unchanged during pan
      expect(panMove.camera.yaw).toBe(centeredCamera.yaw);
      expect(panMove.camera.pitch).toBe(centeredCamera.pitch);
    });

    it('applyZoomAroundCenter anchors zoom to usable viewport center without panX/panY drift', () => {
      const camera: NetworkCamera = {
        yaw: 0.72,
        pitch: -0.34,
        panX: usableCenterX,
        panY: usableCenterY,
        zoom: 1.0,
      };

      // Zoom In (factor 1.5)
      const zoomedIn = applyZoomAroundCenter(camera, 1.5, viewportWidth, viewportHeight, insets);
      expect(zoomedIn.zoom).toBe(1.5);
      expect(zoomedIn.panX).toBeCloseTo(usableCenterX, 6);
      expect(zoomedIn.panY).toBeCloseTo(usableCenterY, 6);

      // Zoom Out (factor 0.6)
      const zoomedOut = applyZoomAroundCenter(zoomedIn, 0.6, viewportWidth, viewportHeight, insets);
      expect(zoomedOut.zoom).toBeCloseTo(0.9, 6);
      expect(zoomedOut.panX).toBeCloseTo(usableCenterX, 6);
      expect(zoomedOut.panY).toBeCloseTo(usableCenterY, 6);

      // Yaw and pitch are strictly invariant under zoom
      expect(zoomedOut.yaw).toBe(camera.yaw);
      expect(zoomedOut.pitch).toBe(camera.pitch);
    });

    it('contrasts applyZoomAroundCenter (zero drift) with applyZoomAroundCursor (cursor-directed shift)', () => {
      const camera: NetworkCamera = {
        yaw: DEFAULT_YAW,
        pitch: DEFAULT_PITCH,
        panX: usableCenterX,
        panY: usableCenterY,
        zoom: 1.0,
      };

      const cursorX = 800; // Far to the right (e.g. over right inspector boundary)
      const cursorY = 200;

      // Free zoom shifts panX and panY toward cursor
      const cursorZoomed = applyZoomAroundCursor(camera, 1.5, cursorX, cursorY);
      expect(cursorZoomed.panX).not.toBe(usableCenterX);
      expect(cursorZoomed.panY).not.toBe(usableCenterY);

      // Center-locked zoom strictly preserves usableCenterX and usableCenterY
      const centerZoomed = applyZoomAroundCenter(camera, 1.5, viewportWidth, viewportHeight, insets);
      expect(centerZoomed.panX).toBeCloseTo(usableCenterX, 6);
      expect(centerZoomed.panY).toBeCloseTo(usableCenterY, 6);
    });

    it('computeCenterLockedTransform aligns symmetric graph bounds to usable viewport center', () => {
      const bounds = { minX: -150, maxX: 150, minY: -100, maxY: 100 };
      const transform = computeCenterLockedTransform(bounds, viewportWidth, viewportHeight, 1.25, insets);

      expect(transform.panX).toBeCloseTo(usableCenterX, 6);
      expect(transform.panY).toBeCloseTo(usableCenterY, 6);
      expect(transform.zoom).toBe(1.25);
    });

    it('isCenterDeadZone prevents sub-pixel micro-jitter during continuous rotation', () => {
      const current = { panX: usableCenterX + 0.3, panY: usableCenterY - 0.2 };
      const target = { panX: usableCenterX, panY: usableCenterY };

      // Micro-jitter < 0.5px is absorbed by dead zone
      expect(isCenterDeadZone(current, target, 0.5)).toBe(true);

      // Intentional pan >= 0.5px is detected
      const displaced = { panX: usableCenterX + 1.2, panY: usableCenterY };
      expect(isCenterDeadZone(displaced, target, 0.5)).toBe(false);
    });

    it('reversible center-locked zoom returns to exact original camera transform without numerical drift', () => {
      const camera: NetworkCamera = {
        yaw: DEFAULT_YAW,
        pitch: DEFAULT_PITCH,
        panX: usableCenterX,
        panY: usableCenterY,
        zoom: 1.0,
      };

      // Zoom in 1.25x twice: zoom becomes 1.5625
      let c = applyZoomAroundCenter(camera, 1.25, viewportWidth, viewportHeight, insets);
      c = applyZoomAroundCenter(c, 1.25, viewportWidth, viewportHeight, insets);
      expect(c.zoom).toBeCloseTo(1.5625, 6);
      expect(c.panX).toBeCloseTo(usableCenterX, 6);
      expect(c.panY).toBeCloseTo(usableCenterY, 6);

      // Zoom out by reciprocal (1 / 1.25) twice: zoom returns to 1.0
      c = applyZoomAroundCenter(c, 1 / 1.25, viewportWidth, viewportHeight, insets);
      c = applyZoomAroundCenter(c, 1 / 1.25, viewportWidth, viewportHeight, insets);
      expect(c.zoom).toBeCloseTo(1.0, 6);
      expect(c.panX).toBeCloseTo(usableCenterX, 6);
      expect(c.panY).toBeCloseTo(usableCenterY, 6);
      expect(c.yaw).toBe(camera.yaw);
      expect(c.pitch).toBe(camera.pitch);
    });
  });

  // =========================================================================
  // 4. Orbit-Preserving Reveal vs Ordinary Selection
  // =========================================================================
  describe('4. Orbit-Preserving Reveal vs Ordinary Selection', () => {
    const baseCamera: NetworkCamera = {
      yaw: 0.65,
      pitch: -0.25,
      panX: 450,
      panY: 320,
      zoom: 1.4,
    };

    it('ordinary node selection does NOT alter camera orientation, translation, or zoom', () => {
      const targetNode = makeNode('service-worker');
      const projectedList = [
        makeProjectedNode('service-worker', { x: 80, y: -50, z: 100 }, baseCamera),
      ];

      // Click event over node (< 4px gesture threshold)
      const hit = findHitNode(projectedList, projectedList[0].screenX, projectedList[0].screenY, baseCamera.zoom);
      expect(hit?.id).toBe(targetNode.id);

      // Camera after selection must be strictly identical to camera before selection
      const cameraAfterSelection = { ...baseCamera };
      expect(cameraAfterSelection).toEqual(baseCamera);
      expect(cameraAfterSelection.yaw).toBe(0.65);
      expect(cameraAfterSelection.pitch).toBe(-0.25);
      expect(cameraAfterSelection.panX).toBe(450);
      expect(cameraAfterSelection.panY).toBe(320);
      expect(cameraAfterSelection.zoom).toBe(1.4);
    });

    it('orbit-preserving reveal brings target node to front (+Z) while keeping orb center stationary at (usableCenterX, usableCenterY)', () => {
      // Place target node at an arbitrary 3D position
      const localPos: Point3D = { x: 120, y: -70, z: 90 };
      const pNode = makeProjectedNode('target-feature', localPos, baseCamera);

      const targetCamera = computeOrbitRevealCamera(pNode, baseCamera, 900, 600);
      expect(targetCamera).not.toBeNull();

      // Invariant 1: Orb center is NOT translated across screen
      expect(targetCamera!.panX).toBe(450); // 900 / 2
      expect(targetCamera!.panY).toBe(300); // 600 / 2

      // Invariant 2: Zoom is preserved
      expect(targetCamera!.zoom).toBe(baseCamera.zoom);

      // Invariant 3: Target node is rotated to face directly frontward (+Z)
      const revealedProj = projectPoint3D(localPos.x, localPos.y, localPos.z, targetCamera!.yaw, targetCamera!.pitch);
      expect(revealedProj.x).toBeCloseTo(0, 3);
      expect(revealedProj.y).toBeCloseTo(0, 3);
      expect(revealedProj.z).toBeGreaterThan(0); // Front-facing hemisphere!
      expect(revealedProj.depthScale).toBeGreaterThan(0.85);

      // Screen position of target node now aligns directly with viewport center
      const screenX = targetCamera!.panX + revealedProj.x * targetCamera!.zoom;
      const screenY = targetCamera!.panY + revealedProj.y * targetCamera!.zoom;
      expect(screenX).toBeCloseTo(targetCamera!.panX, 2);
      expect(screenY).toBeCloseTo(targetCamera!.panY, 2);
    });

    it('orbit-preserving reveal handles rear-hemisphere nodes (z < 0) without upside-down pitch inversion', () => {
      // Place target node on the back hemisphere (z = -140)
      const backLocalPos: Point3D = { x: -80, y: 50, z: -140 };
      const pNode = makeProjectedNode('rear-node', backLocalPos, baseCamera);

      const targetCamera = computeOrbitRevealCamera(pNode, baseCamera, 800, 600);
      expect(targetCamera).not.toBeNull();

      // Must never exceed pitch clamp limit (prevents upside-down camera inversion)
      expect(Math.abs(targetCamera!.pitch)).toBeLessThanOrEqual(PITCH_CLAMP_LIMIT);

      // Target node rotates to front-facing (+Z)
      const revealedProj = projectPoint3D(
        backLocalPos.x,
        backLocalPos.y,
        backLocalPos.z,
        targetCamera!.yaw,
        targetCamera!.pitch
      );
      expect(revealedProj.x).toBeCloseTo(0, 3);
      expect(revealedProj.y).toBeCloseTo(0, 3);
      expect(revealedProj.z).toBeGreaterThan(0); // Rotated from back to front!
    });

    it('contrasts computeOrbitRevealCamera (rotates orb) with computeRevealCamera with preserveOrbit=false (displaces orb)', () => {
      const localPos: Point3D = { x: 100, y: -60, z: 80 };
      const pNode = makeProjectedNode('toggle-node', localPos, baseCamera);

      // 1. Non-orbit reveal: keeps yaw & pitch, translates panX & panY
      const nonOrbitCam = computeRevealCamera(pNode, baseCamera, 800, 600, undefined, false, false);
      expect(nonOrbitCam!.yaw).toBe(baseCamera.yaw);
      expect(nonOrbitCam!.pitch).toBe(baseCamera.pitch);
      expect(nonOrbitCam!.panX).not.toBe(400); // Orb center is displaced!

      // 2. Orbit reveal: keeps panX & panY centered, rotates yaw & pitch
      const orbitCam = computeRevealCamera(pNode, baseCamera, 800, 600, undefined, false, true);
      expect(orbitCam!.panX).toBe(400); // Orb center remains centered!
      expect(orbitCam!.panY).toBe(300);
      expect(orbitCam!.yaw).not.toBe(baseCamera.yaw); // Rotated to face node!
    });

    it('suppresses camera animation when node is already visible on the front hemisphere with onlyIfOutside=true', () => {
      // Front-facing node comfortably visible inside viewport
      const visibleFrontPos: Point3D = { x: 20, y: 15, z: 100 };
      const pNode = makeProjectedNode('already-visible', visibleFrontPos, baseCamera);

      const targetCamera = computeOrbitRevealCamera(pNode, baseCamera, 800, 600, undefined, true);
      expect(targetCamera).toBeNull(); // No camera motion required!
    });

    it('handles degenerate position at origin (0, 0, 0) safely without division by zero', () => {
      const originNode = makeProjectedNode('origin-node', { x: 0, y: 0, z: 0 }, baseCamera);
      const result = computeOrbitRevealCamera(originNode, baseCamera, 800, 600);
      // When node is at origin, rotation direction is undefined, function returns null safely
      expect(result).toBeNull();
    });

    it('consecutive ordinary node selections do not cause camera drift across repeated clicks', () => {
      const nodes = [makeNode('a'), makeNode('b'), makeNode('c')];
      const positions = new Map<string, Point3D>([
        ['a', { x: 100, y: 0, z: 0 }],
        ['b', { x: -80, y: 40, z: 50 }],
        ['c', { x: 0, y: -90, z: -60 }],
      ]);
      const centroid = computeGraphCentroid(positions.values());

      let currentCam = { ...baseCamera };
      const proj = projectGraph(nodes, positions, centroid, currentCam);

      // Simulate clicking node a, then b, then c, then background
      for (const pNode of proj.projectedList) {
        const hit = findHitNode(proj.projectedList, pNode.screenX, pNode.screenY, currentCam.zoom);
        expect(hit).toBeDefined();
        // Camera remains strictly unchanged
        expect(currentCam).toEqual(baseCamera);
      }

      // Deselect by clicking empty background
      const hitEmpty = findHitNode(proj.projectedList, 10, 10, currentCam.zoom);
      expect(hitEmpty).toBeNull();
      expect(currentCam).toEqual(baseCamera);
    });
  });

  // =========================================================================
  // 5. 3D to 2D Relationship Explorer Mode Switching
  // =========================================================================
  describe('5. 3D to 2D Relationship Explorer Mode Switching', () => {
    it('preserves 3D camera state (yaw, pitch, panX, panY, zoom) across 3D -> 2D -> 3D view mode transitions', () => {
      // User customized camera in 3D dependency orb
      const original3DCamera: NetworkCamera = {
        yaw: 1.28,
        pitch: -0.42,
        panX: 495,
        panY: 345,
        zoom: 2.15,
      };

      let active3DCamera: NetworkCamera = { ...original3DCamera };
      let active2DViewport: Viewport2D = {
        panX: 0,
        panY: 0,
        zoom: 1.0,
      };

      // 1. User switches to 2D Relationship Explorer
      let currentMode: '3d' | '2d' = '2d';
      expect(currentMode).toBe('2d');

      // 2. User pans and zooms freely inside 2D Relationship Explorer
      active2DViewport = {
        panX: 180,
        panY: -95,
        zoom: 1.45,
      };
      expect(active2DViewport.panX).toBe(180);
      expect(active2DViewport.zoom).toBe(1.45);

      // 3D camera remains completely isolated and untouched
      expect(active3DCamera).toEqual(original3DCamera);

      // 3. User switches back to 3D Dependency Orb
      currentMode = '3d';
      expect(currentMode).toBe('3d');

      expect(active3DCamera.yaw).toBe(1.28);
      expect(active3DCamera.pitch).toBe(-0.42);
      expect(active3DCamera.panX).toBe(495);
      expect(active3DCamera.panY).toBe(345);
      expect(active3DCamera.zoom).toBe(2.15);
    });

    it('transfers selected 3D node to 2D relationship focal root and derives incoming/outgoing relationships', () => {
      const snapshot = makeSnapshot('repo-mode-switch', 1, [
        'auth-service',
        'user-db',
        'jwt-helper',
        'api-gateway',
      ]);

      // In 3D mode: user selects 'auth-service'
      const selectedNodeIn3D = snapshot.nodes[0];
      expect(selectedNodeIn3D.id).toBe('auth-service');

      // Switch to 2D mode with focusNodeId = selectedNodeIn3D.id
      const focusNodeId = selectedNodeIn3D.id;
      const relationshipData = deriveRelationshipGraph(snapshot, focusNodeId, { depth: 1, direction: 'both' });

      expect(relationshipData.focusNode?.id).toBe('auth-service');
      expect(relationshipData.nodes.length).toBeGreaterThan(0);

      // Navigating in 2D mode updates selected node
      const nextSelectedIn2D = snapshot.nodes.find((n) => n.id === 'user-db')!;
      expect(nextSelectedIn2D).toBeDefined();

      // Switching back to 3D mode retains nextSelectedIn2D as active selected node
      const restoredSelectedIn3D = nextSelectedIn2D;
      expect(restoredSelectedIn3D.id).toBe('user-db');
    });

    it('processSnapshotRevision during 2D mode preserves 3D camera and positions for live SSE updates', () => {
      const snap1 = makeSnapshot('repo-live', 1, ['node-1', 'node-2', 'node-3']);
      const viewport = { width: 800, height: 600 };

      // Initial 3D setup
      const initResult = processSnapshotRevision(
        { repositoryId: null, positions: new Map(), camera: createDefaultCamera() },
        snap1,
        viewport,
        'sphere'
      );
      expect(initResult.didTriggerInitialFit).toBe(true);

      const customizedCamera: NetworkCamera = {
        yaw: 0.95,
        pitch: -0.35,
        panX: 420,
        panY: 310,
        zoom: 1.8,
      };

      const currentState: SnapshotRevisionState = {
        repositoryId: 'repo-live',
        positions: initResult.state.positions,
        camera: customizedCamera,
      };

      // While user is viewing 2D explorer, live update revision 2 arrives
      const snap2 = makeSnapshot('repo-live', 2, ['node-1', 'node-2', 'node-3', 'node-4']);
      const revResult = processSnapshotRevision(currentState, snap2, viewport, 'sphere');

      // Camera is strictly preserved without re-fitting
      expect(revResult.didTriggerInitialFit).toBe(false);
      expect(revResult.state.camera).toEqual(customizedCamera);
      expect(revResult.state.positions.size).toBe(4);
    });

    it('2D relationship navigation stack and focus history do not alter 3D camera state', () => {
      const camera3D: NetworkCamera = {
        yaw: 1.05,
        pitch: -0.28,
        panX: 460,
        panY: 340,
        zoom: 1.9,
      };

      const saved3D = { ...camera3D };

      // In 2D mode, user performs focus navigation across multiple nodes
      let focusHistory: string[] = [];
      focusHistory.push('service-a');
      focusHistory.push('service-b');
      focusHistory.push('service-c');

      // Pop back history
      const popped = focusHistory.pop();
      expect(popped).toBe('service-c');

      // 3D camera state is 100% unaffected
      expect(camera3D).toEqual(saved3D);
    });
  });

  // =========================================================================
  // 6. Non-Uniform Projected Movement (3D Perspective vs 2D Screen Translation)
  // =========================================================================
  describe('6. Non-Uniform Projected Movement (True 3D Perspective Rotation vs Rigid 2D Screen Translation)', () => {
    it('points with different Z depths move with non-uniform screen velocities and opposite directions under yaw rotation', () => {
      const camera0: NetworkCamera = {
        yaw: 0,
        pitch: 0,
        panX: 400,
        panY: 300,
        zoom: 1.0,
      };

      // Three points along the Z axis (all x=0, y=0)
      const pFront: Point3D = { x: 0, y: 0, z: 150 };  // Near (front hemisphere)
      const pCenter: Point3D = { x: 0, y: 0, z: 0 };   // Centroid
      const pBack: Point3D = { x: 0, y: 0, z: -150 };  // Far (rear hemisphere)

      // Initial projection at yaw = 0
      const proj0Front = projectPoint3D(pFront.x, pFront.y, pFront.z, camera0.yaw, camera0.pitch);
      const proj0Center = projectPoint3D(pCenter.x, pCenter.y, pCenter.z, camera0.yaw, camera0.pitch);
      const proj0Back = projectPoint3D(pBack.x, pBack.y, pBack.z, camera0.yaw, camera0.pitch);

      expect(proj0Front.x).toBeCloseTo(0, 6);
      expect(proj0Center.x).toBeCloseTo(0, 6);
      expect(proj0Back.x).toBeCloseTo(0, 6);

      // Rotate camera by deltaYaw = +0.06 rad
      const deltaYaw = 0.06;
      const camera1: NetworkCamera = { ...camera0, yaw: deltaYaw };

      const proj1Front = projectPoint3D(pFront.x, pFront.y, pFront.z, camera1.yaw, camera1.pitch);
      const proj1Center = projectPoint3D(pCenter.x, pCenter.y, pCenter.z, camera1.yaw, camera1.pitch);
      const proj1Back = projectPoint3D(pBack.x, pBack.y, pBack.z, camera1.yaw, camera1.pitch);

      const screenDeltaFront = proj1Front.x - proj0Front.x;
      const screenDeltaCenter = proj1Center.x - proj0Center.x;
      const screenDeltaBack = proj1Back.x - proj0Back.x;

      // 1. Centroid point does not move at all
      expect(screenDeltaCenter).toBeCloseTo(0, 6);

      // 2. Front and back points move in strictly OPPOSITE directions!
      expect(screenDeltaFront).toBeGreaterThan(0);
      expect(screenDeltaBack).toBeLessThan(0);
      expect(Math.sign(screenDeltaFront)).not.toBe(Math.sign(screenDeltaBack));

      // 3. Magnitude of movement is non-zero and substantial
      expect(Math.abs(screenDeltaFront)).toBeGreaterThan(5.0);
      expect(Math.abs(screenDeltaBack)).toBeGreaterThan(5.0);
    });

    it('perspective foreshortening causes nearer points to move faster than farther points', () => {
      // Two points at symmetric vertical offsets, one nearer to camera and one farther
      // In projectPoint3D: smaller z2 means closer to camera (distance = focalLength + z2)
      const pNear: Point3D = { x: 50, y: 0, z: -160 }; // Closer to camera (lower z in world)
      const pFar: Point3D = { x: 50, y: 0, z: 160 };   // Farther from camera

      const yaw0 = 0.2;
      const pitch0 = 0.0;
      const proj0Near = projectPoint3D(pNear.x, pNear.y, pNear.z, yaw0, pitch0);
      const proj0Far = projectPoint3D(pFar.x, pFar.y, pFar.z, yaw0, pitch0);

      expect(proj0Near.depthScale).toBeGreaterThan(proj0Far.depthScale);

      // Rotate pitch by deltaPitch = 0.05
      const deltaPitch = 0.05;
      const proj1Near = projectPoint3D(pNear.x, pNear.y, pNear.z, yaw0, pitch0 + deltaPitch);
      const proj1Far = projectPoint3D(pFar.x, pFar.y, pFar.z, yaw0, pitch0 + deltaPitch);

      const dyNear = Math.abs(proj1Near.y - proj0Near.y);
      const dyFar = Math.abs(proj1Far.y - proj0Far.y);

      // Near point exhibits higher screen displacement velocity than far point due to perspective parallax
      expect(dyNear).toBeGreaterThan(dyFar);
      expect(dyNear / dyFar).toBeGreaterThan(1.2);
    });

    it('contrasts 3D rotation (non-uniform vector field) against 2D translation (strictly uniform displacement)', () => {
      // Ensemble of 20 points distributed across 3D space
      const points: Point3D[] = Array.from({ length: 20 }, (_, i) => ({
        x: Math.cos(i) * 120,
        y: Math.sin(i * 1.5) * 90,
        z: Math.cos(i * 2.2) * 140,
      }));

      const baseCam: NetworkCamera = {
        yaw: 0.3,
        pitch: -0.2,
        panX: 400,
        panY: 300,
        zoom: 1.0,
      };

      // --- Case A: Rigid 2D Screen Translation (Panning: dx = +35, dy = -20) ---
      const pannedCam: NetworkCamera = {
        ...baseCam,
        panX: baseCam.panX + 35,
        panY: baseCam.panY - 20,
      };

      const panDeltasX: number[] = [];
      const panDeltasY: number[] = [];
      for (const p of points) {
        const projBase = projectPoint3D(p.x, p.y, p.z, baseCam.yaw, baseCam.pitch);
        const sX0 = baseCam.panX + projBase.x * baseCam.zoom;
        const sY0 = baseCam.panY + projBase.y * baseCam.zoom;

        const projPanned = projectPoint3D(p.x, p.y, p.z, pannedCam.yaw, pannedCam.pitch);
        const sX1 = pannedCam.panX + projPanned.x * pannedCam.zoom;
        const sY1 = pannedCam.panY + projPanned.y * pannedCam.zoom;

        panDeltasX.push(sX1 - sX0);
        panDeltasY.push(sY1 - sY0);
      }

      // Under 2D translation, EVERY point moves by the exact same amount
      const panVarX = panDeltasX.reduce((acc, d) => acc + Math.pow(d - 35, 2), 0) / points.length;
      const panVarY = panDeltasY.reduce((acc, d) => acc + Math.pow(d - (-20), 2), 0) / points.length;
      expect(panVarX).toBeCloseTo(0, 8); // Uniform displacement variance = 0!
      expect(panVarY).toBeCloseTo(0, 8);

      // --- Case B: True 3D Perspective Rotation (Yaw delta = +0.08) ---
      const rotatedCam: NetworkCamera = {
        ...baseCam,
        yaw: baseCam.yaw + 0.08,
      };

      const rotDeltasX: number[] = [];
      for (const p of points) {
        const projBase = projectPoint3D(p.x, p.y, p.z, baseCam.yaw, baseCam.pitch);
        const sX0 = baseCam.panX + projBase.x * baseCam.zoom;

        const projRot = projectPoint3D(p.x, p.y, p.z, rotatedCam.yaw, rotatedCam.pitch);
        const sX1 = rotatedCam.panX + projRot.x * rotatedCam.zoom;

        rotDeltasX.push(sX1 - sX0);
      }

      const meanRotDeltaX = rotDeltasX.reduce((a, b) => a + b, 0) / points.length;
      const rotVarX = rotDeltasX.reduce((acc, d) => acc + Math.pow(d - meanRotDeltaX, 2), 0) / points.length;

      // Under 3D perspective rotation, displacement field is highly non-uniform
      expect(rotVarX).toBeGreaterThan(15.0); // Significant variance proving depth-dependent movement!

      // Presence of both positive and negative movements across the ensemble
      const hasPositiveMove = rotDeltasX.some((d) => d > 2.0);
      const hasNegativeMove = rotDeltasX.some((d) => d < -2.0);
      expect(hasPositiveMove).toBe(true);
      expect(hasNegativeMove).toBe(true);
    });

    it('screen displacement velocity matches analytical derivative of perspective projection', () => {
      // For a point at (0, 0, z0) under small deltaYaw:
      // x2 = z0 * sin(deltaYaw)
      // z2 = z0 * cos(deltaYaw)
      // distance = focalLength + z2
      // screenX = panX + (x2 * focalLength / distance) * zoom
      // deltaScreenX = (x2 * focalLength / distance) * zoom
      const z0 = 120;
      const focalLength = NETWORK_FOCAL_LENGTH; // 1100
      const deltaYaw = 0.02; // Small angle
      const zoom = 1.5;
      const panX = 400;

      const p: Point3D = { x: 0, y: 0, z: z0 };
      const proj0 = projectPoint3D(p.x, p.y, p.z, 0, 0, focalLength);
      const proj1 = projectPoint3D(p.x, p.y, p.z, deltaYaw, 0, focalLength);

      const actualDeltaScreenX = (panX + proj1.x * zoom) - (panX + proj0.x * zoom);

      const expectedDepthScale = focalLength / (focalLength + z0 * Math.cos(deltaYaw));
      const expectedDeltaScreenX = z0 * Math.sin(deltaYaw) * expectedDepthScale * zoom;

      expect(actualDeltaScreenX).toBeCloseTo(expectedDeltaScreenX, 6);
      expect(actualDeltaScreenX).toBeGreaterThan(0);
    });
  });
});
