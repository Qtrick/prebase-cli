import { describe, it, expect } from 'vitest';
import {
  AreaMotionState,
  computeAnchorRelativeOffset,
  computeRenderedLabelRect,
  adaptLabelOffsetToGeometry,
} from '../layout/labelMotion';
import {
  computeOffsetForAngle,
  DEFAULT_BELOW_THETA,
} from '../layout/labelPlacement';

describe('Geometry-Budgeted Continuous Label Motion (labelMotion.ts)', () => {
  const boxWidth = 120;
  const boxHeight = 32;
  const radius = 18;

  it('computes and reconstructs anchor-relative offset accurately', () => {
    const offset = computeAnchorRelativeOffset(200, 300, { x1: 180, y1: 320, x2: 300, y2: 352 });
    expect(offset).toEqual({ x: -20, y: 20 });
    expect(computeRenderedLabelRect(200, 300, offset, boxWidth, boxHeight)).toEqual({
      x1: 180,
      y1: 320,
      x2: 300,
      y2: 352,
    });
  });

  it('initializes new or re-entering labels directly at targetOffset with zero jump', () => {
    const motionMap = new Map<string, AreaMotionState>();
    const targetOffset = computeOffsetForAngle(0, radius, 4, boxWidth, boxHeight);

    const state = adaptLabelOffsetToGeometry(
      motionMap,
      'area-a',
      0,
      targetOffset,
      radius,
      boxWidth,
      boxHeight,
      0
    );
    expect(state.currentOffset).toEqual(targetOffset);
    expect(state.currentTheta).toBe(0);

    // Temporary suppression retains existing state on reentry (no immediate jump at 0 displacement)
    const reentryOffset = computeOffsetForAngle(-Math.PI / 2, radius, 4, boxWidth, boxHeight);
    const reentryState = adaptLabelOffsetToGeometry(
      motionMap,
      'area-a',
      -Math.PI / 2,
      reentryOffset,
      radius,
      boxWidth,
      boxHeight,
      0,
      true
    );
    expect(reentryState.currentOffset).toEqual(targetOffset);
  });

  it('guarantees ZERO autonomous movement when relevantGeometryDisplacement === 0', () => {
    const motionMap = new Map<string, AreaMotionState>();
    const initOffset = computeOffsetForAngle(DEFAULT_BELOW_THETA, radius, 4, boxWidth, boxHeight);
    adaptLabelOffsetToGeometry(motionMap, 'area-a', DEFAULT_BELOW_THETA, initOffset, radius, boxWidth, boxHeight, 0);

    // Target changes, but geometry displacement is 0 (pointer/graph stationary)
    const farOffset = computeOffsetForAngle(-Math.PI / 2, radius, 4, boxWidth, boxHeight);
    const state = adaptLabelOffsetToGeometry(
      motionMap,
      'area-a',
      -Math.PI / 2,
      farOffset,
      radius,
      boxWidth,
      boxHeight,
      0
    );

    expect(state.currentOffset).toEqual(initOffset);
    expect(state.currentTheta).toBe(DEFAULT_BELOW_THETA);
  });

  it('slides around the anchor support perimeter within the geometry budget (never through anchor)', () => {
    const motionMap = new Map<string, AreaMotionState>();
    const initOffset = computeOffsetForAngle(DEFAULT_BELOW_THETA, radius, 4, boxWidth, boxHeight);
    adaptLabelOffsetToGeometry(motionMap, 'area-a', DEFAULT_BELOW_THETA, initOffset, radius, boxWidth, boxHeight, 0);

    const targetTheta = -Math.PI / 2;
    const targetOffset = computeOffsetForAngle(targetTheta, radius, 4, boxWidth, boxHeight);

    // Step with 10px geometry displacement (budget = 15px)
    const state = adaptLabelOffsetToGeometry(
      motionMap,
      'area-a',
      targetTheta,
      targetOffset,
      radius,
      boxWidth,
      boxHeight,
      10
    );

    // Moved partially along perimeter, not teleported to target
    expect(state.currentTheta).not.toBe(DEFAULT_BELOW_THETA);
    expect(state.currentTheta).not.toBe(targetTheta);

    // Center of label remains outside anchor monogram clearance at every step
    const centerX = state.currentOffset.x + boxWidth / 2;
    const centerY = state.currentOffset.y + boxHeight / 2;
    expect(Math.hypot(centerX, centerY)).toBeGreaterThanOrEqual(radius + 4);
  });

  it('honors prefersReducedMotion when geometry moves', () => {
    const motionMap = new Map<string, AreaMotionState>();
    const initOffset = computeOffsetForAngle(DEFAULT_BELOW_THETA, radius, 4, boxWidth, boxHeight);
    adaptLabelOffsetToGeometry(motionMap, 'area-a', DEFAULT_BELOW_THETA, initOffset, radius, boxWidth, boxHeight, 0);

    const targetOffset = computeOffsetForAngle(-Math.PI / 2, radius, 4, boxWidth, boxHeight);
    const state = adaptLabelOffsetToGeometry(
      motionMap,
      'area-a',
      -Math.PI / 2,
      targetOffset,
      radius,
      boxWidth,
      boxHeight,
      2,
      false,
      true
    );

    expect(state.currentOffset).toEqual(targetOffset);
  });
});
