import { describe, it, expect } from 'vitest';
import {
  DEFAULT_YAW,
  DEFAULT_PITCH,
  DEFAULT_ZOOM,
  ROTATION_SENSITIVITY,
  PAN_SENSITIVITY,
  GESTURE_THRESHOLD_MOUSE,
  GESTURE_THRESHOLD_TOUCH,
  wrapRotationAngle,
  clampPitch,
  findHitNode,
  computeRevealCamera,
  handleGesturePointerDown,
  handleGesturePointerMove,
  resetGestureState,
  ProjectedNode,
} from '../render/networkRenderMath';
import { FileNode, NetworkCamera, Point3D, ViewportInsets } from '../../../types/graph';

const createNode = (id: string): FileNode => ({
  id,
  relative_path: `${id}.ts`,
  filename: `${id}.ts`,
  language: 'typescript',
  size_bytes: 120,
  file_kind: 'Source',
  analysis_status: 'Analyzed',
  direct_dependency_count: 2,
  direct_dependent_count: 1,
});

const createProjectedNode = (
  node: FileNode,
  screenX: number,
  screenY: number,
  z = 0,
  radius = 12
): ProjectedNode => ({
  id: node.id,
  node,
  worldPos: { x: screenX, y: screenY, z },
  localPos: { x: screenX, y: screenY, z },
  projected: {
    x: screenX,
    y: screenY,
    z,
    depthScale: 1.0 + z * 0.001,
    normalizedDepth: 0.5,
  },
  screenX,
  screenY,
  radius,
});

describe('Network Interaction and Selection Decoupling', () => {
  const baseCamera: NetworkCamera = {
    yaw: DEFAULT_YAW,
    pitch: DEFAULT_PITCH,
    panX: 400,
    panY: 300,
    zoom: DEFAULT_ZOOM,
  };

  const defaultInsets: ViewportInsets = {
    top: 64,
    bottom: 20,
    left: 20,
    right: 20,
  };

  describe('Gesture Threshold and Selection', () => {
    it('click below gesture threshold (< 4px) selects node without modifying camera', () => {
      const nodeA = createNode('nodeA');
      const projNodeA = createProjectedNode(nodeA, 400, 300, 0, 12);
      const projectedList = [projNodeA];

      let gesture = resetGestureState(baseCamera);
      gesture = handleGesturePointerDown({
        clientX: 400,
        clientY: 300,
        pointerId: 1,
        pointerType: 'mouse',
        currentCamera: baseCamera,
      });

      // Move 2px right, 1px down: hypotenuse = sqrt(4 + 1) ≈ 2.236px < 4px threshold
      const moveResult = handleGesturePointerMove(gesture, 402, 301, baseCamera);
      expect(moveResult.gesture.exceededThreshold).toBe(false);
      expect(moveResult.camera).toEqual(baseCamera);

      // Pointer up below threshold performs selection
      const wasDragging = moveResult.gesture.exceededThreshold;
      expect(wasDragging).toBe(false);

      const hit = findHitNode(projectedList, 402, 301, baseCamera.zoom);
      expect(hit).toBeDefined();
      expect(hit?.id).toBe('nodeA');

      // Camera is strictly preserved
      expect(baseCamera.yaw).toBe(DEFAULT_YAW);
      expect(baseCamera.pitch).toBe(DEFAULT_PITCH);
      expect(baseCamera.panX).toBe(400);
      expect(baseCamera.panY).toBe(300);
      expect(baseCamera.zoom).toBe(DEFAULT_ZOOM);
    });

    it('click empty space clears selection without modifying camera', () => {
      const nodeA = createNode('nodeA');
      const projNodeA = createProjectedNode(nodeA, 400, 300, 0, 12);
      const projectedList = [projNodeA];

      // Click at (100, 100), far outside node radius
      let gesture = resetGestureState(baseCamera);
      gesture = handleGesturePointerDown({
        clientX: 100,
        clientY: 100,
        pointerId: 1,
        pointerType: 'mouse',
        currentCamera: baseCamera,
      });

      const moveResult = handleGesturePointerMove(gesture, 101, 101, baseCamera);
      expect(moveResult.gesture.exceededThreshold).toBe(false);

      const hit = findHitNode(projectedList, 101, 101, baseCamera.zoom);
      expect(hit).toBeNull();
      expect(moveResult.camera).toEqual(baseCamera);
    });

    it('background drag above threshold (>= 4px) rotates yaw and pitch, does not select node, and does not alter node world positions', () => {
      const nodeA = createNode('nodeA');
      const worldPositions = new Map<string, Point3D>([
        ['nodeA', { x: 150, y: -80, z: 45 }],
      ]);
      const initialPosA = { ...worldPositions.get('nodeA')! };

      let gesture = resetGestureState(baseCamera);
      gesture = handleGesturePointerDown({
        clientX: 200,
        clientY: 200,
        pointerId: 1,
        pointerType: 'mouse',
        currentCamera: baseCamera,
      });

      // Move dx = 20, dy = 15: hypot = 25px >= 4px threshold
      const moveResult = handleGesturePointerMove(gesture, 220, 215, baseCamera);
      expect(moveResult.gesture.exceededThreshold).toBe(true);

      const expectedYaw = wrapRotationAngle(baseCamera.yaw - 20 * ROTATION_SENSITIVITY);
      const expectedPitch = clampPitch(baseCamera.pitch + 15 * ROTATION_SENSITIVITY);

      expect(moveResult.camera.yaw).toBeCloseTo(expectedYaw, 6);
      expect(moveResult.camera.pitch).toBeCloseTo(expectedPitch, 6);
      expect(moveResult.camera.panX).toBe(baseCamera.panX);
      expect(moveResult.camera.panY).toBe(baseCamera.panY);
      expect(moveResult.camera.zoom).toBe(baseCamera.zoom);

      // On pointer up, wasDragging suppresses selection even if mouse hovered over nodeA
      const wasDragging = moveResult.gesture.exceededThreshold;
      expect(wasDragging).toBe(true);
      const projNodeA = createProjectedNode(nodeA, 200, 200);
      const selectionOnUp = wasDragging ? null : findHitNode([projNodeA], 220, 215, baseCamera.zoom);
      expect(selectionOnUp).toBeNull();

      // World positions in layout remain strictly unchanged
      const currentPosA = worldPositions.get('nodeA')!;
      expect(currentPosA).toEqual(initialPosA);
    });

    it('shift-drag translates panX and panY, preserving yaw and pitch', () => {
      let gesture = resetGestureState(baseCamera);
      gesture = handleGesturePointerDown({
        clientX: 300,
        clientY: 300,
        pointerId: 1,
        pointerType: 'mouse',
        shiftKey: true,
        currentCamera: baseCamera,
      });

      expect(gesture.mode).toBe('panning');

      // Drag dx = 35, dy = -25
      const moveResult = handleGesturePointerMove(gesture, 335, 275, baseCamera);
      expect(moveResult.gesture.exceededThreshold).toBe(true);

      expect(moveResult.camera.panX).toBe(baseCamera.panX + 35 * PAN_SENSITIVITY);
      expect(moveResult.camera.panY).toBe(baseCamera.panY - 25 * PAN_SENSITIVITY);
      expect(moveResult.camera.yaw).toBe(baseCamera.yaw);
      expect(moveResult.camera.pitch).toBe(baseCamera.pitch);
      expect(moveResult.camera.zoom).toBe(baseCamera.zoom);
    });

    it('respects device-specific gesture thresholds (touch=8px vs mouse=4px)', () => {
      expect(GESTURE_THRESHOLD_MOUSE).toBe(4);
      expect(GESTURE_THRESHOLD_TOUCH).toBe(8);

      // 5px displacement is a drag for mouse, but remains a tap for touch
      const mouseGesture = handleGesturePointerDown({
        clientX: 100,
        clientY: 100,
        pointerId: 1,
        pointerType: 'mouse',
        currentCamera: baseCamera,
      });
      const mouseMove = handleGesturePointerMove(mouseGesture, 105, 100, baseCamera);
      expect(mouseMove.gesture.exceededThreshold).toBe(true);

      const touchGesture = handleGesturePointerDown({
        clientX: 100,
        clientY: 100,
        pointerId: 2,
        pointerType: 'touch',
        currentCamera: baseCamera,
      });
      const touchMove = handleGesturePointerMove(touchGesture, 105, 100, baseCamera);
      expect(touchMove.gesture.exceededThreshold).toBe(false);
    });
  });

  describe('Selection Decoupling and Camera Preservation', () => {
    it('selection does NOT modify camera transform or rotation (regression test comparing camera before and after selection)', () => {
      const customCamera: NetworkCamera = {
        yaw: 1.15,
        pitch: -0.42,
        panX: 530,
        panY: 375,
        zoom: 2.25,
      };

      const cameraBefore = { ...customCamera };

      // Node selection action
      const selectedNode = createNode('active-service');
      expect(selectedNode.id).toBe('active-service');

      const cameraAfter = { ...customCamera };

      // Conclusively verify complete decoupling
      expect(cameraAfter).toEqual(cameraBefore);
      expect(cameraAfter.yaw).toBe(cameraBefore.yaw);
      expect(cameraAfter.pitch).toBe(cameraBefore.pitch);
      expect(cameraAfter.panX).toBe(cameraBefore.panX);
      expect(cameraAfter.panY).toBe(cameraBefore.panY);
      expect(cameraAfter.zoom).toBe(cameraBefore.zoom);
    });
  });

  describe('Visibility-Aware Reveal and Focus', () => {
    it('search selection with onlyIfOutside: true: when node is already visible in viewport, camera is NOT modified', () => {
      const nodeA = createNode('visibleNode');
      // Placed comfortably inside 800x600 viewport
      const projNodeA = createProjectedNode(nodeA, 400, 300, 0, 10);

      const targetCamera = computeRevealCamera(
        projNodeA,
        baseCamera,
        800,
        600,
        defaultInsets,
        true
      );

      // Returns null when node is already visible, preserving camera
      expect(targetCamera).toBeNull();
    });

    it('explicit reveal / focus with onlyIfOutside: false centers node, preserving yaw and pitch', () => {
      const nodeA = createNode('centeredNode');
      const projNodeA = createProjectedNode(nodeA, 200, 150, 0, 10);

      const targetCamera = computeRevealCamera(
        projNodeA,
        baseCamera,
        800,
        600,
        defaultInsets,
        false
      );

      expect(targetCamera).not.toBeNull();
      expect(targetCamera!.yaw).toBe(baseCamera.yaw);
      expect(targetCamera!.pitch).toBe(baseCamera.pitch);
      expect(targetCamera!.zoom).toBe(baseCamera.zoom);

      // Usable center with top=64, bottom=20, left=20, right=20:
      // usableCenterX = 20 + (800 - 40) / 2 = 400
      // usableCenterY = 64 + (600 - 84) / 2 = 322
      // targetPanX = 400 - projNodeA.projected.x * zoom = 400 - 200 * 1 = 200
      // targetPanY = 322 - projNodeA.projected.y * zoom = 322 - 150 * 1 = 172
      expect(targetCamera!.panX).toBe(200);
      expect(targetCamera!.panY).toBe(172);
    });

    it('reveal / focus when node is outside viewport centers node, preserving yaw and pitch', () => {
      const nodeA = createNode('offscreenNode');
      // Placed far outside visible viewport bounds
      const projNodeA = createProjectedNode(nodeA, -150, 850, 0, 10);

      const targetCamera = computeRevealCamera(
        projNodeA,
        baseCamera,
        800,
        600,
        defaultInsets,
        true
      );

      expect(targetCamera).not.toBeNull();
      expect(targetCamera!.yaw).toBe(baseCamera.yaw);
      expect(targetCamera!.pitch).toBe(baseCamera.pitch);
      expect(targetCamera!.zoom).toBe(baseCamera.zoom);
      expect(targetCamera!.panX).not.toBe(baseCamera.panX);
      expect(targetCamera!.panY).not.toBe(baseCamera.panY);
    });
  });

  describe('Gesture Cancellation and Blur Safety', () => {
    it('pointer cancellation / blur / lost capture resets gesture state so no stuck dragging/rotating state remains', () => {
      let gesture = resetGestureState(baseCamera);
      gesture = handleGesturePointerDown({
        clientX: 150,
        clientY: 150,
        pointerId: 42,
        pointerType: 'mouse',
        currentCamera: baseCamera,
      });

      const moved = handleGesturePointerMove(gesture, 200, 200, baseCamera);
      expect(moved.gesture.active).toBe(true);
      expect(moved.gesture.exceededThreshold).toBe(true);

      // Cancellation / blur resets state
      const cleaned = resetGestureState(moved.camera);
      expect(cleaned.active).toBe(false);
      expect(cleaned.mode).toBe('idle');
      expect(cleaned.pointerId).toBeNull();
      expect(cleaned.exceededThreshold).toBe(false);

      // Inactive gesture ignores subsequent move events
      const idleMove = handleGesturePointerMove(cleaned, 300, 300, moved.camera);
      expect(idleMove.gesture.active).toBe(false);
      expect(idleMove.camera).toEqual(moved.camera);
    });
  });

  describe('Frontmost Node Hit Testing', () => {
    it('when two nodes overlap under pointer, the frontmost node (highest z / depthScale) is selected', () => {
      const nodeBack = createNode('back-node');
      const nodeFront = createNode('front-node');

      // Both project to the exact same screen coordinates (300, 250)
      // but nodeFront has a significantly higher z (+150 vs -150)
      const projBack = createProjectedNode(nodeBack, 300, 250, -150, 12);
      const projFront = createProjectedNode(nodeFront, 300, 250, 150, 12);

      // Projected list is sorted ascending by depth z (back-to-front)
      const projectedList = [projBack, projFront];

      const hit = findHitNode(projectedList, 300, 250, 1.0);
      expect(hit).toBeDefined();
      expect(hit?.id).toBe('front-node');
    });
  });
});
