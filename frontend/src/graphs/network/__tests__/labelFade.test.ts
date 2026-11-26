import { describe, it, expect } from 'vitest';
import {
  computeLabelTargetOpacity,
  stepLabelFade,
  AreaFadeState,
  ENTER_PROMINENCE_THRESHOLD,
  EXIT_PROMINENCE_THRESHOLD,
} from '../layout/labelFade';

describe('Smooth Area Label Fade Transitions (labelFade.ts)', () => {
  describe('computeLabelTargetOpacity', () => {
    it('returns 1.0 immediately for priority (selected/hovered) areas regardless of depth', () => {
      // Rear facing, zero prominence, but is priority
      expect(computeLabelTargetOpacity(false, 0.1, true, 0.0)).toBe(1.0);
    });

    it('requires prominence >= ENTER_THRESHOLD (0.38) when currently hidden (opacity <= 0.05)', () => {
      // Just below enter threshold
      expect(computeLabelTargetOpacity(true, ENTER_PROMINENCE_THRESHOLD - 0.03, false, 0.0)).toBe(0.0);
      // At or above enter threshold
      expect(computeLabelTargetOpacity(true, ENTER_PROMINENCE_THRESHOLD + 0.02, false, 0.0)).toBe(1.0);
    });

    it('implements depth hysteresis: stays visible until prominence drops below EXIT_THRESHOLD (0.28)', () => {
      // Currently visible (opacity = 0.8)
      // Prominence is between enter and exit thresholds
      expect(computeLabelTargetOpacity(true, (ENTER_PROMINENCE_THRESHOLD + EXIT_PROMINENCE_THRESHOLD) / 2, false, 0.8)).toBe(1.0);

      // Drops below exit threshold
      expect(computeLabelTargetOpacity(true, EXIT_PROMINENCE_THRESHOLD - 0.03, false, 0.8)).toBe(0.0);
    });

    it('returns 0.0 when anchor is not front-facing', () => {
      expect(computeLabelTargetOpacity(false, 0.5, false, 0.8)).toBe(0.0);
    });
  });

  describe('stepLabelFade', () => {
    it('interpolates opacity smoothly over 200ms', () => {
      const state: AreaFadeState = {
        currentOpacity: 0.0,
        targetOpacity: 1.0,
        lastTimestamp: 1000,
      };

      // Advance by 50ms (rate is 1/200ms = 0.005/ms -> step = 0.25)
      const isTransitioning1 = stepLabelFade(state, 1.0, 1050, false, 200);
      expect(isTransitioning1).toBe(true);
      expect(state.currentOpacity).toBeCloseTo(0.25, 2);

      // Advance by another 150ms -> reaches 1.0
      const isTransitioning2 = stepLabelFade(state, 1.0, 1200, false, 200);
      expect(isTransitioning2).toBe(false);
      expect(state.currentOpacity).toBe(1.0);
    });

    it('handles rapid reversal mid-fade smoothly without snapping', () => {
      const state: AreaFadeState = {
        currentOpacity: 0.5,
        targetOpacity: 1.0,
        lastTimestamp: 1000,
      };

      // User suddenly rotates back: target flips to 0.0
      // Advance by 40ms -> step = 40 * 0.005 = 0.20 down from 0.5 -> 0.30
      const isTransitioning = stepLabelFade(state, 0.0, 1040, false, 200);
      expect(isTransitioning).toBe(true);
      expect(state.currentOpacity).toBeCloseTo(0.30, 2);
    });

    it('snaps immediately to target when prefersReducedMotion is enabled', () => {
      const state: AreaFadeState = {
        currentOpacity: 0.0,
        targetOpacity: 1.0,
        lastTimestamp: 1000,
      };

      const isTransitioning = stepLabelFade(state, 1.0, 1010, true, 200);
      expect(isTransitioning).toBe(false);
      expect(state.currentOpacity).toBe(1.0);
    });

    it('simulates full sequential multi-frame hysteresis rotation lifecycle', () => {
      // Step 1: Label starts hidden at opacity 0.0
      let opacity = 0.0;
      let target = computeLabelTargetOpacity(true, 0.35, false, opacity);
      // Prominence 0.35 < 0.38 (ENTER_THRESHOLD) -> stays hidden
      expect(target).toBe(0.0);

      // Step 2: Anchor rotates further forward to prominence 0.40 >= 0.38
      target = computeLabelTargetOpacity(true, 0.40, false, opacity);
      expect(target).toBe(1.0);

      // Step 3: Fades in partially over 50ms
      const state: AreaFadeState = { currentOpacity: opacity, targetOpacity: target, lastTimestamp: 1000 };
      stepLabelFade(state, target, 1050, false, 200);
      opacity = state.currentOpacity;
      expect(opacity).toBeCloseTo(0.25, 2);

      // Step 4: Subtle camera wobble causes prominence to dip to 0.32 (between EXIT 0.28 and ENTER 0.38)
      // Because label is already visible (opacity = 0.25 > 0.05), target STAYS 1.0 (anti-flutter)
      target = computeLabelTargetOpacity(true, 0.32, false, opacity);
      expect(target).toBe(1.0);

      // Step 5: Advance remaining 150ms to reach full opacity 1.0
      stepLabelFade(state, target, 1200, false, 200);
      opacity = state.currentOpacity;
      expect(opacity).toBe(1.0);

      // Step 6: Rotates toward back: prominence drops to 0.24 < 0.28 (EXIT_THRESHOLD)
      target = computeLabelTargetOpacity(true, 0.24, false, opacity);
      expect(target).toBe(0.0);

      // Step 7: First frame after being idle at 1.0 clamps initial delta to 16ms (0.08 step -> 0.92)
      stepLabelFade(state, target, 1300, false, 200);
      opacity = state.currentOpacity;
      expect(opacity).toBeCloseTo(0.92, 2);

      // Subsequent 100ms frame advances normally (0.50 step -> 0.42)
      stepLabelFade(state, target, 1400, false, 200);
      opacity = state.currentOpacity;
      expect(opacity).toBeCloseTo(0.42, 2);

      // Step 8: Fades completely out over another 85ms
      stepLabelFade(state, target, 1485, false, 200);
      opacity = state.currentOpacity;
      expect(opacity).toBe(0.0);

      // Step 9: Re-entry gating: camera wobble moves prominence to 0.33
      // Because opacity <= 0.05, prominence must cross ENTER_THRESHOLD (0.38) again; 0.33 remains 0.0
      target = computeLabelTargetOpacity(true, 0.33, false, opacity);
      expect(target).toBe(0.0);
    });

    it('clamps large time jumps (e.g. background tab) to 500ms max delta without corruption', () => {
      const state: AreaFadeState = {
        currentOpacity: 0.0,
        targetOpacity: 1.0,
        lastTimestamp: 1000,
      };

      // User switched tabs for 30 seconds (30000ms delta)
      const isTransitioning = stepLabelFade(state, 1.0, 31000, false, 200);
      // Delta is clamped to 500ms: rate = 1/200, step = 2.5 -> reaches 1.0 cleanly
      expect(isTransitioning).toBe(false);
      expect(state.currentOpacity).toBe(1.0);
    });

    it('clamps zero or backwards timestamp deltas to 1ms', () => {
      const state: AreaFadeState = {
        currentOpacity: 0.0,
        targetOpacity: 1.0,
        lastTimestamp: 1000,
      };

      // Duplicate timestamp (now === lastTimestamp)
      const isTransitioning = stepLabelFade(state, 1.0, 1000, false, 200);
      // Delta is clamped to 1ms: rate = 1/200, step = 0.005
      expect(isTransitioning).toBe(true);
      expect(state.currentOpacity).toBeCloseTo(0.005, 3);
    });

    it('handles multi-step bidirectional oscillation smoothly without jumps', () => {
      const state: AreaFadeState = {
        currentOpacity: 0.0,
        targetOpacity: 1.0,
        lastTimestamp: 1000,
      };

      // Fade up 80ms -> 0.40
      stepLabelFade(state, 1.0, 1080, false, 200);
      expect(state.currentOpacity).toBeCloseTo(0.40, 2);

      // Flip target to 0.0, fade down 40ms -> 0.20
      stepLabelFade(state, 0.0, 1120, false, 200);
      expect(state.currentOpacity).toBeCloseTo(0.20, 2);

      // Flip target back to 1.0, fade up 100ms -> 0.70
      stepLabelFade(state, 1.0, 1220, false, 200);
      expect(state.currentOpacity).toBeCloseTo(0.70, 2);
    });

    it('reverses smoothly when priority is released on a rear-facing anchor', () => {
      const state: AreaFadeState = {
        currentOpacity: 0.0,
        targetOpacity: 0.0,
        lastTimestamp: 1000,
      };

      // Rear-facing anchor (isFront = false, prominence = 0.1)
      // 1. User hovers: isPriority = true -> target becomes 1.0
      let target = computeLabelTargetOpacity(false, 0.1, true, state.currentOpacity);
      expect(target).toBe(1.0);

      // 2. First frame after idle at 0.0 clamps initial delta to 16ms (0.08), then 84ms reaches 0.50
      stepLabelFade(state, target, 1100, false, 200);
      expect(state.currentOpacity).toBeCloseTo(0.08, 2);
      stepLabelFade(state, target, 1184, false, 200);
      expect(state.currentOpacity).toBeCloseTo(0.50, 2);

      // 3. User unhovers: isPriority = false -> target becomes 0.0 immediately
      target = computeLabelTargetOpacity(false, 0.1, false, state.currentOpacity);
      expect(target).toBe(0.0);

      // 4. Smoothly fades back down to 0.0 over 100ms
      const isTransitioning = stepLabelFade(state, target, 1284, false, 200);
      expect(isTransitioning).toBe(false);
      expect(state.currentOpacity).toBe(0.0);
    });

    it('signals idle state (false) when transition completes and active (true) during fade', () => {
      const state: AreaFadeState = {
        currentOpacity: 0.0,
        targetOpacity: 1.0,
        lastTimestamp: 1000,
      };

      // Active while interpolating
      expect(stepLabelFade(state, 1.0, 1050, false, 200)).toBe(true);
      expect(stepLabelFade(state, 1.0, 1150, false, 200)).toBe(true);

      // Reaches target within epsilon -> returns false to let animation loop sleep
      expect(stepLabelFade(state, 1.0, 1200, false, 200)).toBe(false);
      expect(state.currentOpacity).toBe(1.0);
    });

    it('idle-timestamp fix: after being idle at 1.0 for 10,000ms, transitioning to 0.0 steps gradually without snapping', () => {
      const state: AreaFadeState = {
        currentOpacity: 1.0,
        targetOpacity: 1.0,
        lastTimestamp: 1000,
      };

      // Simulate 10,000ms idle period before a fade-out begins
      const isTransitioning = stepLabelFade(state, 0.0, 11000, false, 200);

      // Initial frame delta is clamped to 16ms (step = 16 / 200 = 0.08), not 500ms or 10000ms
      expect(isTransitioning).toBe(true);
      expect(state.currentOpacity).toBeCloseTo(0.92, 4);
      expect(state.currentOpacity).toBeGreaterThan(0.8);
      expect(state.targetOpacity).toBe(0.0);

      // Subsequent frame advances normally from 0.92 (e.g. +50ms -> step = 0.25 -> 0.67)
      const isTransitioningNext = stepLabelFade(state, 0.0, 11050, false, 200);
      expect(isTransitioningNext).toBe(true);
      expect(state.currentOpacity).toBeCloseTo(0.67, 4);
    });

    it('idle-timestamp fix: after being idle at 0.0 for 10,000ms, transitioning to 1.0 steps gradually without snapping', () => {
      const state: AreaFadeState = {
        currentOpacity: 0.0,
        targetOpacity: 0.0,
        lastTimestamp: 1000,
      };

      const isTransitioning = stepLabelFade(state, 1.0, 11000, false, 200);
      expect(isTransitioning).toBe(true);
      expect(state.currentOpacity).toBeCloseTo(0.08, 4);
      expect(state.currentOpacity).toBeLessThan(0.2);
    });

    it('mid-flight reversal from partial opacity starts from current opacity without snapping', () => {
      // Case 1: Fading in (0 -> 1), paused mid-flight at 0.64, then target reverses to 0.0
      const fadeInState: AreaFadeState = {
        currentOpacity: 0.64,
        targetOpacity: 1.0,
        lastTimestamp: 1000,
      };

      const isTransitioningOut = stepLabelFade(fadeInState, 0.0, 1020, false, 200);
      // delta = 20ms -> step = 0.10 -> 0.64 - 0.10 = 0.54 (no snap to 1.0 or 0.0)
      expect(isTransitioningOut).toBe(true);
      expect(fadeInState.currentOpacity).toBeCloseTo(0.54, 4);

      // Case 2: Fading out (1 -> 0), at 0.35, then target reverses back to 1.0
      const fadeOutState: AreaFadeState = {
        currentOpacity: 0.35,
        targetOpacity: 0.0,
        lastTimestamp: 2000,
      };

      const isTransitioningIn = stepLabelFade(fadeOutState, 1.0, 2020, false, 200);
      // delta = 20ms -> step = 0.10 -> 0.35 + 0.10 = 0.45
      expect(isTransitioningIn).toBe(true);
      expect(fadeOutState.currentOpacity).toBeCloseTo(0.45, 4);
    });
  });
});
