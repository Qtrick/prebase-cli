import { describe, it, expect } from 'vitest';
import {
  cubicEaseOut,
  computeAnchorRelativeOffset,
  computeRenderedLabelRect,
  registerLabelMotionTarget,
  stepSynchronizedMotion,
  AreaMotionState,
  SynchronizedMotionTimeline,
  DEFAULT_MOTION_DURATION_MS,
} from '../layout/labelMotion';

describe('Synchronized Architectural Label Motion Engine (labelMotion.ts)', () => {
  describe('cubicEaseOut curve', () => {
    it('returns exact boundary values at 0 and 1', () => {
      expect(cubicEaseOut(0)).toBe(0);
      expect(cubicEaseOut(1)).toBe(1);
    });

    it('clamps inputs below 0 and above 1', () => {
      expect(cubicEaseOut(-0.5)).toBe(0);
      expect(cubicEaseOut(1.5)).toBe(1);
    });

    it('provides responsive departure with gentle arrival (ease-out deceleration)', () => {
      const p25 = cubicEaseOut(0.25);
      const p50 = cubicEaseOut(0.5);
      const p75 = cubicEaseOut(0.75);

      // At 50% time elapsed, cubic ease-out has achieved 87.5% distance
      expect(p50).toBeCloseTo(0.875, 3);
      // Slope decreases monotonically: (p25 - p0) > (p50 - p25) > (p75 - p50) > (p100 - p75)
      expect(p25).toBeGreaterThan(0.25);
      expect(p50 - p25).toBeLessThan(p25);
      expect(p75 - p50).toBeLessThan(p50 - p25);
    });
  });

  describe('Anchor-relative offset geometry', () => {
    it('computes offset relative to anchor coordinates', () => {
      const anchorX = 200;
      const anchorY = 300;
      const rect = { x1: 180, y1: 320, x2: 240, y2: 352 };

      const offset = computeAnchorRelativeOffset(anchorX, anchorY, rect);
      expect(offset.x).toBe(-20);
      expect(offset.y).toBe(20);
    });

    it('reconstructs rendered rect accurately using anchor position and offset', () => {
      const anchorX = 200;
      const anchorY = 300;
      const offset = { x: -20, y: 20 };
      const boxWidth = 60;
      const boxHeight = 32;

      const rect = computeRenderedLabelRect(anchorX, anchorY, offset, boxWidth, boxHeight);
      expect(rect.x1).toBe(180);
      expect(rect.y1).toBe(320);
      expect(rect.x2).toBe(240);
      expect(rect.y2).toBe(352);
    });

    it('maintains relative placement when camera moves the 3D anchor', () => {
      const initialAnchor = { x: 200, y: 300 };
      const movedAnchor = { x: 260, y: 340 };
      const offset = { x: 15, y: -40 };

      const rectBefore = computeRenderedLabelRect(initialAnchor.x, initialAnchor.y, offset, 50, 30);
      const rectAfter = computeRenderedLabelRect(movedAnchor.x, movedAnchor.y, offset, 50, 30);

      expect(rectAfter.x1 - rectBefore.x1).toBe(60);
      expect(rectAfter.y1 - rectBefore.y1).toBe(40);
    });
  });

  describe('registerLabelMotionTarget', () => {
    function createFixture() {
      const motionMap = new Map<string, AreaMotionState>();
      const timeline: SynchronizedMotionTimeline = {
        startTime: 0,
        durationMs: DEFAULT_MOTION_DURATION_MS,
        activeAreaIds: new Set<string>(),
      };
      return { motionMap, timeline };
    }

    it('initializes new label immediately at target position with zero transition', () => {
      const { motionMap, timeline } = createFixture();

      const active = registerLabelMotionTarget(
        motionMap,
        timeline,
        'area-a',
        0,
        { x: -30, y: 20 },
        1000
      );

      expect(active).toBe(false);
      expect(timeline.activeAreaIds.has('area-a')).toBe(false);
      const state = motionMap.get('area-a')!;
      expect(state.currentOffset).toEqual({ x: -30, y: 20 });
      expect(state.startOffset).toEqual({ x: -30, y: 20 });
      expect(state.targetOffset).toEqual({ x: -30, y: 20 });
    });

    it('initiates synchronized motion when candidate or target offset changes', () => {
      const { motionMap, timeline } = createFixture();

      // Initialize
      registerLabelMotionTarget(motionMap, timeline, 'area-a', 0, { x: 0, y: 20 }, 1000);

      // Candidate changes to candidate 1 (above: y = -40)
      const active = registerLabelMotionTarget(
        motionMap,
        timeline,
        'area-a',
        1,
        { x: 0, y: -40 },
        1100
      );

      expect(active).toBe(true);
      expect(timeline.activeAreaIds.has('area-a')).toBe(true);
      expect(timeline.startTime).toBe(1100);

      const state = motionMap.get('area-a')!;
      expect(state.startOffset).toEqual({ x: 0, y: 20 });
      expect(state.targetOffset).toEqual({ x: 0, y: -40 });
      expect(state.candidateIndex).toBe(1);
    });

    it('rebases startOffset from current interpolated position on mid-animation retarget', () => {
      const { motionMap, timeline } = createFixture();

      // Initialize at 0, 20
      registerLabelMotionTarget(motionMap, timeline, 'area-a', 0, { x: 0, y: 20 }, 1000);
      // Retarget to 0, -40 at t=1000
      registerLabelMotionTarget(motionMap, timeline, 'area-a', 1, { x: 0, y: -40 }, 1000);

      // Advance halfway (110ms into 220ms duration)
      stepSynchronizedMotion(motionMap, timeline, 1110);
      const halfwayState = motionMap.get('area-a')!;
      const halfwayY = halfwayState.currentOffset.y;
      expect(halfwayY).toBeLessThan(20);
      expect(halfwayY).toBeGreaterThan(-40);

      // Interrupt and retarget to candidate 2 (right: x=30, y=0) at t=1110
      registerLabelMotionTarget(motionMap, timeline, 'area-a', 2, { x: 30, y: 0 }, 1110);

      // Start position MUST be rebased to the exact halfway point with zero snapping
      expect(halfwayState.startOffset.y).toBe(halfwayY);
      expect(halfwayState.targetOffset).toEqual({ x: 30, y: 0 });
      expect(timeline.startTime).toBe(1110);
    });

    it('immediately snaps to target position under prefers-reduced-motion', () => {
      const { motionMap, timeline } = createFixture();

      registerLabelMotionTarget(motionMap, timeline, 'area-a', 0, { x: 0, y: 20 }, 1000);
      const active = registerLabelMotionTarget(
        motionMap,
        timeline,
        'area-a',
        1,
        { x: 0, y: -40 },
        1100,
        true // prefersReducedMotion
      );

      expect(active).toBe(false);
      expect(timeline.activeAreaIds.has('area-a')).toBe(false);
      const state = motionMap.get('area-a')!;
      expect(state.currentOffset).toEqual({ x: 0, y: -40 });
    });
  });

  describe('stepSynchronizedMotion', () => {
    it('advances multiple moving labels simultaneously on the exact same timeline', () => {
      const motionMap = new Map<string, AreaMotionState>();
      const timeline: SynchronizedMotionTimeline = {
        startTime: 1000,
        durationMs: 200,
        activeAreaIds: new Set<string>(['area-a', 'area-b']),
      };

      motionMap.set('area-a', {
        areaId: 'area-a',
        currentOffset: { x: 0, y: 0 },
        startOffset: { x: 0, y: 0 },
        targetOffset: { x: 100, y: 0 },
        candidateIndex: 1,
      });

      motionMap.set('area-b', {
        areaId: 'area-b',
        currentOffset: { x: 0, y: 50 },
        startOffset: { x: 0, y: 50 },
        targetOffset: { x: 0, y: -50 },
        candidateIndex: 2,
      });

      // Advance by 100ms
      const isStillActive = stepSynchronizedMotion(motionMap, timeline, 1100);
      expect(isStillActive).toBe(true);

      const stateA = motionMap.get('area-a')!;
      const stateB = motionMap.get('area-b')!;

      // Both labels advance symmetrically along the critically-damped spring
      const normA = stateA.currentOffset.x / 100;
      const normB = (50 - stateB.currentOffset.y) / 100;
      expect(normA).toBeGreaterThan(0.7);
      expect(normA).toBeLessThan(1.0);
      expect(normA).toBeCloseTo(normB, 4);

      // Advance to completion (t=1300)
      const isDone = stepSynchronizedMotion(motionMap, timeline, 1300);
      expect(isDone).toBe(false);
      expect(timeline.activeAreaIds.size).toBe(0);
      expect(stateA.currentOffset).toEqual({ x: 100, y: 0 });
      expect(stateB.currentOffset).toEqual({ x: 0, y: -50 });
    });

    it('returns false immediately when no labels are transitioning (zero idle CPU)', () => {
      const motionMap = new Map<string, AreaMotionState>();
      const timeline: SynchronizedMotionTimeline = {
        startTime: 0,
        durationMs: 200,
        activeAreaIds: new Set<string>(),
      };

      expect(stepSynchronizedMotion(motionMap, timeline, 1500)).toBe(false);
    });

    it('instantly resolves all active labels if reduced motion becomes active', () => {
      const motionMap = new Map<string, AreaMotionState>();
      const timeline: SynchronizedMotionTimeline = {
        startTime: 1000,
        durationMs: 200,
        activeAreaIds: new Set<string>(['area-a']),
      };

      motionMap.set('area-a', {
        areaId: 'area-a',
        currentOffset: { x: 0, y: 0 },
        startOffset: { x: 0, y: 0 },
        targetOffset: { x: 100, y: 0 },
        candidateIndex: 1,
      });

      const isStillActive = stepSynchronizedMotion(motionMap, timeline, 1050, true);
      expect(isStillActive).toBe(false);
      expect(timeline.activeAreaIds.size).toBe(0);
      expect(motionMap.get('area-a')!.currentOffset).toEqual({ x: 100, y: 0 });
    });

    it('suppresses micro-jitter transitions when candidate is unchanged and delta <= 1.0px', () => {
      const motionMap = new Map<string, AreaMotionState>();
      const timeline: SynchronizedMotionTimeline = {
        startTime: 1000,
        durationMs: 200,
        activeAreaIds: new Set<string>(),
      };

      // Initialize at (10, 20) with candidate 0
      registerLabelMotionTarget(motionMap, timeline, 'area-a', 0, { x: 10, y: 20 }, 1000);

      // Camera micro-rotates slightly: new offset shifts by 0.5px
      const active = registerLabelMotionTarget(
        motionMap,
        timeline,
        'area-a',
        0,
        { x: 10.3, y: 20.4 }, // hypot(0.3, 0.4) = 0.5 <= 1.0
        1050
      );

      // Must NOT initiate an animation transition for sub-pixel jitter
      expect(active).toBe(false);
      expect(timeline.activeAreaIds.has('area-a')).toBe(false);
      expect(timeline.startTime).toBe(1000); // Timeline was not reset
    });

    it('prevents backward snapping when a new label joins an already-moving batch at a later timestamp', () => {
      const motionMap = new Map<string, AreaMotionState>();
      const timeline: SynchronizedMotionTimeline = {
        startTime: 1000,
        durationMs: 200,
        activeAreaIds: new Set<string>(),
      };

      // 1. Label A begins moving at t=1000 from (0, 0) to (100, 0)
      registerLabelMotionTarget(motionMap, timeline, 'area-a', 0, { x: 0, y: 0 }, 1000);
      registerLabelMotionTarget(motionMap, timeline, 'area-a', 1, { x: 100, y: 0 }, 1000);

      // 2. Advance to t=1100
      stepSynchronizedMotion(motionMap, timeline, 1100);
      const stateA = motionMap.get('area-a')!;
      const xAt1100 = stateA.currentOffset.x;
      expect(xAt1100).toBeGreaterThan(70);
      expect(xAt1100).toBeLessThan(100);

      // 3. At t=1100, Label B joins the active motion timeline (targeting 0, 100)
      registerLabelMotionTarget(motionMap, timeline, 'area-b', 0, { x: 0, y: 0 }, 1100);
      registerLabelMotionTarget(motionMap, timeline, 'area-b', 1, { x: 0, y: 100 }, 1100);

      // Verification: Label A's currentOffset and velocity are preserved with zero backward snap
      expect(stateA.currentOffset.x).toBeCloseTo(xAt1100, 3);
      expect(timeline.startTime).toBe(1100);

      // 4. Advance to t=1150
      stepSynchronizedMotion(motionMap, timeline, 1150);

      // Label A MUST continue moving forward towards 100 without snapping backward
      expect(stateA.currentOffset.x).toBeGreaterThan(xAt1100);
      expect(stateA.currentOffset.x).toBeLessThanOrEqual(100);

      // 5. Advance to completion (t=1380)
      const isStillActive = stepSynchronizedMotion(motionMap, timeline, 1200);
      stepSynchronizedMotion(motionMap, timeline, 1280);
      const settled = stepSynchronizedMotion(motionMap, timeline, 1360);
      expect(isStillActive).toBe(true);
      expect(settled).toBe(false);
      expect(stateA.currentOffset.x).toBe(100);
      expect(motionMap.get('area-b')!.currentOffset.y).toBe(100);
    });

    it('maintains continuous position trajectory across rapid multi-hop retargeting', () => {
      const motionMap = new Map<string, AreaMotionState>();
      const timeline: SynchronizedMotionTimeline = {
        startTime: 1000,
        durationMs: 200,
        activeAreaIds: new Set<string>(),
      };

      // Hop 0: start at (0, 0)
      registerLabelMotionTarget(motionMap, timeline, 'area-a', 0, { x: 0, y: 0 }, 1000, false, 200);

      // Hop 1: target (100, 0) at t=1000
      registerLabelMotionTarget(motionMap, timeline, 'area-a', 1, { x: 100, y: 0 }, 1000, false, 200);
      stepSynchronizedMotion(motionMap, timeline, 1050); // halfway in
      const pos1 = motionMap.get('area-a')!.currentOffset.x;
      expect(pos1).toBeGreaterThan(0);

      // Hop 2: retarget to (0, 100) at t=1050
      registerLabelMotionTarget(motionMap, timeline, 'area-a', 2, { x: 0, y: 100 }, 1050, false, 200);
      expect(motionMap.get('area-a')!.startOffset.x).toBe(pos1);
      stepSynchronizedMotion(motionMap, timeline, 1100);
      const pos2 = { ...motionMap.get('area-a')!.currentOffset };

      // Hop 3: retarget to (-50, -50) at t=1100
      registerLabelMotionTarget(motionMap, timeline, 'area-a', 3, { x: -50, y: -50 }, 1100, false, 200);
      expect(motionMap.get('area-a')!.startOffset.x).toBe(pos2.x);
      expect(motionMap.get('area-a')!.startOffset.y).toBe(pos2.y);

      // Complete (step in 50ms increments to settle)
      stepSynchronizedMotion(motionMap, timeline, 1180);
      stepSynchronizedMotion(motionMap, timeline, 1260);
      stepSynchronizedMotion(motionMap, timeline, 1340);
      stepSynchronizedMotion(motionMap, timeline, 1420);
      expect(motionMap.get('area-a')!.currentOffset).toEqual({ x: -50, y: -50 });
    });

    it('immediately arrives at target when durationMs is 0', () => {
      const motionMap = new Map<string, AreaMotionState>();
      const timeline: SynchronizedMotionTimeline = {
        startTime: 1000,
        durationMs: 0,
        activeAreaIds: new Set<string>(['area-a']),
      };

      motionMap.set('area-a', {
        areaId: 'area-a',
        currentOffset: { x: 0, y: 0 },
        startOffset: { x: 0, y: 0 },
        targetOffset: { x: 80, y: -40 },
        candidateIndex: 1,
      });

      const isStillActive = stepSynchronizedMotion(motionMap, timeline, 1000);
      expect(isStillActive).toBe(false);
      expect(motionMap.get('area-a')!.currentOffset).toEqual({ x: 80, y: -40 });
    });

    it('clamps backward timestamp anomalies without negative progress', () => {
      const motionMap = new Map<string, AreaMotionState>();
      const timeline: SynchronizedMotionTimeline = {
        startTime: 2000,
        durationMs: 200,
        activeAreaIds: new Set<string>(['area-a']),
      };

      motionMap.set('area-a', {
        areaId: 'area-a',
        currentOffset: { x: 0, y: 0 },
        startOffset: { x: 0, y: 0 },
        targetOffset: { x: 100, y: 0 },
        candidateIndex: 1,
      });

      // Timestamp moves backward to t=1900
      const isStillActive = stepSynchronizedMotion(motionMap, timeline, 1900);
      expect(isStillActive).toBe(true);
      expect(motionMap.get('area-a')!.currentOffset.x).toBe(0); // Progress is clamped to 0, not negative
    });

    it('computes rendered rect with negative or offscreen anchor coordinates without distortion', () => {
      const anchorX = -150;
      const anchorY = -80;
      const offset = { x: -30, y: 25 };
      const boxWidth = 100;
      const boxHeight = 32;

      const rect = computeRenderedLabelRect(anchorX, anchorY, offset, boxWidth, boxHeight);
      expect(rect).toEqual({
        x1: -180,
        y1: -55,
        x2: -80,
        y2: -23,
      });
    });
  });
});
