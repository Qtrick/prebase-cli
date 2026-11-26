/**
 * PreBase — Smooth Depth-Aware Label Fade Transition Manager
 *
 * Implements smooth temporal opacity transitions (180-220ms), depth threshold hysteresis
 * to prevent boundary fluttering, demand-driven animation scheduling, and reduced-motion support.
 */

export interface AreaFadeState {
  currentOpacity: number;
  targetOpacity: number;
  lastTimestamp: number;
  candidateIndex?: number;
}

export const ENTER_PROMINENCE_THRESHOLD = 0.38;
export const EXIT_PROMINENCE_THRESHOLD = 0.28;
export const FADE_DURATION_MS = 200;

/**
 * Calculates the target opacity for an area label based on front-facing state,
 * depth prominence, selection/hover states, and entry/exit hysteresis.
 */
export function computeLabelTargetOpacity(
  isFront: boolean,
  prominence: number,
  isPriority: boolean, // selected or hovered
  currentOpacity: number
): number {
  if (isPriority) {
    return 1.0;
  }

  // If currently hidden or fading out, require higher prominence threshold to become eligible
  if (currentOpacity <= 0.05) {
    return isFront && prominence >= ENTER_PROMINENCE_THRESHOLD ? 1.0 : 0.0;
  }

  // If currently visible or fading in, remain eligible until prominence drops below exit threshold
  return isFront && prominence >= EXIT_PROMINENCE_THRESHOLD ? 1.0 : 0.0;
}

/**
 * Advances the opacity of an area label towards its target opacity over the specified duration.
 * Returns true if an active transition is still in progress (requiring another animation frame).
 */
export function stepLabelFade(
  state: AreaFadeState,
  targetOpacity: number,
  now: number,
  prefersReducedMotion = false,
  fadeDurationMs = FADE_DURATION_MS
): boolean {
  const previousTarget = state.targetOpacity;
  state.targetOpacity = targetOpacity;

  if (prefersReducedMotion) {
    state.currentOpacity = targetOpacity;
    state.lastTimestamp = now;
    return false;
  }

  // If already at target, keep lastTimestamp fresh so a future fade after an
  // idle period does not consume stale elapsed time on its first frame.
  if (Math.abs(state.currentOpacity - targetOpacity) <= 0.001) {
    state.currentOpacity = targetOpacity;
    state.lastTimestamp = now;
    return false;
  }

  // When a new transition starts after being idle at the previous target,
  // clamp the initial frame delta so long idle gaps never snap the fade.
  const rawDelta = now - (state.lastTimestamp || now);
  const wasIdleAtPreviousTarget =
    previousTarget !== targetOpacity && Math.abs(state.currentOpacity - previousTarget) <= 0.005;
  const delta = wasIdleAtPreviousTarget
    ? Math.min(16, Math.max(1, rawDelta))
    : Math.min(500, Math.max(1, rawDelta));
  state.lastTimestamp = now;

  const rate = 1.0 / fadeDurationMs;
  const step = rate * delta;

  if (Math.abs(state.currentOpacity - targetOpacity) <= step) {
    state.currentOpacity = targetOpacity;
    return false;
  }

  if (state.currentOpacity < targetOpacity) {
    state.currentOpacity = Math.min(targetOpacity, state.currentOpacity + step);
  } else {
    state.currentOpacity = Math.max(targetOpacity, state.currentOpacity - step);
  }

  if (Math.abs(state.currentOpacity - targetOpacity) <= 0.005) {
    state.currentOpacity = targetOpacity;
    return false;
  }

  return true;
}
