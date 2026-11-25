/**
 * PreBase — Geometry-Budgeted Continuous Area Label Motion
 *
 * Label position is purely a continuous consequence of current graph geometry:
 *   labelTopLeft = projectedAnchor + currentOffset
 *
 * Relative offset adapts along the anchor's directional support perimeter strictly
 * in proportion to relevant local geometry displacement:
 *   allowedStep = adaptationGain * relevantGeometryDisplacement
 *
 * Guarantees:
 * 1. ZERO autonomous movement when geometry is stationary (0px drift across any time delta).
 * 2. Pure-pan invariance in canvas interior (1px pan = 1px label movement).
 * 3. Sliding along the anchor support perimeter (never cuts through the anchor badge).
 * 4. Speed-independent, direction-reversal safe, zero timers or springs.
 */

import { ScreenRect } from '../render/networkRenderMath';
import {
  computeOffsetForAngle,
  computeSupportDistance,
  DEFAULT_LABEL_GAP,
} from './labelPlacement';

export interface Point2D {
  x: number;
  y: number;
}

export interface AreaMotionState {
  areaId: string;
  currentTheta: number;
  targetTheta: number;
  currentOffset: Point2D;
  targetOffset: Point2D;
}

export const DEFAULT_ADAPTATION_GAIN = 0.85;

/**
 * Computes the anchor-relative top-left offset for a bounding rectangle.
 */
export function computeAnchorRelativeOffset(
  anchorScreenX: number,
  anchorScreenY: number,
  rect: ScreenRect
): Point2D {
  return {
    x: rect.x1 - anchorScreenX,
    y: rect.y1 - anchorScreenY,
  };
}

/**
 * Computes the actual screen rectangle for an area label from the anchor screen coordinates,
 * relative offset, and label dimensions.
 */
export function computeRenderedLabelRect(
  anchorScreenX: number,
  anchorScreenY: number,
  offset: Point2D,
  boxWidth: number,
  boxHeight: number
): ScreenRect {
  const x1 = anchorScreenX + offset.x;
  const y1 = anchorScreenY + offset.y;
  return {
    x1,
    y1,
    x2: x1 + boxWidth,
    y2: y1 + boxHeight,
  };
}

/**
 * Updates an area label's anchor-relative offset strictly within the movement-proportional
 * geometry budget (`adaptationGain * relevantGeometryDisplacement`).
 *
 * - On initial appearance or re-entry from hidden state, initializes directly at `targetOffset`.
 * - When `relevantGeometryDisplacement === 0`, returns immediately with zero offset change.
 * - When geometry changes, slides `currentTheta` smoothly around the anchor support perimeter
 *   toward `targetTheta` without ever cutting across the anchor badge.
 */
export function adaptLabelOffsetToGeometry(
  motionMap: Map<string, AreaMotionState>,
  areaId: string,
  targetTheta: number,
  targetOffset: Point2D,
  anchorRadius: number,
  boxWidth: number,
  boxHeight: number,
  relevantGeometryDisplacement: number,
  _isReentry = false,
  prefersReducedMotion = false,
  gap = DEFAULT_LABEL_GAP,
  adaptationGain = DEFAULT_ADAPTATION_GAIN
): AreaMotionState {
  let state = motionMap.get(areaId);

  if (!state) {
    state = {
      areaId,
      currentTheta: targetTheta,
      targetTheta,
      currentOffset: { ...targetOffset },
      targetOffset: { ...targetOffset },
    };
    motionMap.set(areaId, state);
    return state;
  }

  state.targetTheta = targetTheta;
  state.targetOffset = { ...targetOffset };

  const budget = Math.max(0, relevantGeometryDisplacement) * adaptationGain;
  if (budget === 0) {
    // Stationary or pure interior pan: zero autonomous relative offset movement
    return state;
  }

  if (prefersReducedMotion) {
    state.currentTheta = targetTheta;
    state.currentOffset = { ...targetOffset };
    return state;
  }

  const dTheta = Math.atan2(
    Math.sin(targetTheta - state.currentTheta),
    Math.cos(targetTheta - state.currentTheta)
  );
  const supportR = computeSupportDistance(
    anchorRadius,
    gap,
    boxWidth / 2,
    boxHeight / 2,
    Math.cos(state.currentTheta),
    Math.sin(state.currentTheta)
  );
  const maxAngleStep = budget / Math.max(1, supportR);
  const reachedTarget = Math.abs(dTheta) <= maxAngleStep;
  let stepTheta = reachedTarget ? dTheta : Math.sign(dTheta) * maxAngleStep;
  let nextTheta = reachedTarget
    ? targetTheta
    : Math.atan2(
        Math.sin(state.currentTheta + stepTheta),
        Math.cos(state.currentTheta + stepTheta)
      );
  let nextOffset = reachedTarget
    ? { ...targetOffset }
    : computeOffsetForAngle(nextTheta, anchorRadius, gap, boxWidth, boxHeight);

  // Guard wide-label perimeter corners where |d(offset)/dTheta| > supportR
  const actualStepDist = Math.hypot(
    nextOffset.x - state.currentOffset.x,
    nextOffset.y - state.currentOffset.y
  );
  if (actualStepDist > budget && actualStepDist > 1e-6) {
    stepTheta *= budget / actualStepDist;
    nextTheta = Math.atan2(
      Math.sin(state.currentTheta + stepTheta),
      Math.cos(state.currentTheta + stepTheta)
    );
    nextOffset = computeOffsetForAngle(nextTheta, anchorRadius, gap, boxWidth, boxHeight);
  }

  state.currentTheta = nextTheta;
  state.currentOffset = nextOffset;

  return state;
}
