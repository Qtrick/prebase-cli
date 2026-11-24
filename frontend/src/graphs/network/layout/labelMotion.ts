/**
 * PreBase — Synchronized Architectural Label Motion Engine
 *
 * Implements smooth anchor-relative coordinate interpolation, synchronized batch timing,
 * retargeting and interruption safety, and reduced-motion compliance.
 *
 * Guarantees that:
 * 1. Labels never teleport or snap when changing candidate placements.
 * 2. All affected labels in a placement update transition simultaneously on a shared clock.
 * 3. Labels follow moving anchors in 3D perspective during continuous camera rotation.
 * 4. Demand-driven scheduling ensures zero idle CPU when labels are stationary.
 */

import { ScreenRect } from '../render/networkRenderMath';

export interface Point2D {
  x: number;
  y: number;
}

export interface AreaMotionState {
  areaId: string;
  currentOffset: Point2D;
  startOffset: Point2D;
  targetOffset: Point2D;
  candidateIndex: number;
}

export interface SynchronizedMotionTimeline {
  startTime: number;
  durationMs: number;
  activeAreaIds: Set<string>;
}

export const DEFAULT_MOTION_DURATION_MS = 220;

/**
 * Restrained cubic ease-out function: f(p) = 1 - (1 - p)^3
 * Provides immediate responsive departure with gentle, controlled arrival.
 */
export function cubicEaseOut(progress: number): number {
  const p = Math.max(0, Math.min(1, progress));
  const inv = 1 - p;
  return 1 - inv * inv * inv;
}

/**
 * Computes the anchor-relative offset for a candidate bounding rectangle.
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
 * Initializes or updates an area label's motion state.
 * If the target offset changes, marks the label as needing movement and synchronizes
 * with the shared motion timeline.
 *
 * Returns true if this label initiated or joined an active motion transition.
 */
export function registerLabelMotionTarget(
  motionMap: Map<string, AreaMotionState>,
  timeline: SynchronizedMotionTimeline,
  areaId: string,
  candidateIndex: number,
  targetOffset: Point2D,
  now: number,
  prefersReducedMotion = false,
  durationMs = DEFAULT_MOTION_DURATION_MS
): boolean {
  let state = motionMap.get(areaId);

  // If first encounter, initialize immediately at target position with no transition
  if (!state) {
    state = {
      areaId,
      currentOffset: { ...targetOffset },
      startOffset: { ...targetOffset },
      targetOffset: { ...targetOffset },
      candidateIndex,
    };
    motionMap.set(areaId, state);
    return false;
  }

  // If prefers-reduced-motion, snap immediately to target
  if (prefersReducedMotion) {
    state.currentOffset = { ...targetOffset };
    state.startOffset = { ...targetOffset };
    state.targetOffset = { ...targetOffset };
    state.candidateIndex = candidateIndex;
    timeline.activeAreaIds.delete(areaId);
    return false;
  }

  const dx = targetOffset.x - state.targetOffset.x;
  const dy = targetOffset.y - state.targetOffset.y;
  const targetDistance = Math.hypot(dx, dy);

  // If target candidate or position has changed meaningfully (> 1px)
  if (targetDistance > 1.0 || candidateIndex !== state.candidateIndex) {
    // Rebase start offset from current interpolated position to ensure zero snapping
    state.startOffset = { ...state.currentOffset };
    state.targetOffset = { ...targetOffset };
    state.candidateIndex = candidateIndex;

    // Join the synchronized motion timeline
    timeline.activeAreaIds.add(areaId);

    // Synchronize batch start time: all affected labels share the same clock.
    // If this transition begins at a new timestamp, rebase all existing active labels
    // to their current interpolated offsets to prevent backward snapping.
    if (timeline.startTime !== now) {
      for (const existingId of timeline.activeAreaIds) {
        if (existingId !== areaId) {
          const existingState = motionMap.get(existingId);
          if (existingState) {
            existingState.startOffset = { ...existingState.currentOffset };
          }
        }
      }
      timeline.startTime = now;
      timeline.durationMs = durationMs;
    }
    return true;
  }

  return timeline.activeAreaIds.has(areaId);
}

/**
 * Advances all active label motions along the synchronized timeline.
 * Returns true if any motion transition remains active (requiring another animation frame).
 */
export function stepSynchronizedMotion(
  motionMap: Map<string, AreaMotionState>,
  timeline: SynchronizedMotionTimeline,
  now: number,
  prefersReducedMotion = false
): boolean {
  if (timeline.activeAreaIds.size === 0) {
    return false;
  }

  if (prefersReducedMotion) {
    for (const areaId of timeline.activeAreaIds) {
      const state = motionMap.get(areaId);
      if (state) {
        state.currentOffset = { ...state.targetOffset };
        state.startOffset = { ...state.targetOffset };
      }
    }
    timeline.activeAreaIds.clear();
    return false;
  }

  const elapsed = Math.max(0, now - timeline.startTime);
  const rawProgress = timeline.durationMs > 0 ? elapsed / timeline.durationMs : 1.0;
  const progress = Math.min(1.0, rawProgress);
  const easedProgress = cubicEaseOut(progress);

  const completedIds: string[] = [];

  for (const areaId of timeline.activeAreaIds) {
    const state = motionMap.get(areaId);
    if (!state) {
      completedIds.push(areaId);
      continue;
    }

    if (progress >= 1.0) {
      // Completed destination arrival
      state.currentOffset = { ...state.targetOffset };
      state.startOffset = { ...state.targetOffset };
      completedIds.push(areaId);
    } else {
      // Smooth synchronized interpolation
      state.currentOffset = {
        x: state.startOffset.x + (state.targetOffset.x - state.startOffset.x) * easedProgress,
        y: state.startOffset.y + (state.targetOffset.y - state.startOffset.y) * easedProgress,
      };
    }
  }

  for (const id of completedIds) {
    timeline.activeAreaIds.delete(id);
  }

  return timeline.activeAreaIds.size > 0;
}

/**
 * Computes the actual screen rectangle for an area label from the anchor screen coordinates,
 * animated relative offset, and label dimensions.
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
