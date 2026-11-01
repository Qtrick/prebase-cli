import { describe, it, expect } from 'vitest';
import {
  DEFAULT_YAW,
  DEFAULT_PITCH,
  MIN_ZOOM,
  MAX_ZOOM,
  DEFAULT_ZOOM,
  NETWORK_FOCAL_LENGTH,
  PITCH_CLAMP_LIMIT,
  clamp,
  wrapRotationAngle,
  clampPitch,
  computeGraphCentroid,
  normalizeDepthScale,
  computeDepthAlpha,
  projectPoint3D,
  projectGraph,
  computeNetworkFitTransform,
  isNodeVisibleInViewport,
  applyZoomAroundCursor,
  applyZoomAroundCenter,
  computeCenterLockedTransform,
  isCenterDeadZone,
  computeOrbitRevealCamera,
  computeRevealCamera,
  createDefaultCamera,
  resetNetworkCamera,
  normalizeWheelZoomDelta,
  computeContinuousZoomFactor,
} from '../render/networkRenderMath';
import { FileNode, NetworkCamera, Point3D, ViewportInsets } from '../../../types/graph';

const createNode = (id: string): FileNode => ({
  id,
  relative_path: `${id}.ts`,
  filename: `${id}.ts`,
  language: 'typescript',
  size_bytes: 100,
  file_kind: 'Source',
  analysis_status: 'Analyzed',
  direct_dependency_count: 1,
  direct_dependent_count: 1,
});

describe('Network Camera & 3D Projection Math', () => {
  describe('Zero and Known Axis Rotations', () => {
    it('projects 3D points identically when rotation angles are zero (yaw=0, pitch=0)', () => {
      const x = 120;
      const y = -80;
      const z = 200;

      const projected = projectPoint3D(x, y, z, 0, 0);

      const expectedDistance = NETWORK_FOCAL_LENGTH + z; // 1300
      const expectedScale = NETWORK_FOCAL_LENGTH / expectedDistance; // 1100 / 1300 ≈ 0.84615

      expect(projected.z).toBe(z);
      expect(projected.depthScale).toBeCloseTo(expectedScale, 6);
      expect(projected.x).toBeCloseTo(x * expectedScale, 6);
      expect(projected.y).toBeCloseTo(y * expectedScale, 6);
    });

    it('swaps coordinates predictably under quarter-turn horizontal rotation (yaw = Math.PI / 2, pitch = 0)', () => {
      // Rotating +90 deg around Y: x' = z, z' = -x
      // A point on +X (100, 0, 0) should rotate to -Z (0, 0, -100)
      const pOnX = projectPoint3D(100, 0, 0, Math.PI / 2, 0);
      expect(pOnX.x).toBeCloseTo(0, 6);
      expect(pOnX.y).toBeCloseTo(0, 6);
      expect(pOnX.z).toBeCloseTo(-100, 6);

      // A point on +Z (0, 0, 100) should rotate to +X (100, 0, 0)
      const pOnZ = projectPoint3D(0, 0, 100, Math.PI / 2, 0);
      expect(pOnZ.z).toBeCloseTo(0, 6);
      expect(pOnZ.y).toBeCloseTo(0, 6);
      // Since rotated z is 0, distance is focalLength and depthScale is 1.0
      expect(pOnZ.depthScale).toBeCloseTo(1.0, 6);
      expect(pOnZ.x).toBeCloseTo(100, 6);
    });

    it('transforms vertical coordinates predictably under quarter-turn pitch rotation (yaw = 0, pitch = Math.PI / 2)', () => {
      // Pitch +90 deg around X: y' = -z, z' = y
      // A point on +Y (0, 100, 0) should rotate to +Z (0, 0, 100)
      const pOnY = projectPoint3D(0, 100, 0, 0, Math.PI / 2);
      expect(pOnY.x).toBeCloseTo(0, 6);
      expect(pOnY.y).toBeCloseTo(0, 6);
      expect(pOnY.z).toBeCloseTo(100, 6);

      // A point on +Z (0, 0, 100) should rotate to -Y (0, -100, 0)
      const pOnZ = projectPoint3D(0, 0, 100, 0, Math.PI / 2);
      expect(pOnZ.x).toBeCloseTo(0, 6);
      expect(pOnZ.z).toBeCloseTo(0, 6);
      expect(pOnZ.depthScale).toBeCloseTo(1.0, 6);
      expect(pOnZ.y).toBeCloseTo(-100, 6);
    });

    it('computes deterministic projected coordinates under default combined rotation (DEFAULT_YAW, DEFAULT_PITCH)', () => {
      const x = 60;
      const y = -40;
      const z = 90;

      const projected = projectPoint3D(x, y, z, DEFAULT_YAW, DEFAULT_PITCH);

      // Analytical verification with identical math
      const cp = Math.cos(DEFAULT_PITCH);
      const sp = Math.sin(DEFAULT_PITCH);
      const y1 = y * cp - z * sp;
      const z1 = y * sp + z * cp;

      const cy = Math.cos(DEFAULT_YAW);
      const sy = Math.sin(DEFAULT_YAW);
      const x2 = x * cy + z1 * sy;
      const z2 = -x * sy + z1 * cy;

      const distance = Math.max(NETWORK_FOCAL_LENGTH * 0.25, NETWORK_FOCAL_LENGTH + z2);
      const expectedScale = NETWORK_FOCAL_LENGTH / distance;

      expect(projected.x).toBeCloseTo(x2 * expectedScale, 6);
      expect(projected.y).toBeCloseTo(y1 * expectedScale, 6);
      expect(projected.z).toBeCloseTo(z2, 6);
      expect(projected.depthScale).toBeCloseTo(expectedScale, 6);
      expect(Number.isFinite(projected.x)).toBe(true);
      expect(Number.isFinite(projected.y)).toBe(true);
    });
  });

  describe('Centroid and Rotation Origin Invariance', () => {
    it('keeps centroid at rotation origin so (centroid.x, centroid.y, centroid.z) projects to (0, 0)', () => {
      const points: Point3D[] = [
        { x: 100, y: 200, z: -50 },
        { x: -50, y: 50, z: 150 },
        { x: 10, y: -70, z: 20 },
      ];

      const centroid = computeGraphCentroid(points);
      expect(centroid.x).toBeCloseTo(20, 6);
      expect(centroid.y).toBeCloseTo(60, 6);
      expect(centroid.z).toBeCloseTo(40, 6);

      // Relative to centroid, the centroid itself is (0, 0, 0)
      const localCentroid = {
        x: centroid.x - centroid.x,
        y: centroid.y - centroid.y,
        z: centroid.z - centroid.z,
      };

      // Invariant: local (0, 0, 0) projects to (0, 0) across ANY yaw and pitch
      const testAngles = [
        { yaw: 0, pitch: 0 },
        { yaw: DEFAULT_YAW, pitch: DEFAULT_PITCH },
        { yaw: Math.PI / 3, pitch: -Math.PI / 4 },
        { yaw: -1.2, pitch: 0.8 },
      ];

      for (const { yaw, pitch } of testAngles) {
        const proj = projectPoint3D(localCentroid.x, localCentroid.y, localCentroid.z, yaw, pitch);
        expect(proj.x).toBeCloseTo(0, 6);
        expect(proj.y).toBeCloseTo(0, 6);
        expect(proj.z).toBeCloseTo(0, 6);
        expect(proj.depthScale).toBeCloseTo(1.0, 6);
      }
    });

    it('centers projected node on screen at (panX, panY) when located at graph centroid', () => {
      const nodes = [createNode('center-node')];
      const positions = new Map<string, Point3D>([['center-node', { x: 500, y: -300, z: 200 }]]);
      const centroid: Point3D = { x: 500, y: -300, z: 200 };

      const camera: NetworkCamera = {
        yaw: DEFAULT_YAW,
        pitch: DEFAULT_PITCH,
        panX: 450,
        panY: 350,
        zoom: 1.5,
      };

      const result = projectGraph(nodes, positions, centroid, camera);
      expect(result.projectedList).toHaveLength(1);

      const nodeProj = result.projectedList[0];
      // Since localPos is (0,0,0), screen position must match camera pan exactly
      expect(nodeProj.screenX).toBeCloseTo(camera.panX, 6);
      expect(nodeProj.screenY).toBeCloseTo(camera.panY, 6);
      expect(nodeProj.projected.depthScale).toBeCloseTo(1.0, 6);
    });

    it('handles empty or degenerate positions safely in computeGraphCentroid', () => {
      expect(computeGraphCentroid([])).toEqual({ x: 0, y: 0, z: 0 });

      const single: Point3D[] = [{ x: 42, y: -18, z: 99 }];
      expect(computeGraphCentroid(single)).toEqual({ x: 42, y: -18, z: 99 });
    });
  });

  describe('Perspective Scaling, Depth Ordering, and Numerical Safety', () => {
    it('guarantees depthScale is strictly positive, finite, and clamped at near singularity', () => {
      // Extremely close / in front: z = -100000, distance clamped to focalLength * 0.25 (275)
      const pExtremeNear = projectPoint3D(0, 0, -100000);
      expect(Number.isFinite(pExtremeNear.depthScale)).toBe(true);
      expect(pExtremeNear.depthScale).toBeCloseTo(NETWORK_FOCAL_LENGTH / (NETWORK_FOCAL_LENGTH * 0.25), 6); // 4.0
      expect(pExtremeNear.depthScale).toBeGreaterThan(0);

      // Exact singularity: z = -NETWORK_FOCAL_LENGTH
      const pSingularity = projectPoint3D(0, 0, -NETWORK_FOCAL_LENGTH);
      expect(Number.isFinite(pSingularity.depthScale)).toBe(true);
      expect(pSingularity.depthScale).toBe(4.0);

      // Extremely far away: z = 100000
      const pExtremeFar = projectPoint3D(0, 0, 100000);
      expect(Number.isFinite(pExtremeFar.depthScale)).toBe(true);
      expect(pExtremeFar.depthScale).toBeGreaterThan(0);
      expect(pExtremeFar.depthScale).toBeLessThan(0.02);
    });

    it('preserves depth ordering such that nearer objects have higher depthScale and depthAlpha', () => {
      const near = projectPoint3D(0, 0, -250);
      const mid = projectPoint3D(0, 0, 0);
      const far = projectPoint3D(0, 0, 250);

      // Nearer objects (lower z in camera view) are closer to focal plane -> larger depthScale
      expect(near.depthScale).toBeGreaterThan(mid.depthScale);
      expect(mid.depthScale).toBeGreaterThan(far.depthScale);

      // Alpha values follow depthScale monotonically
      expect(computeDepthAlpha(near.depthScale)).toBeGreaterThan(computeDepthAlpha(mid.depthScale));
      expect(computeDepthAlpha(mid.depthScale)).toBeGreaterThan(computeDepthAlpha(far.depthScale));
    });

    it('sorts nodes in projectGraph back-to-front (ascending projected z) for correct painter algorithm', () => {
      const nodes = [createNode('near'), createNode('far'), createNode('mid')];
      const positions = new Map<string, Point3D>([
        ['near', { x: 0, y: 0, z: -150 }],
        ['far', { x: 0, y: 0, z: 200 }],
        ['mid', { x: 0, y: 0, z: 10 }],
      ]);
      const centroid: Point3D = { x: 0, y: 0, z: 0 };
      const camera: NetworkCamera = { yaw: 0, pitch: 0, panX: 0, panY: 0, zoom: 1 };

      const graph = projectGraph(nodes, positions, centroid, camera);
      expect(graph.projectedList.map((n) => n.id)).toEqual(['near', 'mid', 'far']);
      expect(graph.projectedList[0].projected.z).toBeLessThan(graph.projectedList[1].projected.z);
      expect(graph.projectedList[1].projected.z).toBeLessThan(graph.projectedList[2].projected.z);
    });

    it('normalizes depthScale into [0, 1] bounded range', () => {
      expect(normalizeDepthScale(0.65)).toBe(0);
      expect(normalizeDepthScale(1.5)).toBe(1);
      expect(normalizeDepthScale(0.0)).toBe(0);
      expect(normalizeDepthScale(10.0)).toBe(1);
      expect(normalizeDepthScale(NaN)).toBe(0.5);
    });
  });

  describe('Zoom Clamping and Pitch Limits', () => {
    it('clamps zoom strictly between MIN_ZOOM (0.15) and MAX_ZOOM (4.0)', () => {
      expect(MIN_ZOOM).toBe(0.15);
      expect(MAX_ZOOM).toBe(4.0);

      expect(clamp(0.02, MIN_ZOOM, MAX_ZOOM)).toBe(MIN_ZOOM);
      expect(clamp(9.5, MIN_ZOOM, MAX_ZOOM)).toBe(MAX_ZOOM);
      expect(clamp(1.75, MIN_ZOOM, MAX_ZOOM)).toBe(1.75);
    });

    it('clamps pitch angle to [-PITCH_CLAMP_LIMIT, PITCH_CLAMP_LIMIT] to avoid upside-down inversion', () => {
      expect(PITCH_CLAMP_LIMIT).toBeCloseTo(1.48, 2);

      expect(clampPitch(2.5)).toBe(PITCH_CLAMP_LIMIT);
      expect(clampPitch(-3.0)).toBe(-PITCH_CLAMP_LIMIT);
      expect(clampPitch(0.85)).toBe(0.85);
      expect(clampPitch(-0.45)).toBe(-0.45);
      expect(clampPitch(PITCH_CLAMP_LIMIT)).toBe(PITCH_CLAMP_LIMIT);
      expect(clampPitch(-PITCH_CLAMP_LIMIT)).toBe(-PITCH_CLAMP_LIMIT);
    });

    it('wraps yaw angles seamlessly into [-PI, PI]', () => {
      // Full revolutions should normalize to 0
      expect(wrapRotationAngle(0)).toBeCloseTo(0, 6);
      expect(wrapRotationAngle(Math.PI * 2)).toBeCloseTo(0, 6);
      expect(wrapRotationAngle(-Math.PI * 2)).toBeCloseTo(0, 6);
      expect(wrapRotationAngle(Math.PI * 4)).toBeCloseTo(0, 6);

      // Quarter turns
      expect(wrapRotationAngle(Math.PI / 2)).toBeCloseTo(Math.PI / 2, 6);
      expect(wrapRotationAngle(-Math.PI / 2)).toBeCloseTo(-Math.PI / 2, 6);

      // Multi-turn angles: 3*PI -> -PI or PI
      const wrapped3Pi = wrapRotationAngle(3 * Math.PI);
      expect(Math.abs(wrapped3Pi)).toBeCloseTo(Math.PI, 6);

      // Negative multi-turn: -5*PI
      const wrappedNeg5Pi = wrapRotationAngle(-5 * Math.PI);
      expect(Math.abs(wrappedNeg5Pi)).toBeCloseTo(Math.PI, 6);

      // Offset angles
      expect(wrapRotationAngle(Math.PI * 4 + 0.65)).toBeCloseTo(0.65, 6);
      expect(wrapRotationAngle(-Math.PI * 4 - 0.65)).toBeCloseTo(-0.65, 6);
    });
  });

  describe('Cursor-Anchored Zoom', () => {
    it('keeps the world point beneath cursor stationary in screen coordinates', () => {
      const camera: NetworkCamera = {
        yaw: DEFAULT_YAW,
        pitch: DEFAULT_PITCH,
        panX: 400,
        panY: 300,
        zoom: 1.0,
      };

      const cursorX = 550;
      const cursorY = 380;

      // World coordinate beneath cursor prior to zoom
      const worldX = (cursorX - camera.panX) / camera.zoom;
      const worldY = (cursorY - camera.panY) / camera.zoom;

      // 1. Zoom In (factor 1.5)
      const zoomedIn = applyZoomAroundCursor(camera, 1.5, cursorX, cursorY);
      expect(zoomedIn.zoom).toBeCloseTo(1.5, 6);

      const screenXAfterIn = zoomedIn.panX + worldX * zoomedIn.zoom;
      const screenYAfterIn = zoomedIn.panY + worldY * zoomedIn.zoom;
      expect(screenXAfterIn).toBeCloseTo(cursorX, 6);
      expect(screenYAfterIn).toBeCloseTo(cursorY, 6);

      // 2. Zoom Out (factor 0.7)
      const zoomedOut = applyZoomAroundCursor(camera, 0.7, cursorX, cursorY);
      expect(zoomedOut.zoom).toBeCloseTo(0.7, 6);

      const screenXAfterOut = zoomedOut.panX + worldX * zoomedOut.zoom;
      const screenYAfterOut = zoomedOut.panY + worldY * zoomedOut.zoom;
      expect(screenXAfterOut).toBeCloseTo(cursorX, 6);
      expect(screenYAfterOut).toBeCloseTo(cursorY, 6);
    });

    it('preserves camera yaw and pitch when performing cursor-anchored zoom', () => {
      const camera: NetworkCamera = {
        yaw: 0.95,
        pitch: -0.42,
        panX: 200,
        panY: 150,
        zoom: 1.2,
      };

      const nextCamera = applyZoomAroundCursor(camera, 1.25, 300, 250);
      expect(nextCamera.yaw).toBe(camera.yaw);
      expect(nextCamera.pitch).toBe(camera.pitch);
    });

    it('clamps zoom within [MIN_ZOOM, MAX_ZOOM] and prevents drift at limits', () => {
      const cameraAtMax: NetworkCamera = {
        yaw: DEFAULT_YAW,
        pitch: DEFAULT_PITCH,
        panX: 400,
        panY: 300,
        zoom: MAX_ZOOM,
      };

      // Further zoom in beyond MAX_ZOOM has no effect
      const clampedMax = applyZoomAroundCursor(cameraAtMax, 2.0, 400, 300);
      expect(clampedMax.zoom).toBe(MAX_ZOOM);
      expect(clampedMax.panX).toBe(cameraAtMax.panX);
      expect(clampedMax.panY).toBe(cameraAtMax.panY);

      const cameraAtMin: NetworkCamera = {
        yaw: DEFAULT_YAW,
        pitch: DEFAULT_PITCH,
        panX: 400,
        panY: 300,
        zoom: MIN_ZOOM,
      };

      // Further zoom out beyond MIN_ZOOM has no effect
      const clampedMin = applyZoomAroundCursor(cameraAtMin, 0.5, 400, 300);
      expect(clampedMin.zoom).toBe(MIN_ZOOM);
      expect(clampedMin.panX).toBe(cameraAtMin.panX);
      expect(clampedMin.panY).toBe(cameraAtMin.panY);
    });
  });

  describe('Fit Bounds & Viewport Insets', () => {
    it('computes pan and zoom to fit bounds neatly inside usable viewport preserving rotation', () => {
      const bounds = {
        minX: -200,
        maxX: 200,
        minY: -100,
        maxY: 100,
      };
      const viewportWidth = 1200;
      const viewportHeight = 800;
      const insets: ViewportInsets = {
        left: 200,
        right: 300,
        top: 50,
        bottom: 50,
      };
      const padding = 60;

      const fit = computeNetworkFitTransform(bounds, viewportWidth, viewportHeight, insets, padding);

      const usableW = viewportWidth - insets.left! - insets.right!; // 700
      const usableH = viewportHeight - insets.top! - insets.bottom!; // 700
      const expectedCenterX = insets.left! + usableW / 2; // 550
      const expectedCenterY = insets.top! + usableH / 2; // 400

      // Centered at bounds midpoint (0, 0)
      expect(fit.panX).toBeCloseTo(expectedCenterX, 6);
      expect(fit.panY).toBeCloseTo(expectedCenterY, 6);

      // Usable width minus 2*padding = 700 - 120 = 580; graphWidth = 400 -> scaleX = 580 / 400 = 1.45
      // Usable height minus 2*padding = 700 - 120 = 580; graphHeight = 200 -> scaleY = 580 / 200 = 2.9
      expect(fit.zoom).toBeCloseTo(1.45, 6);

      // Verify bounds corners fit inside usable inset area
      const leftScreen = fit.panX + bounds.minX * fit.zoom;
      const rightScreen = fit.panX + bounds.maxX * fit.zoom;
      expect(leftScreen).toBeGreaterThanOrEqual(insets.left! + padding - 1e-4);
      expect(rightScreen).toBeLessThanOrEqual(viewportWidth - insets.right! - padding + 1e-4);
    });

    it('shifts usable center dynamically with asymmetric sidebar and inspector insets', () => {
      const bounds = { minX: -50, maxX: 50, minY: -50, maxY: 50 };
      const width = 1000;
      const height = 600;

      // 1. Sidebar only (left = 320)
      const sidebarFit = computeNetworkFitTransform(bounds, width, height, { left: 320 });
      // Usable center X is 320 + (1000 - 320) / 2 = 660 (shifted right)
      expect(sidebarFit.panX).toBeCloseTo(660, 6);

      // 2. Inspector only (right = 320)
      const inspectorFit = computeNetworkFitTransform(bounds, width, height, { right: 320 });
      // Usable center X is 0 + (1000 - 320) / 2 = 340 (shifted left)
      expect(inspectorFit.panX).toBeCloseTo(340, 6);
    });

    it('handles degenerate / point bounds safely without NaN or division by zero', () => {
      const pointBounds = { minX: 10, maxX: 10, minY: 20, maxY: 20 };
      const fit = computeNetworkFitTransform(pointBounds, 800, 600);

      expect(Number.isFinite(fit.panX)).toBe(true);
      expect(Number.isFinite(fit.panY)).toBe(true);
      expect(fit.zoom).toBeLessThanOrEqual(MAX_ZOOM);
      expect(fit.zoom).toBeGreaterThanOrEqual(MIN_ZOOM);
    });
  });

  describe('Reset Camera', () => {
    it('restores DEFAULT_YAW (0.55), DEFAULT_PITCH (0.28), and DEFAULT_ZOOM (1.0)', () => {
      expect(DEFAULT_YAW).toBe(0.55);
      expect(DEFAULT_PITCH).toBe(0.28);
      expect(DEFAULT_ZOOM).toBe(1.0);

      const modifiedCamera: NetworkCamera = {
        yaw: 1.85,
        pitch: -1.2,
        panX: 1200,
        panY: -450,
        zoom: 3.5,
      };

      const reset = resetNetworkCamera(modifiedCamera, 1000, 600);
      expect(reset.yaw).toBe(DEFAULT_YAW);
      expect(reset.pitch).toBe(DEFAULT_PITCH);
      expect(reset.zoom).toBe(DEFAULT_ZOOM);
      expect(reset.panX).toBe(500);
      expect(reset.panY).toBe(300);
    });

    it('centers camera within usable insets upon reset', () => {
      const insets: ViewportInsets = { left: 250, right: 150, top: 40, bottom: 60 };
      const camera = createDefaultCamera(1000, 600, insets);

      // Usable width: 1000 - 250 - 150 = 600. Center: 250 + 300 = 550
      // Usable height: 600 - 40 - 60 = 500. Center: 40 + 250 = 290
      expect(camera.panX).toBe(550);
      expect(camera.panY).toBe(290);
      expect(camera.yaw).toBe(DEFAULT_YAW);
      expect(camera.pitch).toBe(DEFAULT_PITCH);
      expect(camera.zoom).toBe(DEFAULT_ZOOM);
    });
  });

  describe('Node Visibility Check', () => {
    it('returns true when a node is fully visible inside usable insets with margin', () => {
      const visible = isNodeVisibleInViewport(500, 300, 15, 1000, 600, { left: 200, right: 200 }, 40);
      expect(visible).toBe(true);
    });

    it('returns false when a node is clipped by sidebar or inspector insets', () => {
      const insets: ViewportInsets = { left: 240, right: 300, top: 50, bottom: 50 };
      const margin = 30;

      // Usable horizontal range: [240 + 30, 1000 - 300 - 30] = [270, 670]
      // Node inside sidebar inset
      expect(isNodeVisibleInViewport(200, 300, 10, 1000, 600, insets, margin)).toBe(false);

      // Node inside inspector inset
      expect(isNodeVisibleInViewport(750, 300, 10, 1000, 600, insets, margin)).toBe(false);

      // Node just grazing the left margin boundary
      expect(isNodeVisibleInViewport(275, 300, 10, 1000, 600, insets, margin)).toBe(false); // 275 - 10 = 265 < 270
      expect(isNodeVisibleInViewport(285, 300, 10, 1000, 600, insets, margin)).toBe(true); // 285 - 10 = 275 >= 270
    });

    it('returns false when a node is clipped vertically', () => {
      const insets: ViewportInsets = { top: 60, bottom: 40 };
      const margin = 20;

      // Above top margin (60 + 20 = 80)
      expect(isNodeVisibleInViewport(400, 50, 10, 800, 600, insets, margin)).toBe(false);

      // Below bottom margin (600 - 40 - 20 = 540)
      expect(isNodeVisibleInViewport(400, 560, 10, 800, 600, insets, margin)).toBe(false);
    });
  });

  describe('Wheel Zoom Normalization and Continuous Zoom Factor', () => {
    it('normalizes wheel delta according to deltaMode and ctrlKey modifiers with clamping', () => {
      // Pixel mode (mode 0)
      expect(normalizeWheelZoomDelta({ deltaY: 50, deltaMode: 0 })).toBe(50);

      // Line mode (mode 1)
      expect(normalizeWheelZoomDelta({ deltaY: 2, deltaMode: 1 })).toBe(48);

      // Pinch zoom with ctrlKey
      expect(normalizeWheelZoomDelta({ deltaY: 20, deltaMode: 0, ctrlKey: true })).toBe(30);

      // Clamps extreme wheel deltas to [-320, 320]
      expect(normalizeWheelZoomDelta({ deltaY: 1000, deltaMode: 0 })).toBe(320);
      expect(normalizeWheelZoomDelta({ deltaY: -1000, deltaMode: 0 })).toBe(-320);
    });

    it('computes continuous smooth zoom factor', () => {
      expect(computeContinuousZoomFactor(0)).toBe(1.0);
      expect(computeContinuousZoomFactor(100)).toBeLessThan(1.0); // Scroll down -> zoom out
      expect(computeContinuousZoomFactor(-100)).toBeGreaterThan(1.0); // Scroll up -> zoom in
    });
  });

  describe('Center Locking and Orbit-Preserving Reveal', () => {
    const baseCamera: NetworkCamera = {
      yaw: 0.55,
      pitch: 0.28,
      panX: 400,
      panY: 300,
      zoom: 1.0,
    };

    it('applyZoomAroundCenter keeps usable viewport center pivot strictly stationary', () => {
      const insets: ViewportInsets = { top: 60, bottom: 20, left: 40, right: 40 };
      const width = 800;
      const height = 600;
      const usableCenterX = 40 + (800 - 80) / 2; // 400
      const usableCenterY = 60 + (600 - 80) / 2; // 320

      const camAtCenter: NetworkCamera = {
        ...baseCamera,
        panX: usableCenterX,
        panY: usableCenterY,
      };

      const zoomed = applyZoomAroundCenter(camAtCenter, 1.5, width, height, insets);
      expect(zoomed.zoom).toBe(1.5);
      expect(zoomed.panX).toBeCloseTo(usableCenterX, 6);
      expect(zoomed.panY).toBeCloseTo(usableCenterY, 6);
    });

    it('computeCenterLockedTransform aligns bounds center to usable viewport center', () => {
      const insets: ViewportInsets = { top: 60, bottom: 20, left: 20, right: 20 };
      const bounds = { minX: -100, maxX: 100, minY: -50, maxY: 50 };
      const transform = computeCenterLockedTransform(bounds, 800, 600, 1.2, insets);

      // Usable center is (20 + 380 = 400, 60 + 260 = 320)
      // Graph mid is (0, 0)
      expect(transform.panX).toBe(400);
      expect(transform.panY).toBe(320);
      expect(transform.zoom).toBe(1.2);
    });

    it('isCenterDeadZone detects sub-pixel jitter threshold', () => {
      const current = { panX: 400.2, panY: 300.1 };
      const target = { panX: 400.0, panY: 300.0 };
      expect(isCenterDeadZone(current, target, 0.5)).toBe(true);
      expect(isCenterDeadZone(current, target, 0.1)).toBe(false);
    });

    it('computeOrbitRevealCamera rotates front hemisphere node to screen center facing forward', () => {
      const targetLocal: Point3D = { x: 80, y: 40, z: 120 };
      const pNode = {
        id: 'node-front',
        node: createNode('node-front'),
        worldPos: targetLocal,
        localPos: targetLocal,
        projected: projectPoint3D(targetLocal.x, targetLocal.y, targetLocal.z, baseCamera.yaw, baseCamera.pitch),
        screenX: 250,
        screenY: 180,
        radius: 10,
      };

      const revealedCam = computeOrbitRevealCamera(pNode, baseCamera, 800, 600);
      expect(revealedCam).not.toBeNull();

      // Project targetLocal with computed yaw & pitch
      const proj = projectPoint3D(targetLocal.x, targetLocal.y, targetLocal.z, revealedCam!.yaw, revealedCam!.pitch);
      expect(proj.x).toBeCloseTo(0, 4);
      expect(proj.y).toBeCloseTo(0, 4);
      expect(proj.z).toBeGreaterThan(0); // Front-facing
      expect(revealedCam!.panX).toBe(400); // Orbit center preserved
      expect(revealedCam!.panY).toBe(300);
    });

    it('computeOrbitRevealCamera rotates back hemisphere node (z < 0) to screen center facing forward without upside-down pitch', () => {
      const targetLocal: Point3D = { x: -60, y: 30, z: -100 };
      const pNode = {
        id: 'node-back',
        node: createNode('node-back'),
        worldPos: targetLocal,
        localPos: targetLocal,
        projected: projectPoint3D(targetLocal.x, targetLocal.y, targetLocal.z, baseCamera.yaw, baseCamera.pitch),
        screenX: 250,
        screenY: 180,
        radius: 10,
      };

      const revealedCam = computeOrbitRevealCamera(pNode, baseCamera, 800, 600);
      expect(revealedCam).not.toBeNull();

      // Pitch limit clamp check: must never exceed [-PITCH_CLAMP_LIMIT, PITCH_CLAMP_LIMIT]
      expect(Math.abs(revealedCam!.pitch)).toBeLessThanOrEqual(PITCH_CLAMP_LIMIT);

      // Project targetLocal with computed yaw & pitch
      const proj = projectPoint3D(targetLocal.x, targetLocal.y, targetLocal.z, revealedCam!.yaw, revealedCam!.pitch);
      expect(proj.x).toBeCloseTo(0, 4);
      expect(proj.y).toBeCloseTo(0, 4);
      expect(proj.z).toBeGreaterThan(0); // Rotated to front-facing!
      expect(revealedCam!.panX).toBe(400); // Orbit center preserved
      expect(revealedCam!.panY).toBe(300);
    });

    it('computeRevealCamera respects preserveOrbit flag', () => {
      const targetLocal: Point3D = { x: 50, y: -40, z: 80 };
      const pNode = {
        id: 'node-toggle',
        node: createNode('node-toggle'),
        worldPos: targetLocal,
        localPos: targetLocal,
        projected: projectPoint3D(targetLocal.x, targetLocal.y, targetLocal.z, baseCamera.yaw, baseCamera.pitch),
        screenX: 250,
        screenY: 180,
        radius: 10,
      };

      // With preserveOrbit = false: yaw and pitch are preserved, pan shifts
      const panCam = computeRevealCamera(pNode, baseCamera, 800, 600, undefined, false, false);
      expect(panCam!.yaw).toBe(baseCamera.yaw);
      expect(panCam!.pitch).toBe(baseCamera.pitch);
      expect(panCam!.panX).not.toBe(400);

      // With preserveOrbit = true: pan stays centered at 400, yaw and pitch rotate
      const orbitCam = computeRevealCamera(pNode, baseCamera, 800, 600, undefined, false, true);
      expect(orbitCam!.panX).toBe(400);
      expect(orbitCam!.panY).toBe(300);
      expect(orbitCam!.yaw).not.toBe(baseCamera.yaw);
    });
  });
});
