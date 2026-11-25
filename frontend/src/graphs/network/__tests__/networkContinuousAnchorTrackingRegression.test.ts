import { describe, it, expect } from 'vitest';
import {
  AreaMotionState,
  adaptLabelOffsetToGeometry,
  computeRenderedLabelRect,
} from '../layout/labelMotion';
import {
  computeOffsetForAngle,
  DEFAULT_BELOW_THETA,
} from '../layout/labelPlacement';

describe('Continuous Anchor-Tracking Labels & Geometry-Budgeted Stability Regression Suite', () => {
  const boxWidth = 120;
  const boxHeight = 32;
  const radius = 18;

  it('13.1 One-Pixel Pan Invariant: 1px pure pan produces exact 1px label movement with zero drift', () => {
    const motionMap = new Map<string, AreaMotionState>();
    const off0 = computeOffsetForAngle(DEFAULT_BELOW_THETA, radius, 4, boxWidth, boxHeight);
    adaptLabelOffsetToGeometry(motionMap, 'area-core', DEFAULT_BELOW_THETA, off0, radius, boxWidth, boxHeight, 0);

    const rect0 = computeRenderedLabelRect(400, 300, motionMap.get('area-core')!.currentOffset, boxWidth, boxHeight);

    // Pure interior pan: relevantGeometryDisplacement = 0
    adaptLabelOffsetToGeometry(motionMap, 'area-core', DEFAULT_BELOW_THETA, off0, radius, boxWidth, boxHeight, 0);
    const rect1 = computeRenderedLabelRect(401, 300, motionMap.get('area-core')!.currentOffset, boxWidth, boxHeight);

    expect(rect1.x1 - rect0.x1).toBe(1);
    expect(rect1.y1 - rect0.y1).toBe(0);
  });

  it('13.2 Five-Pixel Drag Test: continuous incremental drag tracks 1:1 with zero lag', () => {
    const motionMap = new Map<string, AreaMotionState>();
    const off0 = computeOffsetForAngle(DEFAULT_BELOW_THETA, radius, 4, boxWidth, boxHeight);
    adaptLabelOffsetToGeometry(motionMap, 'area-core', DEFAULT_BELOW_THETA, off0, radius, boxWidth, boxHeight, 0);

    let anchorX = 400;
    let anchorY = 300;
    let prevRect = computeRenderedLabelRect(anchorX, anchorY, motionMap.get('area-core')!.currentOffset, boxWidth, boxHeight);

    const deltas = [
      { dx: 1, dy: 0 },
      { dx: 1, dy: 1 },
      { dx: 1, dy: -1 },
      { dx: 1, dy: 0 },
      { dx: 1, dy: 0 },
    ];

    for (const d of deltas) {
      anchorX += d.dx;
      anchorY += d.dy;
      adaptLabelOffsetToGeometry(motionMap, 'area-core', DEFAULT_BELOW_THETA, off0, radius, boxWidth, boxHeight, 0);
      const currRect = computeRenderedLabelRect(anchorX, anchorY, motionMap.get('area-core')!.currentOffset, boxWidth, boxHeight);
      expect(currRect.x1 - prevRect.x1).toBe(d.dx);
      expect(currRect.y1 - prevRect.y1).toBe(d.dy);
      prevRect = currRect;
    }
  });

  it('13.3 Direction Reversal: reversing target mid-slide reverses smoothly from currentTheta without snapping', () => {
    const motionMap = new Map<string, AreaMotionState>();
    const offBelow = computeOffsetForAngle(DEFAULT_BELOW_THETA, radius, 4, boxWidth, boxHeight);
    adaptLabelOffsetToGeometry(motionMap, 'area-rev', DEFAULT_BELOW_THETA, offBelow, radius, boxWidth, boxHeight, 0);

    const offRight = computeOffsetForAngle(0, radius, 4, boxWidth, boxHeight);
    const s1 = adaptLabelOffsetToGeometry(motionMap, 'area-rev', 0, offRight, radius, boxWidth, boxHeight, 10);
    const midTheta = s1.currentTheta;
    expect(midTheta).toBeLessThan(DEFAULT_BELOW_THETA);
    expect(midTheta).toBeGreaterThan(0);

    // Reverse direction back toward below with 5px geometry step
    const s2 = adaptLabelOffsetToGeometry(motionMap, 'area-rev', DEFAULT_BELOW_THETA, offBelow, radius, boxWidth, boxHeight, 5);
    expect(s2.currentTheta).toBeGreaterThan(midTheta);
    expect(s2.currentTheta).toBeLessThanOrEqual(DEFAULT_BELOW_THETA);
  });
});
