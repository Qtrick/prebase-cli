/**
 * PreBase — Continuous Retargetable Architectural Label Motion Engine
 *
 * Implements smooth anchor-relative coordinate interpolation via an analytical
 * critically-damped spring, 1:1 anchor tracking when settled, retargeting and
 * direction-reversal velocity continuity, and reduced-motion compliance.
 *
 * Guarantees that:
 * 1. Labels never teleport or snap when changing candidate placements or reversing direction.
 * 2. Retargeting mid-flight preserves both rendered position and velocity (C1 continuity).
 * 3. Settled labels track moving anchors 1:1 with zero lag during continuous camera motion.
 * 4. Demand-driven scheduling ensures zero idle CPU when labels are settled.
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
  velocity?: Point2D;
  candidateIndex: number;
  startTime?: number;
  lastTimestamp?: number;
  lastCandidateSwitchTime?: number;
  durationMs?: number;
  isRelocating?: boolean;
}

export interface SynchronizedMotionTimeline {
  startTime: number;
  durationMs: number;
  activeAreaIds: Set<string>;
}

export const DEFAULT_MOTION_DURATION_MS = 220;
export const DEFAULT_SPRING_OMEGA = 38; // rad/s (settles cleanly within ~220ms)
export const SPRING_POSITION_EPSILON = 0.25; // px
export const SPRING_VELOCITY_EPSILON = 6.0; // px/s (~0.1px/frame at 60Hz)
const MAX_SPRING_DT_SEC = 1.0;

/**
 * Restrained cubic ease-out function: f(p) = 1 - (1 - p)^3
 * Retained for curve utilities and reference.
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
 * Advances a single 1D axis using the exact analytical critically-damped spring
 * solution (damping ratio zeta = 1). Unconditionally stable for any dt >= 0 and
 * preserves C1 position + velocity continuity across retargeting.
 */
function stepCriticallyDampedSpringAxis(
  current: number,
  target: number,
  velocity: number,
  omega: number,
  dtSec: number
): { value: number; velocity: number } {
  if (dtSec <= 0) {
    return { value: current, velocity };
  }
  const x0 = current - target;
  const c2 = velocity + omega * x0;
  const decay = Math.exp(-omega * dtSec);
  const displacement = (x0 + c2 * dtSec) * decay;
  const nextVel = (c2 - omega * (x0 + c2 * dtSec)) * decay;
  return {
    value: target + displacement,
    velocity: nextVel,
  };
}

/**
 * Initializes or updates an area label's motion state.
 *
 * Implements three distinct motion categories:
 * A. Continuous camera-driven tracking: When the candidate placement remains stable
 *    and settled, relative offsets are directly coupled with zero transition delay
 *    and zero lag (1px anchor movement = 1px label movement).
 * B. Active relocation target updates: While a spring transition is in flight,
 *    updates to target geometry (e.g. zoom radius changes) smoothly steer the
 *    moving target without resetting position, velocity, or causing starvation.
 * C. Candidate relocation / retargeting: When a candidate placement changes,
 *    the spring retargets from the exact current rendered offset and velocity
 *    with zero snapping or teleportation.
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
        velocity: { x: 0, y: 0 },
        candidateIndex,
        lastTimestamp: now,
        isRelocating: false,
      };
      motionMap.set(areaId, state);
    } else {
      state.currentOffset = { ...targetOffset };
      state.startOffset = { ...targetOffset };
      state.targetOffset = { ...targetOffset };
      state.velocity = { x: 0, y: 0 };
      state.candidateIndex = candidateIndex;
      state.lastTimestamp = now;
      state.isRelocating = false;
      timeline.activeAreaIds.delete(areaId);
    }
    return false;
  }

  // Under prefers-reduced-motion or zero duration, immediately snap to target position
  if (prefersReducedMotion || effectiveDuration <= 0) {
    state.currentOffset = { ...targetOffset };
    state.startOffset = { ...targetOffset };
    state.targetOffset = { ...targetOffset };
    state.velocity = { x: 0, y: 0 };
    if (candidateIndex !== state.candidateIndex) {
      state.lastCandidateSwitchTime = now;
    }
    state.candidateIndex = candidateIndex;
    state.lastTimestamp = now;
    state.isRelocating = false;
    timeline.activeAreaIds.delete(areaId);
    return false;
  }

  const isCandidateChange = candidateIndex !== state.candidateIndex;

  // Case A & B: Candidate placement is stable
  if (!isCandidateChange) {
    if (state.isRelocating) {
      // Spring is in flight towards this candidate: smoothly steer targetOffset
      // without resetting velocity or position.
      state.targetOffset = { ...targetOffset };
      return true;
    }

    // Settled direct anchor-coupled tracking: 1px anchor movement = 1px label movement.
    state.currentOffset = { ...targetOffset };
    state.startOffset = { ...targetOffset };
    state.targetOffset = { ...targetOffset };
    state.velocity = { x: 0, y: 0 };
    state.lastTimestamp = now;
    timeline.activeAreaIds.delete(areaId);
    return false;
  }

  // Case C: Candidate changed — retarget critically-damped spring from current
  // rendered offset and current velocity (C1 continuous, zero snapping).
  state.startOffset = { ...state.currentOffset };
  state.targetOffset = { ...targetOffset };
  if (!state.velocity) {
    state.velocity = { x: 0, y: 0 };
  }
  state.candidateIndex = candidateIndex;
  state.startTime = now;
  state.lastTimestamp = state.lastTimestamp ?? now;
  state.lastCandidateSwitchTime = now;
  state.durationMs = effectiveDuration;
  state.isRelocating = true;

  timeline.activeAreaIds.add(areaId);
  timeline.startTime = now;
  timeline.durationMs = effectiveDuration;

  return true;
}

/**
 * Advances all active label motions using the critically-damped spring solver.
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
        state.velocity = { x: 0, y: 0 };
        state.lastTimestamp = now;
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

    const durationMs = state.durationMs ?? timeline.durationMs;
    if (durationMs <= 0) {
      state.currentOffset = { ...state.targetOffset };
      state.startOffset = { ...state.targetOffset };
      state.velocity = { x: 0, y: 0 };
      state.lastTimestamp = now;
      state.isRelocating = false;
      completedIds.push(areaId);
      continue;
    }

    const prevTime = state.lastTimestamp ?? state.startTime ?? timeline.startTime;
    const rawDtSec = Math.max(0, (now - prevTime) / 1000);
    const dtSec = Math.min(MAX_SPRING_DT_SEC, rawDtSec);
    state.lastTimestamp = Math.max(prevTime, now);

    // Scale omega inversely with durationMs so 220ms -> DEFAULT_SPRING_OMEGA
    const omega = DEFAULT_SPRING_OMEGA * (DEFAULT_MOTION_DURATION_MS / durationMs);
    const vel = state.velocity ?? { x: 0, y: 0 };

    const nextX = stepCriticallyDampedSpringAxis(
      state.currentOffset.x,
      state.targetOffset.x,
      vel.x,
      omega,
      dtSec
    );
    const nextY = stepCriticallyDampedSpringAxis(
      state.currentOffset.y,
      state.targetOffset.y,
      vel.y,
      omega,
      dtSec
    );

    state.currentOffset = { x: nextX.value, y: nextY.value };
    state.velocity = { x: nextX.velocity, y: nextY.velocity };

    const dist = Math.hypot(
      state.currentOffset.x - state.targetOffset.x,
      state.currentOffset.y - state.targetOffset.y
    );
    const speed = Math.hypot(state.velocity.x, state.velocity.y);

    if (dist < SPRING_POSITION_EPSILON && speed < SPRING_VELOCITY_EPSILON) {
      state.currentOffset = { ...state.targetOffset };
      state.startOffset = { ...state.targetOffset };
      state.velocity = { x: 0, y: 0 };
      state.isRelocating = false;
      completedIds.push(areaId);
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
