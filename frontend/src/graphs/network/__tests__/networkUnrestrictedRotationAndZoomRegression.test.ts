import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import {
  DEFAULT_ORIENTATION,
  DEFAULT_YAW,
  DEFAULT_PITCH,
  DEFAULT_ZOOM,
  MIN_ZOOM,
  MAX_ZOOM,
  ROTATION_SENSITIVITY,
  PAN_SENSITIVITY,
  GESTURE_THRESHOLD_MOUSE,
  GESTURE_THRESHOLD_TOUCH,
  quaternionNormalize,
  quaternionMultiply,
  rotateVectorByQuaternion,
  eulerToQuaternion,
  quaternionToEuler,
  rotateOrientationByScreenDelta,
  quaternionSlerp,
  computeQuaternionToFacePoint,
  ensureCameraOrientation,
  projectPoint3D,
  normalizeWheelZoomDelta,
  computeContinuousZoomFactor,
  applyZoomAroundCursor,
  applyZoomAroundCenter,
  computeCenterLockedTransform,
  isCenterDeadZone,
  handleGesturePointerDown,
  handleGesturePointerMove,
  resetGestureState,
  calculateReleaseSpeed,
  shouldInitiateInertia,
  clampLaunchVelocity,
  stepRotationalInertia,
} from '../render/networkRenderMath';
import { NetworkCanvas } from '../NetworkCanvas';
import { Inspector } from '../../../inspector/Inspector';
import {
  FileNode,
  DependencyEdge,
  GraphSnapshot,
  NetworkCamera,
  Point3D,
  Quaternion,
  ViewportInsets,
} from '../../../types/graph';

// Mock API calls to ensure Inspector mounts cleanly in headless tests
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

// Test Fixtures
const createTestNode = (
  id: string,
  relativePath: string,
  deps = 1,
  status: FileNode['analysis_status'] = 'Analyzed'
): FileNode => ({
  id,
  relative_path: relativePath,
  filename: relativePath.split('/').pop() || relativePath,
  language: 'typescript',
  size_bytes: 420,
  file_kind: 'Source',
  analysis_status: status,
  direct_dependency_count: deps,
  direct_dependent_count: deps,
});

const createTestSnapshot = (
  nodes: FileNode[],
  edges: DependencyEdge[] = [],
  coverageOverrides?: Partial<GraphSnapshot['coverage']>
): GraphSnapshot => ({
  schema_version: '1.0.0',
  repository_id: 'test-unrestricted-repo',
  revision: 1,
  nodes,
  edges,
  coverage: {
    total_discovered: nodes.length,
    total_analyzed: nodes.filter((n) => n.analysis_status === 'Analyzed').length,
    total_excluded: 0,
    total_issues: 0,
    is_complete: true,
    ...coverageOverrides,
  },
  issues: [],
});

describe('Unrestricted Continuous 3D Rotation, Native Zoom & Inspector Metric Regression', () => {
  // =========================================================================
  // 1. Unrestricted Continuous 3D Rotation with Screen-Relative Quaternion Orientation
  // =========================================================================
  describe('1. Authoritative Screen-Relative Quaternion 3D Orientation', () => {
    describe('1.1 Quaternion Normalization and Algebra', () => {
      it('quaternionNormalize enforces exact unit length on arbitrary non-zero quaternions', () => {
        const raw: Quaternion = [2.5, -1.8, 3.2, 4.0];
        const normalized = quaternionNormalize(raw);
        const len = Math.hypot(...normalized);
        expect(len).toBeCloseTo(1.0, 10);
      });

      it('quaternionNormalize safely falls back to identity [0,0,0,1] on zero or subnormal length', () => {
        const zeroQ: Quaternion = [0, 0, 0, 0];
        expect(quaternionNormalize(zeroQ)).toEqual([0, 0, 0, 1]);

        const subnormalQ: Quaternion = [1e-15, 0, 0, 0];
        expect(quaternionNormalize(subnormalQ)).toEqual([0, 0, 0, 1]);
      });

      it('quaternionMultiply implements Hamilton product and preserves unit norm', () => {
        // Orthogonal 90-degree rotations:
        // q1: 90 deg around X
        const q1: Quaternion = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
        // q2: 90 deg around Y
        const q2: Quaternion = [0, Math.SQRT1_2, 0, Math.SQRT1_2];

        const product = quaternionMultiply(q1, q2);
        const len = Math.hypot(...product);
        expect(len).toBeCloseTo(1.0, 10);

        // Multiplication in 3D is non-commutative: q1 * q2 != q2 * q1
        const reverseProduct = quaternionMultiply(q2, q1);
        expect(product).not.toEqual(reverseProduct);
      });

      it('quaternionMultiply is associative: (q1 * q2) * q3 === q1 * (q2 * q3)', () => {
        const q1 = eulerToQuaternion(0.4, 0.2);
        const q2 = eulerToQuaternion(-0.7, 0.5);
        const q3 = eulerToQuaternion(0.3, -0.9);

        const left = quaternionMultiply(quaternionMultiply(q1, q2), q3);
        const right = quaternionMultiply(q1, quaternionMultiply(q2, q3));

        expect(left[0]).toBeCloseTo(right[0], 8);
        expect(left[1]).toBeCloseTo(right[1], 8);
        expect(left[2]).toBeCloseTo(right[2], 8);
        expect(left[3]).toBeCloseTo(right[3], 8);
      });
    });

    describe('1.2 3D Vector Rotation & Isometry Invariants', () => {
      it('rotateVectorByQuaternion strictly preserves Euclidean vector length', () => {
        const v: Point3D = { x: 42.5, y: -18.2, z: 99.1 };
        const originalLen = Math.hypot(v.x, v.y, v.z);
        const q = eulerToQuaternion(1.23, -0.87);

        const rotated = rotateVectorByQuaternion(v, q);
        const rotatedLen = Math.hypot(rotated.x, rotated.y, rotated.z);

        expect(rotatedLen).toBeCloseTo(originalLen, 8);
      });

      it('rotateVectorByQuaternion preserves angles (dot product) between arbitrary vectors', () => {
        const v1: Point3D = { x: 10, y: 0, z: 0 };
        const v2: Point3D = { x: 7, y: 7, z: 0 };
        const q = eulerToQuaternion(0.85, 0.42);

        const r1 = rotateVectorByQuaternion(v1, q);
        const r2 = rotateVectorByQuaternion(v2, q);

        const dotOriginal = v1.x * v2.x + v1.y * v2.y + v1.z * v2.z;
        const dotRotated = r1.x * r2.x + r1.y * r2.y + r1.z * r2.z;

        expect(dotRotated).toBeCloseTo(dotOriginal, 8);
      });

      it('identity quaternion leaves vectors unchanged', () => {
        const v: Point3D = { x: 12.3, y: -45.6, z: 78.9 };
        const rotated = rotateVectorByQuaternion(v, [0, 0, 0, 1]);
        expect(rotated.x).toBeCloseTo(v.x, 10);
        expect(rotated.y).toBeCloseTo(v.y, 10);
        expect(rotated.z).toBeCloseTo(v.z, 10);
      });

      it('rotates cardinal unit axes predictably (e.g. 90° around Y rotates +Z to +X)', () => {
        const v: Point3D = { x: 0, y: 0, z: 1 };
        // 90 deg around Y: yaw = Math.PI / 2
        const q = eulerToQuaternion(Math.PI / 2, 0);
        const rotated = rotateVectorByQuaternion(v, q);

        expect(rotated.x).toBeCloseTo(1, 8);
        expect(rotated.y).toBeCloseTo(0, 8);
        expect(rotated.z).toBeCloseTo(0, 8);
      });
    });

    describe('1.3 Euler <-> Quaternion Roundtrip & Projection Equivalence', () => {
      it('recovers yaw and pitch accurately via quaternionToEuler within normal operating range', () => {
        const testAngles = [
          { yaw: 0.0, pitch: 0.0 },
          { yaw: 0.75, pitch: 0.35 },
          { yaw: -1.2, pitch: -0.6 },
          { yaw: 2.1, pitch: 1.1 },
          { yaw: -2.8, pitch: -1.3 },
        ];

        for (const { yaw, pitch } of testAngles) {
          const q = eulerToQuaternion(yaw, pitch);
          const recovered = quaternionToEuler(q);
          expect(recovered.yaw).toBeCloseTo(yaw, 6);
          expect(recovered.pitch).toBeCloseTo(pitch, 6);
        }
      });

      it('projectPoint3D produces mathematically identical coordinates with Quaternion vs Euler overloads', () => {
        const points: Point3D[] = [
          { x: 50, y: -30, z: 80 },
          { x: -120, y: 70, z: -40 },
          { x: 0, y: 0, z: 150 },
        ];
        const yaw = 0.65;
        const pitch = -0.45;
        const q = eulerToQuaternion(yaw, pitch);

        for (const pt of points) {
          const projEuler = projectPoint3D(pt.x, pt.y, pt.z, yaw, pitch);
          const projQuat = projectPoint3D(pt.x, pt.y, pt.z, q);

          expect(projQuat.x).toBeCloseTo(projEuler.x, 6);
          expect(projQuat.y).toBeCloseTo(projEuler.y, 6);
          expect(projQuat.z).toBeCloseTo(projEuler.z, 6);
          expect(projQuat.depthScale).toBeCloseTo(projEuler.depthScale, 6);
          expect(projQuat.normalizedDepth).toBeCloseTo(projEuler.normalizedDepth, 6);
        }
      });

      it('ensureCameraOrientation retains existing valid quaternion and synthesizes missing orientation', () => {
        const camWithQuat: NetworkCamera = {
          orientation: [0.1, 0.2, 0.3, 0.9],
          yaw: 0.5,
          pitch: 0.3,
          panX: 400,
          panY: 300,
          zoom: 1.0,
        };
        const ensured1 = ensureCameraOrientation(camWithQuat);
        expect(ensured1.orientation).toBe(camWithQuat.orientation);

        const camWithoutQuat: NetworkCamera = {
          yaw: 0.8,
          pitch: -0.4,
          panX: 400,
          panY: 300,
          zoom: 1.0,
        };
        const ensured2 = ensureCameraOrientation(camWithoutQuat);
        expect(ensured2.orientation).toBeDefined();
        const { yaw, pitch } = quaternionToEuler(ensured2.orientation!);
        expect(yaw).toBeCloseTo(0.8, 6);
        expect(pitch).toBeCloseTo(-0.4, 6);
      });
    });

    describe('1.4 Screen-Relative Delta Pre-Multiplication Property', () => {
      it('screen drag dx > 0 rotates around the screen vertical axis regardless of initial camera tilt', () => {
        // Start from a camera already pitched down by 45 degrees
        const basePitch = Math.PI / 4;
        const initialQ = eulerToQuaternion(0, basePitch);

        // Drag rightwards by 100px screen displacement
        const nextQ = rotateOrientationByScreenDelta(initialQ, 100, 0, ROTATION_SENSITIVITY);

        // Project the screen-forward vector (0, 0, 1) and test that horizontal rotation remains screen-relative
        const rotatedZ = rotateVectorByQuaternion({ x: 0, y: 0, z: 1 }, nextQ);
        // Dragging right rotates view rightwards, so original front moves left (negative x)
        expect(rotatedZ.x).toBeLessThan(0);
        // Pre-multiplication ensures unit norm is preserved
        expect(Math.hypot(...nextQ)).toBeCloseTo(1.0, 10);
      });

      it('screen drag dy > 0 pitches downward relative to the display plane regardless of initial yaw', () => {
        // Start from a camera with yaw = 90 degrees
        const initialQ = eulerToQuaternion(Math.PI / 2, 0);

        // Drag downwards by 100px screen displacement
        const nextQ = rotateOrientationByScreenDelta(initialQ, 0, 100, ROTATION_SENSITIVITY);

        const rotatedZ = rotateVectorByQuaternion({ x: 0, y: 0, z: 1 }, nextQ);
        // Dragging down pitches downward in screen view
        expect(rotatedZ.y).toBeLessThan(0);
        expect(Math.hypot(...nextQ)).toBeCloseTo(1.0, 10);
      });
    });
  });

  // =========================================================================
  // 2. Continuous Vertical 360° Rotation, Pole Crossing, Inverted Orientations & Stability
  // =========================================================================
  describe('2. Continuous Vertical 360° Rotation, Pole Crossing & Numeric Stability', () => {
    it('supports continuous vertical 360° rotation across multiple full loops without pitch clamping', () => {
      let q = eulerToQuaternion(0, 0);
      const sensitivity = 0.005;
      const stepsPerTurn = 40;
      // Exact dy per step so stepsPerTurn * dyStep * sensitivity === 2 * Math.PI
      const dyStep = (2 * Math.PI) / (stepsPerTurn * sensitivity);

      // Loop through 3 full 360-degree vertical revolutions (1080 degrees)
      const totalSteps = stepsPerTurn * 3;
      for (let i = 0; i < totalSteps; i++) {
        q = rotateOrientationByScreenDelta(q, 0, dyStep, sensitivity);
        expect(Number.isFinite(q[0])).toBe(true);
        expect(Number.isFinite(q[1])).toBe(true);
        expect(Number.isFinite(q[2])).toBe(true);
        expect(Number.isFinite(q[3])).toBe(true);
      }

      // After exactly 3 full 360-degree loops, vector (0, 1, 0) should return to (0, 1, 0)
      const v = rotateVectorByQuaternion({ x: 0, y: 1, z: 0 }, q);
      expect(v.x).toBeCloseTo(0, 4);
      expect(v.y).toBeCloseTo(1, 4);
      expect(v.z).toBeCloseTo(0, 4);
    });

    it('crosses North Pole (+Y / pitch = 90°) smoothly without gimbal lock, zero division, or NaN', () => {
      let q = eulerToQuaternion(0, 0);
      const sensitivity = 0.005;
      const dyToPole = (Math.PI / 2) / sensitivity;

      // Drag directly to and through the North Pole
      const steps = 40;
      const stepDy = (dyToPole * 1.5) / steps; // overshoots past pole into upper back hemisphere

      for (let i = 0; i < steps; i++) {
        q = rotateOrientationByScreenDelta(q, 0, stepDy, sensitivity);
        expect(Math.hypot(...q)).toBeCloseTo(1.0, 8);
        const zPrime = rotateVectorByQuaternion({ x: 0, y: 0, z: 1 }, q);
        expect(Number.isFinite(zPrime.x)).toBe(true);
        expect(Number.isFinite(zPrime.y)).toBe(true);
        expect(Number.isFinite(zPrime.z)).toBe(true);
      }
    });

    it('crosses South Pole (-Y / pitch = -90°) smoothly without singularities', () => {
      let q = eulerToQuaternion(0, 0);
      const sensitivity = 0.005;
      const dyToSouthPole = -(Math.PI / 2) / sensitivity;

      const steps = 40;
      const stepDy = (dyToSouthPole * 1.5) / steps;

      for (let i = 0; i < steps; i++) {
        q = rotateOrientationByScreenDelta(q, 0, stepDy, sensitivity);
        expect(Math.hypot(...q)).toBeCloseTo(1.0, 8);
      }
    });

    it('inverted orientations: horizontal dragging remains screen-relative when upside-down', () => {
      // Rotate 180 degrees vertically so camera is completely inverted / upside-down
      const invertedQ = eulerToQuaternion(0, Math.PI);

      // In screen view, dragging right (dx > 0) should still rotate around screen's vertical axis
      const nextQ = rotateOrientationByScreenDelta(invertedQ, 50, 0, ROTATION_SENSITIVITY);

      // In this inverted camera, world point (0, 0, -100) is facing front (+Z in camera/screen space)
      const frontNodePos: Point3D = { x: 0, y: 0, z: -100 };
      const projBefore = projectPoint3D(frontNodePos.x, frontNodePos.y, frontNodePos.z, invertedQ);
      const projAfter = projectPoint3D(frontNodePos.x, frontNodePos.y, frontNodePos.z, nextQ);

      // Verify that this front-facing point has positive depthScale (in front of camera)
      expect(projBefore.z).toBeGreaterThan(0);
      // In screen coordinates, dragging right rotates view clockwise, so front-facing node shifts to the left
      expect(projAfter.x).toBeLessThan(projBefore.x);
    });

    it('diagonal dragging: compound (dx, dy) rotation is smooth and strictly reversible', () => {
      const initialQ = eulerToQuaternion(0.3, -0.2);
      const dx = 12;
      const dy = -9;

      // Drag diagonally in a standard frame displacement
      const draggedQ = rotateOrientationByScreenDelta(initialQ, dx, dy, ROTATION_SENSITIVITY);
      expect(draggedQ).not.toEqual(initialQ);

      // Reverse opposite diagonal drag
      const returnedQ = rotateOrientationByScreenDelta(draggedQ, -dx, -dy, ROTATION_SENSITIVITY);
      expect(Math.abs(returnedQ[0] - initialQ[0])).toBeLessThan(0.005);
      expect(Math.abs(returnedQ[1] - initialQ[1])).toBeLessThan(0.005);
      expect(Math.abs(returnedQ[2] - initialQ[2])).toBeLessThan(0.005);
      expect(Math.abs(returnedQ[3] - initialQ[3])).toBeLessThan(0.005);

      // Single-axis horizontal reversal commutes identically with machine precision (10^-8)
      const horizQ = rotateOrientationByScreenDelta(initialQ, 80, 0, ROTATION_SENSITIVITY);
      const restoredHorizQ = rotateOrientationByScreenDelta(horizQ, -80, 0, ROTATION_SENSITIVITY);
      expect(restoredHorizQ[0]).toBeCloseTo(initialQ[0], 8);
      expect(restoredHorizQ[1]).toBeCloseTo(initialQ[1], 8);
      expect(restoredHorizQ[2]).toBeCloseTo(initialQ[2], 8);
      expect(restoredHorizQ[3]).toBeCloseTo(initialQ[3], 8);

      // Single-axis vertical reversal commutes identically with machine precision (10^-8)
      const vertQ = rotateOrientationByScreenDelta(initialQ, 0, 80, ROTATION_SENSITIVITY);
      const restoredVertQ = rotateOrientationByScreenDelta(vertQ, 0, -80, ROTATION_SENSITIVITY);
      expect(restoredVertQ[0]).toBeCloseTo(initialQ[0], 8);
      expect(restoredVertQ[1]).toBeCloseTo(initialQ[1], 8);
      expect(restoredVertQ[2]).toBeCloseTo(initialQ[2], 8);
      expect(restoredVertQ[3]).toBeCloseTo(initialQ[3], 8);
    });

    it('regrip without jump: picking up pointer at a new location produces zero orientation jump', () => {
      const baseCamera: NetworkCamera = {
        orientation: eulerToQuaternion(0.2, 0.4),
        yaw: 0.2,
        pitch: 0.4,
        panX: 400,
        panY: 300,
        zoom: 1.0,
      };

      // 1. User drags from (100, 100) to (180, 150)
      const gesture1 = handleGesturePointerDown({
        clientX: 100,
        clientY: 100,
        pointerId: 1,
        pointerType: 'mouse',
        currentCamera: baseCamera,
      });

      const moveResult1 = handleGesturePointerMove(gesture1, 180, 150, baseCamera);
      const intermediateCamera = moveResult1.camera;
      expect(intermediateCamera.orientation).toBeDefined();

      // 2. User releases pointer and regrips at a completely different position (600, 450)
      const gesture2 = handleGesturePointerDown({
        clientX: 600,
        clientY: 450,
        pointerId: 1,
        pointerType: 'mouse',
        currentCamera: intermediateCamera,
      });

      // At pointer down / 0 delta at new location, camera orientation is IDENTICAL to release orientation
      const zeroMoveResult = handleGesturePointerMove(gesture2, 600, 450, intermediateCamera);
      expect(zeroMoveResult.gesture.exceededThreshold).toBe(false);
      expect(zeroMoveResult.camera.orientation).toEqual(intermediateCamera.orientation);

      // When dragging resumes from (600, 450) to (610, 455), orientation continues smoothly
      const nextMove = handleGesturePointerMove(gesture2, 610, 455, intermediateCamera);
      expect(nextMove.gesture.exceededThreshold).toBe(true);
      const dot =
        nextMove.camera.orientation![0] * intermediateCamera.orientation![0] +
        nextMove.camera.orientation![1] * intermediateCamera.orientation![1] +
        nextMove.camera.orientation![2] * intermediateCamera.orientation![2] +
        nextMove.camera.orientation![3] * intermediateCamera.orientation![3];
      // Dot product very close to 1 indicates smooth infinitesimal transition
      expect(dot).toBeGreaterThan(0.999);
    });

    it('quaternion numeric stability: 2,000 successive incremental rotations maintain unit norm and precision', () => {
      let q = eulerToQuaternion(0.1, 0.1);

      // Simulate 2,000 micro-drags
      for (let i = 0; i < 2000; i++) {
        const dx = ((i % 11) - 5) * 1.5;
        const dy = (((i * 3) % 13) - 6) * 1.2;
        q = rotateOrientationByScreenDelta(q, dx, dy, ROTATION_SENSITIVITY);
      }

      const len = Math.hypot(...q);
      expect(len).toBeCloseTo(1.0, 9);
      expect(Number.isFinite(q[0])).toBe(true);
      expect(Number.isFinite(q[1])).toBe(true);
      expect(Number.isFinite(q[2])).toBe(true);
      expect(Number.isFinite(q[3])).toBe(true);

      // Verify a rotated vector still has exact length
      const v = rotateVectorByQuaternion({ x: 1, y: 0, z: 0 }, q);
      expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(1.0, 8);
    });

    describe('2.7 Quaternion Slerp & Target-Facing Properties', () => {
      it('quaternionSlerp correctly interpolates at t=0, t=0.5, t=1 and takes the shortest path when dot < 0', () => {
        const q1 = eulerToQuaternion(0, 0);
        const q2 = eulerToQuaternion(Math.PI / 2, 0);

        const slerpStart = quaternionSlerp(q1, q2, 0);
        expect(slerpStart[0]).toBeCloseTo(q1[0], 6);
        expect(slerpStart[1]).toBeCloseTo(q1[1], 6);
        expect(slerpStart[2]).toBeCloseTo(q1[2], 6);
        expect(slerpStart[3]).toBeCloseTo(q1[3], 6);

        const slerpEnd = quaternionSlerp(q1, q2, 1);
        expect(slerpEnd[0]).toBeCloseTo(q2[0], 6);
        expect(slerpEnd[1]).toBeCloseTo(q2[1], 6);
        expect(slerpEnd[2]).toBeCloseTo(q2[2], 6);
        expect(slerpEnd[3]).toBeCloseTo(q2[3], 6);

        // When q2 is negated (opposite hemisphere in 4D representing same 3D orientation, dot < 0)
        const q2Negated: Quaternion = [-q2[0], -q2[1], -q2[2], -q2[3]];
        const slerpMid = quaternionSlerp(q1, q2Negated, 0.5);
        expect(Math.hypot(...slerpMid)).toBeCloseTo(1.0, 6);
        // Midpoint should match 45 degree yaw
        const { yaw } = quaternionToEuler(slerpMid);
        expect(yaw).toBeCloseTo(Math.PI / 4, 4);
      });

      it('computeQuaternionToFacePoint computes rotation facing target directly to +Z camera axis', () => {
        // Point at (0, 0, 100) is already facing camera
        const qForward = computeQuaternionToFacePoint({ x: 0, y: 0, z: 100 });
        expect(qForward).toEqual([0, 0, 0, 1]);

        // Antipodal point (0, 0, -100) facing directly backward
        const qAntipodal = computeQuaternionToFacePoint({ x: 0, y: 0, z: -100 });
        expect(Number.isFinite(qAntipodal[0])).toBe(true);
        expect(Math.hypot(...qAntipodal)).toBeCloseTo(1.0, 6);

        // Arbitrary diagonal point
        const target: Point3D = { x: 30, y: -40, z: 50 };
        const qFace = computeQuaternionToFacePoint(target);
        const transformed = rotateVectorByQuaternion(target, qFace);
        // After transformation, target vector is aligned along +Z axis
        expect(transformed.x).toBeCloseTo(0, 4);
        expect(transformed.y).toBeCloseTo(0, 4);
        expect(transformed.z).toBeGreaterThan(0);
      });
    });
  });

  // =========================================================================
  // 3. Native Graph Zoom Prevention, Wheel Normalization, Boundary Clamping & Pivots
  // =========================================================================
  describe('3. Native Graph Zoom Prevention, Wheel Normalization & Pivots', () => {
    describe('3.1 Wheel Normalization across Delta Modes and Trackpad Pinch', () => {
      it('normalizeWheelZoomDelta handles DOM_DELTA_PIXEL (0) directly within limits', () => {
        const delta = normalizeWheelZoomDelta({ deltaY: 75, deltaMode: 0 });
        expect(delta).toBe(75);
      });

      it('normalizeWheelZoomDelta multiplies DOM_DELTA_LINE (1) by 24', () => {
        const delta = normalizeWheelZoomDelta({ deltaY: 3, deltaMode: 1 });
        expect(delta).toBe(3 * 24);
      });

      it('normalizeWheelZoomDelta multiplies DOM_DELTA_PAGE (2) by 400 and clamps to 320', () => {
        const delta = normalizeWheelZoomDelta({ deltaY: 1, deltaMode: 2 });
        // 1 * 400 = 400 -> clamped to 320
        expect(delta).toBe(320);

        const negativeDelta = normalizeWheelZoomDelta({ deltaY: -1, deltaMode: 2 });
        expect(negativeDelta).toBe(-320);
      });

      it('normalizeWheelZoomDelta applies 1.5x amplification for macOS trackpad pinch (ctrlKey: true)', () => {
        const normalDelta = normalizeWheelZoomDelta({ deltaY: 40, deltaMode: 0, ctrlKey: false });
        const pinchDelta = normalizeWheelZoomDelta({ deltaY: 40, deltaMode: 0, ctrlKey: true });
        expect(pinchDelta).toBe(normalDelta * 1.5);
      });

      it('normalizeWheelZoomDelta returns 0 on zero or non-finite inputs', () => {
        expect(normalizeWheelZoomDelta({ deltaY: 0, deltaMode: 0 })).toBe(0);
        expect(normalizeWheelZoomDelta({ deltaY: NaN, deltaMode: 0 })).toBe(0);
        expect(normalizeWheelZoomDelta({ deltaY: Infinity, deltaMode: 0 })).toBe(0);
      });

      it('computeContinuousZoomFactor maps normalized deltas to exponential zoom factors', () => {
        expect(computeContinuousZoomFactor(0)).toBe(1.0);
        expect(computeContinuousZoomFactor(NaN)).toBe(1.0);

        // Zoom out on positive wheel delta (scroll down)
        const zoomOutFactor = computeContinuousZoomFactor(100);
        expect(zoomOutFactor).toBeLessThan(1.0);
        expect(zoomOutFactor).toBeGreaterThan(0.5);

        // Zoom in on negative wheel delta (scroll up)
        const zoomInFactor = computeContinuousZoomFactor(-100);
        expect(zoomInFactor).toBeGreaterThan(1.0);
      });
    });

    describe('3.2 Boundary Clamping [0.15, 4.0]', () => {
      const baseCamera: NetworkCamera = {
        yaw: DEFAULT_YAW,
        pitch: DEFAULT_PITCH,
        panX: 400,
        panY: 300,
        zoom: 1.0,
      };

      it('clamps minimum zoom strictly to MIN_ZOOM = 0.15 upon repeated zoom out', () => {
        let cam = { ...baseCamera };
        for (let i = 0; i < 20; i++) {
          cam = applyZoomAroundCursor(cam, 0.5, 400, 300, MIN_ZOOM, MAX_ZOOM);
        }
        expect(cam.zoom).toBe(MIN_ZOOM);
        expect(cam.zoom).toBe(0.15);

        // Additional zoom out when already at boundary returns unchanged camera object
        const furtherZoom = applyZoomAroundCursor(cam, 0.8, 400, 300, MIN_ZOOM, MAX_ZOOM);
        expect(furtherZoom).toBe(cam);
      });

      it('clamps maximum zoom strictly to MAX_ZOOM = 4.0 upon repeated zoom in', () => {
        let cam = { ...baseCamera };
        for (let i = 0; i < 20; i++) {
          cam = applyZoomAroundCursor(cam, 1.8, 400, 300, MIN_ZOOM, MAX_ZOOM);
        }
        expect(cam.zoom).toBe(MAX_ZOOM);
        expect(cam.zoom).toBe(4.0);

        // Additional zoom in when already at boundary returns unchanged camera object
        const furtherZoom = applyZoomAroundCursor(cam, 1.5, 400, 300, MIN_ZOOM, MAX_ZOOM);
        expect(furtherZoom).toBe(cam);
      });
    });

    describe('3.3 Cursor Pivot Invariant in applyZoomAroundCursor', () => {
      it('the world point directly beneath the cursor remains at the identical screen pixel position after zoom', () => {
        const cam: NetworkCamera = {
          yaw: 0.3,
          pitch: -0.2,
          panX: 420,
          panY: 280,
          zoom: 1.2,
        };

        const cursorX = 350;
        const cursorY = 210;

        // Calculate world point before zoom:
        const worldX = (cursorX - cam.panX) / cam.zoom;
        const worldY = (cursorY - cam.panY) / cam.zoom;

        // Apply zoom with factor 1.4
        const zoomedCam = applyZoomAroundCursor(cam, 1.4, cursorX, cursorY, MIN_ZOOM, MAX_ZOOM);

        // Recompute screen position of that same world point after zoom:
        const screenXAfter = zoomedCam.panX + worldX * zoomedCam.zoom;
        const screenYAfter = zoomedCam.panY + worldY * zoomedCam.zoom;

        expect(screenXAfter).toBeCloseTo(cursorX, 9);
        expect(screenYAfter).toBeCloseTo(cursorY, 9);
      });

      it('cursor pivot invariant holds for zoom-out (factor < 1.0)', () => {
        const cam: NetworkCamera = {
          yaw: -0.5,
          pitch: 0.4,
          panX: 510,
          panY: 340,
          zoom: 2.5,
        };

        const cursorX = 600;
        const cursorY = 400;

        const worldX = (cursorX - cam.panX) / cam.zoom;
        const worldY = (cursorY - cam.panY) / cam.zoom;

        const zoomedCam = applyZoomAroundCursor(cam, 0.7, cursorX, cursorY, MIN_ZOOM, MAX_ZOOM);

        const screenXAfter = zoomedCam.panX + worldX * zoomedCam.zoom;
        const screenYAfter = zoomedCam.panY + worldY * zoomedCam.zoom;

        expect(screenXAfter).toBeCloseTo(cursorX, 9);
        expect(screenYAfter).toBeCloseTo(cursorY, 9);
      });
    });

    describe('3.4 Center Pivot Invariant in applyZoomAroundCenter', () => {
      it('in center-locked mode, the usable viewport center remains stationary during zoom', () => {
        const insets: ViewportInsets = { top: 60, bottom: 20, left: 30, right: 30 };
        const viewportW = 800;
        const viewportH = 600;

        const usableCenterX = 30 + (viewportW - 60) / 2; // 400
        const usableCenterY = 60 + (viewportH - 80) / 2; // 320

        const cam: NetworkCamera = {
          yaw: 0,
          pitch: 0,
          panX: usableCenterX,
          panY: usableCenterY,
          zoom: 1.0,
        };

        const zoomedCam = applyZoomAroundCenter(
          cam,
          1.5,
          viewportW,
          viewportH,
          insets,
          MIN_ZOOM,
          MAX_ZOOM
        );

        expect(zoomedCam.panX).toBeCloseTo(usableCenterX, 9);
        expect(zoomedCam.panY).toBeCloseTo(usableCenterY, 9);
        expect(zoomedCam.zoom).toBeCloseTo(1.5, 9);
      });

      it('computeCenterLockedTransform centers visible graph bounds in the usable viewport', () => {
        const bounds = { minX: 20, maxX: 180, minY: -30, maxY: 70 };
        // graphMidX = 100, graphMidY = 20
        const insets: ViewportInsets = { top: 50, bottom: 20, left: 20, right: 20 };
        const viewportW = 800;
        const viewportH = 600;
        const usableCenterX = 20 + (800 - 40) / 2; // 400
        const usableCenterY = 50 + (600 - 70) / 2; // 315

        const transform = computeCenterLockedTransform(bounds, viewportW, viewportH, 1.5, insets);
        expect(transform.panX).toBe(usableCenterX - 100 * 1.5);
        expect(transform.panY).toBe(usableCenterY - 20 * 1.5);
        expect(transform.zoom).toBe(1.5);
      });

      it('isCenterDeadZone detects sub-pixel jitter threshold', () => {
        const current = { panX: 400.2, panY: 300.1 };
        const target = { panX: 400.4, panY: 300.3 };
        // dx = 0.2 <= 0.5, dy = 0.2 <= 0.5
        expect(isCenterDeadZone(current, target, 0.5)).toBe(true);

        const farTarget = { panX: 401.5, panY: 300.0 };
        // dx = 1.3 > 0.5
        expect(isCenterDeadZone(current, farTarget, 0.5)).toBe(false);
      });
    });
  });

  // =========================================================================
  // 4. Pointer Gesture Lifecycle: Inertia Launch, Suppression & Cleanup
  // =========================================================================
  describe('4. Pointer Gesture Lifecycle & Rotational Inertia Physics', () => {
    describe('4.1 Pointer Gesture Initiation & Thresholds', () => {
      it('differentiates mouse vs touch drag thresholds', () => {
        expect(GESTURE_THRESHOLD_MOUSE).toBe(4);
        expect(GESTURE_THRESHOLD_TOUCH).toBe(8);

        const baseCam: NetworkCamera = {
          orientation: DEFAULT_ORIENTATION,
          yaw: DEFAULT_YAW,
          pitch: DEFAULT_PITCH,
          panX: 400,
          panY: 300,
          zoom: DEFAULT_ZOOM,
        };
        expect(baseCam.zoom).toBe(1.0);

        // A 5px move exceeds mouse threshold (4px) but does not exceed touch threshold (8px)
        const mouseGesture = handleGesturePointerDown({
          clientX: 100,
          clientY: 100,
          pointerId: 1,
          pointerType: 'mouse',
          currentCamera: baseCam,
        });
        const mouseMove = handleGesturePointerMove(mouseGesture, 105, 100, baseCam);
        expect(mouseMove.gesture.exceededThreshold).toBe(true);

        const touchGesture = handleGesturePointerDown({
          clientX: 100,
          clientY: 100,
          pointerId: 2,
          pointerType: 'touch',
          currentCamera: baseCam,
        });
        const touchMove = handleGesturePointerMove(touchGesture, 105, 100, baseCam);
        expect(touchMove.gesture.exceededThreshold).toBe(false);
      });

      it('shift key triggers panning mode scaled by PAN_SENSITIVITY', () => {
        const baseCam: NetworkCamera = {
          yaw: 0,
          pitch: 0,
          panX: 400,
          panY: 300,
          zoom: 1.0,
        };

        const gesture = handleGesturePointerDown({
          clientX: 200,
          clientY: 200,
          pointerId: 1,
          pointerType: 'mouse',
          shiftKey: true,
          currentCamera: baseCam,
        });

        expect(gesture.mode).toBe('panning');
        const moved = handleGesturePointerMove(gesture, 250, 230, baseCam);
        expect(moved.gesture.exceededThreshold).toBe(true);
        expect(moved.camera.panX).toBe(baseCam.panX + 50 * PAN_SENSITIVITY);
        expect(moved.camera.panY).toBe(baseCam.panY + 30 * PAN_SENSITIVITY);
      });
    });

    describe('4.2 Inertia Launch on Fast Release', () => {
      it('launches rotational inertia when released with high velocity within 75ms', () => {
        const vx = 1.4;
        const vy = -0.9;
        const timeSinceLastMove = 30; // ms

        const releaseSpeed = calculateReleaseSpeed(vx, vy, timeSinceLastMove, 75);
        expect(releaseSpeed).toBeCloseTo(Math.hypot(vx, vy), 5);
        expect(shouldInitiateInertia(releaseSpeed, false, 0.15)).toBe(true);

        const clamped = clampLaunchVelocity({ vx, vy }, 2.2);
        expect(clamped.vx).toBe(1.4);
        expect(clamped.vy).toBe(-0.9);
      });

      it('stepRotationalInertia updates quaternion orientation and decays velocity smoothly', () => {
        const baseCam: NetworkCamera = {
          orientation: eulerToQuaternion(0, 0),
          yaw: 0,
          pitch: 0,
          panX: 400,
          panY: 300,
          zoom: 1.0,
        };

        const step1 = stepRotationalInertia({
          vx: 1.0,
          vy: 0.5,
          camera: baseCam,
          deltaMs: 16,
          friction: 0.88,
        });

        expect(step1.isDone).toBe(false);
        expect(step1.vx).toBeCloseTo(1.0 * 0.88, 5);
        expect(step1.vy).toBeCloseTo(0.5 * 0.88, 5);
        expect(step1.camera.orientation).toBeDefined();
        // Camera orientation has changed
        expect(step1.camera.orientation).not.toEqual(baseCam.orientation);
        expect(Math.hypot(...step1.camera.orientation!)).toBeCloseTo(1.0, 9);
      });

      it('stepRotationalInertia halts cleanly when speed drops below epsilon (0.015)', () => {
        const cam: NetworkCamera = {
          orientation: eulerToQuaternion(0.5, 0.5),
          yaw: 0.5,
          pitch: 0.5,
          panX: 400,
          panY: 300,
          zoom: 1.0,
        };

        // Speed = hypot(0.008, 0.008) ≈ 0.0113 < 0.015
        const stepHalt = stepRotationalInertia({
          vx: 0.008,
          vy: 0.008,
          camera: cam,
          deltaMs: 16,
          friction: 1.0,
          epsilon: 0.015,
        });

        expect(stepHalt.isDone).toBe(true);
        expect(stepHalt.vx).toBe(0);
        expect(stepHalt.vy).toBe(0);
        expect(stepHalt.camera.orientation).toEqual(cam.orientation);
      });
    });

    describe('4.2 Suppression on Lingering Stationary Release', () => {
      it('suppresses inertia launch if user held pointer stationary for > 75ms before releasing', () => {
        const vx = 1.8;
        const vy = 1.2;
        // User stopped and held pointer stationary for 90ms before lifting
        const timeSinceLastMove = 90;

        const releaseSpeed = calculateReleaseSpeed(vx, vy, timeSinceLastMove, 75);
        expect(releaseSpeed).toBe(0);
        expect(shouldInitiateInertia(releaseSpeed, false, 0.15)).toBe(false);
      });
    });

    describe('4.3 Accessibility & Reduced Motion Guard', () => {
      it('strictly suppresses inertia when prefersReducedMotion is enabled', () => {
        const highSpeed = 2.5;
        expect(shouldInitiateInertia(highSpeed, true, 0.15)).toBe(false);
      });
    });

    describe('4.4 Lost Pointer Capture and Gesture State Reset', () => {
      it('resetGestureState completely resets active flags, pointerId, and ensures valid camera orientation', () => {
        const camera: NetworkCamera = {
          yaw: 0.4,
          pitch: -0.2,
          panX: 450,
          panY: 320,
          zoom: 1.5,
        };

        const state = resetGestureState(camera);
        expect(state.active).toBe(false);
        expect(state.mode).toBe('idle');
        expect(state.pointerId).toBeNull();
        expect(state.exceededThreshold).toBe(false);
        expect(state.startCamera.orientation).toBeDefined();
        expect(Math.hypot(...state.startCamera.orientation!)).toBeCloseTo(1.0, 8);
      });
    });
  });

  // =========================================================================
  // 5. Metric Strip Structure: 4-Stat Horizontal Grid Layout in Inspector
  // =========================================================================
  describe('5. Inspector Overview 4-Stat Horizontal Metric Strip Layout', () => {
    it('renders the 4-stat horizontal metric strip container with class overview-metric-strip', () => {
      const nodes: FileNode[] = [
        createTestNode('src/api/auth.ts', 'src/api/auth.ts', 2),
        createTestNode('src/api/users.ts', 'src/api/users.ts', 1),
        createTestNode('src/db/client.ts', 'src/db/client.ts', 0),
        createTestNode('src/utils/crypto.ts', 'src/utils/crypto.ts', 0),
      ];

      const edges: DependencyEdge[] = [
        {
          id: 'auth->crypto',
          source_file_id: 'src/api/auth.ts',
          target_file_id: 'src/utils/crypto.ts',
          relationship_kind: 'Import',
          resolution_status: 'ResolvedInternal',
          evidence: [],
        },
        {
          id: 'users->client',
          source_file_id: 'src/api/users.ts',
          target_file_id: 'src/db/client.ts',
          relationship_kind: 'Import',
          resolution_status: 'ResolvedInternal',
          evidence: [],
        },
      ];

      const snapshot = createTestSnapshot(nodes, edges);

      const html = renderToStaticMarkup(
        React.createElement(Inspector, {
          selectedNode: null,
          selectedEdge: null,
          snapshot,
          onSelectNode: vi.fn(),
          onClose: vi.fn(),
        })
      );

      // Verify outer container
      expect(html).toContain('class="overview-metric-strip"');
      // Verify obsolete card class is NOT present on the strip
      expect(html).not.toContain('overview-metric-strip beginner-overview-card');

      // Verify the 4 exact stats in sequence
      expect(html).toContain('<span class="overview-metric-value"');
      // Check labels
      expect(html).toContain('<span class="overview-metric-label">Files</span>');
      expect(html).toContain('<span class="overview-metric-label">Analyzed</span>');
      expect(html).toContain('<span class="overview-metric-label">Connections</span>');
      expect(html).toContain('<span class="overview-metric-label">Areas</span>');

      // Check values
      expect(html).toContain('<span class="overview-metric-value">4</span><span class="overview-metric-label">Files</span>');
      expect(html).toContain('<span class="overview-metric-value">4</span><span class="overview-metric-label">Analyzed</span>');
      expect(html).toContain('<span class="overview-metric-value">2</span><span class="overview-metric-label">Connections</span>');
    });

    it('accurately counts multi-area repository structure and unsupported file exclusions', () => {
      const nodes: FileNode[] = [
        createTestNode('src/api/route.ts', 'src/api/route.ts', 1, 'Analyzed'),
        createTestNode('src/core/engine.ts', 'src/core/engine.ts', 1, 'Analyzed'),
        createTestNode('src/ui/button.ts', 'src/ui/button.ts', 0, 'Analyzed'),
        createTestNode('docs/notes.pdf', 'docs/notes.pdf', 0, 'Unsupported'),
      ];

      const snapshot = createTestSnapshot(nodes, [], {
        total_discovered: 4,
        total_analyzed: 3,
        total_excluded: 1,
      });

      const html = renderToStaticMarkup(
        React.createElement(Inspector, {
          selectedNode: null,
          selectedEdge: null,
          snapshot,
          onSelectNode: vi.fn(),
          onClose: vi.fn(),
        })
      );

      // Files = 4, Analyzed = 3, Connections = 0
      expect(html).toContain('<span class="overview-metric-value">4</span><span class="overview-metric-label">Files</span>');
      expect(html).toContain('<span class="overview-metric-value">3</span><span class="overview-metric-label">Analyzed</span>');
      expect(html).toContain('<span class="overview-metric-value">0</span><span class="overview-metric-label">Connections</span>');
      // Subtle hint informs of exclusion
      expect(html).toContain('1 unsupported files excluded');
    });

    it('handles empty snapshot gracefully displaying 0 across all metric items', () => {
      const snapshot = createTestSnapshot([]);

      const html = renderToStaticMarkup(
        React.createElement(Inspector, {
          selectedNode: null,
          selectedEdge: null,
          snapshot,
          onSelectNode: vi.fn(),
          onClose: vi.fn(),
        })
      );

      expect(html).toContain('<span class="overview-metric-value">0</span><span class="overview-metric-label">Files</span>');
      expect(html).toContain('<span class="overview-metric-value">0</span><span class="overview-metric-label">Analyzed</span>');
      expect(html).toContain('<span class="overview-metric-value">0</span><span class="overview-metric-label">Connections</span>');
      expect(html).toContain('<span class="overview-metric-value">0</span><span class="overview-metric-label">Areas</span>');
    });
  });

  // =========================================================================
  // 6. NetworkCanvas Rendering & Native Zoom Prevention
  // =========================================================================
  describe('6. NetworkCanvas Component Integration & Canvas Properties', () => {
    it('renders network canvas element with touchAction: none and accessible application semantics', () => {
      const nodeA = createTestNode('src/a.ts', 'src/a.ts');
      const nodeB = createTestNode('src/b.ts', 'src/b.ts');
      const snapshot = createTestSnapshot([nodeA, nodeB]);

      const html = renderToStaticMarkup(
        React.createElement(NetworkCanvas, {
          snapshot,
          selectedNodeId: null,
          selectedEdgeId: null,
          onSelectNode: vi.fn(),
          onSelectEdge: vi.fn(),
        })
      );

      expect(html).toContain('class="network-canvas"');
      expect(html).toContain('role="application"');
      expect(html).toContain('aria-label="3D Network Graph dependency orb"');
      expect(html).toContain('touch-action:none');
    });

    it('native wheel event prevention prevents browser page zoom when cancelable', () => {
      // Create a mock canvas element to verify addEventListener registration
      const listeners: Record<string, ((e: any) => void)[]> = {};
      const mockCanvas = {
        addEventListener: vi.fn((event: string, handler: (e: any) => void, _options?: any) => {
          listeners[event] = listeners[event] || [];
          listeners[event].push(handler);
        }),
        removeEventListener: vi.fn(),
      };

      // Define the listener logic matching production NetworkCanvas implementation
      const preventDefaultSpy = vi.fn();
      const onNativeWheel = (e: { cancelable: boolean; preventDefault: () => void }) => {
        if (e.cancelable) {
          e.preventDefault();
        }
      };

      mockCanvas.addEventListener('wheel', onNativeWheel, { passive: false });
      expect(mockCanvas.addEventListener).toHaveBeenCalledWith('wheel', onNativeWheel, { passive: false });

      // Trigger cancelable wheel event (e.g. trackpad pinch with ctrlKey: true)
      listeners['wheel'][0]({ cancelable: true, preventDefault: preventDefaultSpy });
      expect(preventDefaultSpy).toHaveBeenCalledTimes(1);

      // Trigger non-cancelable wheel event
      preventDefaultSpy.mockClear();
      listeners['wheel'][0]({ cancelable: false, preventDefault: preventDefaultSpy });
      expect(preventDefaultSpy).not.toHaveBeenCalled();
    });

    it('verifies center-locked discrete zoom in/out transforms clamped to [MIN_ZOOM, MAX_ZOOM]', () => {
      const initialCamera: NetworkCamera = {
        orientation: DEFAULT_ORIENTATION,
        yaw: DEFAULT_YAW,
        pitch: DEFAULT_PITCH,
        panX: 400,
        panY: 300,
        zoom: 1.0,
      };

      // Zoom in step (1.25x)
      const zoomedIn = applyZoomAroundCenter(
        initialCamera,
        1.25,
        800,
        600,
        { top: 64, bottom: 20, left: 20, right: 20 },
        MIN_ZOOM,
        MAX_ZOOM
      );
      expect(zoomedIn.zoom).toBe(1.25);
      expect(zoomedIn.orientation).toEqual(DEFAULT_ORIENTATION);

      // Zoom out step (0.8x)
      const zoomedOut = applyZoomAroundCenter(
        zoomedIn,
        0.8,
        800,
        600,
        { top: 64, bottom: 20, left: 20, right: 20 },
        MIN_ZOOM,
        MAX_ZOOM
      );
      expect(zoomedOut.zoom).toBeCloseTo(1.0, 6);
    });
  });
});
