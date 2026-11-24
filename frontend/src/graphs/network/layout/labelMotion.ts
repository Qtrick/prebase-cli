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
  startTime?: number;
  durationMs?: number;
  isRelocating?: boolean;
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
 *
 * Implements three distinct motion categories:
 * A. Continuous camera-driven tracking: When the candidate placement remains stable,
 *    relative offsets are directly coupled with zero transition delay, zero lag,
 *    and zero timeline resets, guaranteeing that 1px anchor movement produces 1px label movement.
 * B. Minor geometry adjustments: Slight adjustments to anchor radius or subpixels
 *    update directly without restarting layout animations.
 * C. Genuine layout relocation: When a candidate placement changes (e.g. 'below' to 'above'),
 *    a smooth synchronized cubic ease-out transition is initiated, rebasing from the
 *    exact currently rendered position with zero snapping or teleportation.
 *
 * Returns true if this label initiated or is actively participating in a relocation transition.
 */
export function registerLabelMotionTarget(
  motionMap: Map<string, AreaMotionState>,
  timeline: SynchronizedMotionTimeline,
  areaId: string,
  candidateIndex: number,
  targetOffset: Point2D,
  now: number,
  prefersReducedMotion = false,
  durationMs?: number,
  isReentry = false
): boolean {
  const effectiveDuration = durationMs ?? (timeline.durationMs > 0 ? timeline.durationMs : DEFAULT_MOTION_DURATION_MS);
  let state = motionMap.get(areaId);

  // If first encounter or re-entering from hidden/suppressed state, initialize immediately
  // at current target position with zero transition
  if (!state || isReentry) {
    if (!state) {
      state = {
        areaId,
        currentOffset: { ...targetOffset },
        startOffset: { ...targetOffset },
        targetOffset: { ...targetOffset },
        candidateIndex,
        isRelocating: false,
      };
      motionMap.set(areaId, state);
    } else {
      state.currentOffset = { ...targetOffset };
      state.startOffset = { ...targetOffset };
      state.targetOffset = { ...targetOffset };
      state.candidateIndex = candidateIndex;
      state.isRelocating = false;
      timeline.activeAreaIds.delete(areaId);
    }
    return false;
  }

  // Under prefers-reduced-motion, immediately snap to target position without animation
  if (prefersReducedMotion) {
    state.currentOffset = { ...targetOffset };
    state.startOffset = { ...targetOffset };
    state.targetOffset = { ...targetOffset };
    state.candidateIndex = candidateIndex;
    state.isRelocating = false;
    timeline.activeAreaIds.delete(areaId);
    return false;
  }

  const isCandidateChange = candidateIndex !== state.candidateIndex;

  // Case A & B: Candidate placement is stable (e.g. still 'below')
  if (!isCandidateChange) {
    if (state.isRelocating) {
      // Label is already in an active relocation transition towards this candidate:
      // smoothly update destination geometry (e.g. minor anchor radius change)
      // without resetting timeline or rebasing, preventing animation starvation!
      state.targetOffset = { ...targetOffset };
      return true;
    }

    // Direct anchor-coupled tracking with continuous minor geometry adaptation:
    // Update offsets directly with zero animation delay, zero lag, and zero timeline resets!
    state.currentOffset = { ...targetOffset };
    state.startOffset = { ...targetOffset };
    state.targetOffset = { ...targetOffset };
    timeline.activeAreaIds.delete(areaId);
    return false;
  }

  // Case C: Genuine layout relocation (candidate changed from one placement to another)
  // Rebase start offset from current rendered position to ensure zero snapping or teleportation
  state.startOffset = { ...state.currentOffset };
  state.targetOffset = { ...targetOffset };
  state.candidateIndex = candidateIndex;
  state.startTime = now;
  state.durationMs = effectiveDuration;
  state.isRelocating = true;

  // Join the synchronized motion timeline
  timeline.activeAreaIds.add(areaId);

  // Synchronize batch start time: all affected labels in this update share the same clock.
  // Rebase any existing active labels to their current interpolated offsets to prevent backward snapping.
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
    timeline.durationMs = effectiveDuration;
  }

  return true;
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
        state.isRelocating = false;
      }
    }
    timeline.activeAreaIds.clear();
    return false;
  }

  const completedIds: string[] = [];

  for (const areaId of timeline.activeAreaIds) {
    const state = motionMap.get(areaId);
    if (!state) {
      completedIds.push(areaId);
      continue;
    }

    const startTime = state.startTime ?? timeline.startTime;
    const durationMs = state.durationMs ?? timeline.durationMs;
    const elapsed = Math.max(0, now - startTime);
    const rawProgress = durationMs > 0 ? elapsed / durationMs : 1.0;
    const progress = Math.min(1.0, rawProgress);
    const easedProgress = cubicEaseOut(progress);

    if (progress >= 1.0) {
      // Completed destination arrival
      state.currentOffset = { ...state.targetOffset };
      state.startOffset = { ...state.targetOffset };
      state.isRelocating = false;
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
