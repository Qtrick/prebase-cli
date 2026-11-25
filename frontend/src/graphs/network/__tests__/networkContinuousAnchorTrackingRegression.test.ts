import { describe, it, expect } from 'vitest';
import {
  registerLabelMotionTarget,
  stepSynchronizedMotion,
  computeRenderedLabelRect,
  computeAnchorRelativeOffset,
  AreaMotionState,
  SynchronizedMotionTimeline,
  DEFAULT_MOTION_DURATION_MS,
} from '../layout/labelMotion';
import {
  generateLabelCandidates,
  resolveAreaLabelPlacement,
  LabelPlacementAnchor,
} from '../layout/labelPlacement';
import { LabelCollisionGrid } from '../render/networkRenderMath';

describe('Continuous Anchor-Tracking Labels & Micro-Movement Stability Regression Suite', () => {
  function createMotionFixture() {
    const motionMap = new Map<string, AreaMotionState>();
    const timeline: SynchronizedMotionTimeline = {
      startTime: 0,
      durationMs: DEFAULT_MOTION_DURATION_MS,
      activeAreaIds: new Set<string>(),
    };
    return { motionMap, timeline };
  }

  describe('13.1 One-Pixel Pan Invariant', () => {
    it('produces exactly one-pixel label movement when anchor moves 1px under stable placement', () => {
      const { motionMap, timeline } = createMotionFixture();
      const initialAnchor = { screenX: 400, screenY: 300, radius: 18 };
      const boxWidth = 120;
      const boxHeight = 32;

      // 1. Initial resolution and registration
      const candidates0 = generateLabelCandidates(initialAnchor as LabelPlacementAnchor, boxWidth, boxHeight);
      const offset0 = computeAnchorRelativeOffset(initialAnchor.screenX, initialAnchor.screenY, candidates0[0].rect);
      registerLabelMotionTarget(motionMap, timeline, 'area-core', 0, offset0, 1000);

      const rect0 = computeRenderedLabelRect(
        initialAnchor.screenX,
        initialAnchor.screenY,
        motionMap.get('area-core')!.currentOffset,
        boxWidth,
        boxHeight
      );

      // 2. Camera pans by panX += 1 (anchor moves from 400 to 401)
      const pannedAnchor = { screenX: 401, screenY: 300, radius: 18 };
      const candidates1 = generateLabelCandidates(pannedAnchor as LabelPlacementAnchor, boxWidth, boxHeight);
      const offset1 = computeAnchorRelativeOffset(pannedAnchor.screenX, pannedAnchor.screenY, candidates1[0].rect);

      // Register updated target: candidate index is unchanged (0)
      const isRelocating = registerLabelMotionTarget(motionMap, timeline, 'area-core', 0, offset1, 1016);

      // Invariant: no independent relocation animation should be started merely because the anchor moved
      expect(isRelocating).toBe(false);
      expect(timeline.activeAreaIds.has('area-core')).toBe(false);

      const rect1 = computeRenderedLabelRect(
        pannedAnchor.screenX,
        pannedAnchor.screenY,
        motionMap.get('area-core')!.currentOffset,
        boxWidth,
        boxHeight
      );

      // Invariant: labelDeltaX ≈ anchorDeltaX = 1px
      expect(rect1.x1 - rect0.x1).toBe(1);
      expect(rect1.y1 - rect0.y1).toBe(0);
      expect(rect1.x2 - rect0.x2).toBe(1);
      expect(rect1.y2 - rect0.y2).toBe(0);
    });
  });

  describe('13.2 Five-Pixel Drag Test', () => {
    it('follows continuous incremental drag across sequential frames with zero relocation delay', () => {
      const { motionMap, timeline } = createMotionFixture();
      const boxWidth = 120;
      const boxHeight = 32;

      // Anchor starts at 400, 300
      let currentAnchor = { screenX: 400, screenY: 300, radius: 18 };
      const c0 = generateLabelCandidates(currentAnchor as LabelPlacementAnchor, boxWidth, boxHeight);
      const off0 = computeAnchorRelativeOffset(currentAnchor.screenX, currentAnchor.screenY, c0[0].rect);
      registerLabelMotionTarget(motionMap, timeline, 'area-core', 0, off0, 1000);

      let prevRect = computeRenderedLabelRect(
        currentAnchor.screenX,
        currentAnchor.screenY,
        motionMap.get('area-core')!.currentOffset,
        boxWidth,
        boxHeight
      );

      // Simulate 5 consecutive drag frames: 1px, 2px, 3px, 4px, 5px displacement
      const displacements = [
        { dx: 1, dy: 0 },
        { dx: 1, dy: 1 },
        { dx: 1, dy: -1 },
        { dx: 1, dy: 0 },
        { dx: 1, dy: 0 },
      ];

      for (let i = 0; i < displacements.length; i++) {
        const d = displacements[i];
        currentAnchor = {
          screenX: currentAnchor.screenX + d.dx,
          screenY: currentAnchor.screenY + d.dy,
          radius: 18,
        };

        const c = generateLabelCandidates(currentAnchor as LabelPlacementAnchor, boxWidth, boxHeight);
        const off = computeAnchorRelativeOffset(currentAnchor.screenX, currentAnchor.screenY, c[0].rect);
        const active = registerLabelMotionTarget(motionMap, timeline, 'area-core', 0, off, 1016 + i * 16);

        expect(active).toBe(false);
        expect(timeline.activeAreaIds.has('area-core')).toBe(false);

        const currentRect = computeRenderedLabelRect(
          currentAnchor.screenX,
          currentAnchor.screenY,
          motionMap.get('area-core')!.currentOffset,
          boxWidth,
          boxHeight
        );

        // Frame displacement must match anchor displacement exactly
        expect(currentRect.x1 - prevRect.x1).toBe(d.dx);
        expect(currentRect.y1 - prevRect.y1).toBe(d.dy);
        prevRect = currentRect;
      }
    });
  });

  describe('13.3 Repeated Micro-Movement Test (60 Consecutive Frames)', () => {
    it('simulates 60 consecutive frames of small graph movement with zero timeline resets and zero teleportation', () => {
      const { motionMap, timeline } = createMotionFixture();
      const boxWidth = 100;
      const boxHeight = 32;

      let anchor = { screenX: 500, screenY: 400, radius: 16 };
      const initialCandidates = generateLabelCandidates(anchor as LabelPlacementAnchor, boxWidth, boxHeight);
      const initialOffset = computeAnchorRelativeOffset(anchor.screenX, anchor.screenY, initialCandidates[0].rect);
      registerLabelMotionTarget(motionMap, timeline, 'area-sim', 0, initialOffset, 1000);

      let initialTimelineStart = timeline.startTime;
      let totalRelocationEvents = 0;

      for (let frame = 1; frame <= 60; frame++) {
        const timestamp = 1000 + frame * 16.6;
        // Small sinusoidal wobble simulating mouse/trackpad drag jitter
        const moveX = Math.sin(frame * 0.2) * 1.5;
        const moveY = Math.cos(frame * 0.2) * 1.2;
        anchor = {
          screenX: anchor.screenX + moveX,
          screenY: anchor.screenY + moveY,
          radius: 16 + Math.sin(frame * 0.1) * 0.5, // slight radius variation
        };

        const candidates = generateLabelCandidates(anchor as LabelPlacementAnchor, boxWidth, boxHeight);
        const targetOffset = computeAnchorRelativeOffset(anchor.screenX, anchor.screenY, candidates[0].rect);

        const isRelocating = registerLabelMotionTarget(
          motionMap,
          timeline,
          'area-sim',
          0,
          targetOffset,
          timestamp
        );

        if (isRelocating) {
          totalRelocationEvents++;
        }

        // Rendered position must track anchor immediately
        const rect = computeRenderedLabelRect(
          anchor.screenX,
          anchor.screenY,
          motionMap.get('area-sim')!.currentOffset,
          boxWidth,
          boxHeight
        );

        // Bounding box must be physically centered below anchor within floating point tolerance
        const expectedX1 = anchor.screenX - boxWidth / 2;
        const expectedY1 = anchor.screenY + anchor.radius + 4;
        expect(rect.x1).toBeCloseTo(expectedX1, 5);
        expect(rect.y1).toBeCloseTo(expectedY1, 5);
      }

      // Zero unnecessary relocation transitions triggered across all 60 frames!
      expect(totalRelocationEvents).toBe(0);
      expect(timeline.activeAreaIds.size).toBe(0);
      expect(timeline.startTime).toBe(initialTimelineStart);
    });
  });

  describe('13.4 Perspective Anchor Radius Changes', () => {
    it('smoothly updates local geometry directly when anchor radius changes without restarting layout animations', () => {
      const { motionMap, timeline } = createMotionFixture();
      const boxWidth = 110;
      const boxHeight = 32;

      // Start with anchor at radius 14
      let anchor = { screenX: 400, screenY: 300, radius: 14 };
      let c = generateLabelCandidates(anchor as LabelPlacementAnchor, boxWidth, boxHeight);
      let off = computeAnchorRelativeOffset(anchor.screenX, anchor.screenY, c[0].rect);
      registerLabelMotionTarget(motionMap, timeline, 'area-zoom', 0, off, 1000);

      const rectBefore = computeRenderedLabelRect(
        anchor.screenX,
        anchor.screenY,
        motionMap.get('area-zoom')!.currentOffset,
        boxWidth,
        boxHeight
      );

      // Camera zooms in slightly: anchor radius expands from 14 to 18
      anchor = { screenX: 400, screenY: 300, radius: 18 };
      c = generateLabelCandidates(anchor as LabelPlacementAnchor, boxWidth, boxHeight);
      off = computeAnchorRelativeOffset(anchor.screenX, anchor.screenY, c[0].rect);

      const active = registerLabelMotionTarget(motionMap, timeline, 'area-zoom', 0, off, 1016);

      // Must not initiate a 220ms relocation timeline
      expect(active).toBe(false);
      expect(timeline.activeAreaIds.has('area-zoom')).toBe(false);

      const rectAfter = computeRenderedLabelRect(
        anchor.screenX,
        anchor.screenY,
        motionMap.get('area-zoom')!.currentOffset,
        boxWidth,
        boxHeight
      );

      // Top edge shifted downward by exactly 4px (the difference in radius: 18 - 14)
      expect(rectAfter.y1 - rectBefore.y1).toBe(4);
      expect(rectAfter.x1).toBe(rectBefore.x1);
    });
  });

  describe('13.5 Genuine Collision Relocation & Synchronization', () => {
    it('initiates smooth synchronized transition when candidate changes due to genuine collision', () => {
      const { motionMap, timeline } = createMotionFixture();

      // Initialize at candidate 0 (below: y = +22)
      registerLabelMotionTarget(motionMap, timeline, 'area-col', 0, { x: -60, y: 22 }, 1000);

      // Collision forces candidate to switch to candidate 1 (above: y = -58)
      const active = registerLabelMotionTarget(
        motionMap,
        timeline,
        'area-col',
        1,
        { x: -60, y: -58 },
        1100,
        false,
        200
      );

      expect(active).toBe(true);
      expect(timeline.activeAreaIds.has('area-col')).toBe(true);
      expect(timeline.startTime).toBe(1100);

      const state = motionMap.get('area-col')!;
      expect(state.startOffset).toEqual({ x: -60, y: 22 });
      expect(state.targetOffset).toEqual({ x: -60, y: -58 });
      expect(state.candidateIndex).toBe(1);
      expect(state.isRelocating).toBe(true);

      // Step halfway (t = 1200, 100ms elapsed)
      const stillActive = stepSynchronizedMotion(motionMap, timeline, 1200);
      expect(stillActive).toBe(true);
      expect(state.currentOffset.y).toBeLessThan(-35);
      expect(state.currentOffset.y).toBeGreaterThan(-58);

      // Complete arrival (step through settling)
      stepSynchronizedMotion(motionMap, timeline, 1280);
      const completed = stepSynchronizedMotion(motionMap, timeline, 1360);
      expect(completed).toBe(false);
      expect(timeline.activeAreaIds.size).toBe(0);
      expect(state.currentOffset).toEqual({ x: -60, y: -58 });
      expect(state.isRelocating).toBe(false);
    });

    it('coordinates multiple labels relocating simultaneously in the same update frame', () => {
      const { motionMap, timeline } = createMotionFixture();

      // Initialize 2 areas
      registerLabelMotionTarget(motionMap, timeline, 'area-1', 0, { x: -50, y: 20 }, 1000);
      registerLabelMotionTarget(motionMap, timeline, 'area-2', 0, { x: -50, y: 20 }, 1000);

      // At t=1050, both switch candidates in the same frame
      const a1 = registerLabelMotionTarget(motionMap, timeline, 'area-1', 1, { x: -50, y: -50 }, 1050, false, 200);
      const a2 = registerLabelMotionTarget(motionMap, timeline, 'area-2', 2, { x: 30, y: 0 }, 1050, false, 200);

      expect(a1).toBe(true);
      expect(a2).toBe(true);
      expect(timeline.activeAreaIds.size).toBe(2);
      expect(timeline.startTime).toBe(1050);

      // Advance by 100ms
      stepSynchronizedMotion(motionMap, timeline, 1150);
      const s1 = motionMap.get('area-1')!;
      const s2 = motionMap.get('area-2')!;

      // Both must have progressed symmetrically along the spring curve
      const norm1 = (s1.currentOffset.y - 20) / -70;
      const norm2 = (s2.currentOffset.x - -50) / 80;
      expect(norm1).toBeGreaterThan(0.7);
      expect(norm1).toBeLessThan(1.0);
      expect(norm1).toBeCloseTo(norm2, 4);
    });
  });

  describe('13.6 Unrelated-Update Isolation & Anti-Starvation', () => {
    it('does not reset an already-relocating label when an unrelated label joins at a later frame', () => {
      const { motionMap, timeline } = createMotionFixture();

      // Label A starts relocating at t=1000 towards (100, 0)
      registerLabelMotionTarget(motionMap, timeline, 'area-a', 0, { x: 0, y: 0 }, 1000, false, 200);
      registerLabelMotionTarget(motionMap, timeline, 'area-a', 1, { x: 100, y: 0 }, 1000, false, 200);

      // Advance to t=1100
      stepSynchronizedMotion(motionMap, timeline, 1100);
      const stateA = motionMap.get('area-a')!;
      const xAt1100 = stateA.currentOffset.x;
      expect(xAt1100).toBeGreaterThan(70);
      expect(xAt1100).toBeLessThan(100);

      // At t=1100, Label B starts relocating
      registerLabelMotionTarget(motionMap, timeline, 'area-b', 0, { x: 0, y: 0 }, 1100, false, 200);
      registerLabelMotionTarget(motionMap, timeline, 'area-b', 1, { x: 0, y: 100 }, 1100, false, 200);

      // Advance to t=1150
      stepSynchronizedMotion(motionMap, timeline, 1150);

      // Label A must continue forward towards 100, not jump backward to 0
      expect(stateA.currentOffset.x).toBeGreaterThan(xAt1100);
      expect(stateA.currentOffset.x).toBeLessThanOrEqual(100);

      // Step to completion
      stepSynchronizedMotion(motionMap, timeline, 1230);
      stepSynchronizedMotion(motionMap, timeline, 1310);
      stepSynchronizedMotion(motionMap, timeline, 1390);
      expect(stateA.currentOffset.x).toBe(100);
      expect(motionMap.get('area-b')!.currentOffset.y).toBe(100);
    });

    it('prevents animation starvation during continuous retargeting within the same candidate', () => {
      const { motionMap, timeline } = createMotionFixture();

      // Label begins relocating at t=1000 from 0 to 100
      registerLabelMotionTarget(motionMap, timeline, 'area-starve', 0, { x: 0, y: 0 }, 1000, false, 200);
      registerLabelMotionTarget(motionMap, timeline, 'area-starve', 1, { x: 100, y: 0 }, 1000, false, 200);

      // Simulate dragging during the relocation: every frame (16ms) the target adjusts slightly (radius change)
      for (let frame = 1; frame <= 10; frame++) {
        const now = 1000 + frame * 16;
        stepSynchronizedMotion(motionMap, timeline, now);
        // Slightly adjusted target within candidate 1
        registerLabelMotionTarget(motionMap, timeline, 'area-starve', 1, { x: 100 + frame * 0.5, y: 0 }, now);
      }

      // At t=1340 (after the last target update at t=1160), transition must successfully converge to destination
      stepSynchronizedMotion(motionMap, timeline, 1340);
      const state = motionMap.get('area-starve')!;
      expect(state.currentOffset.x).toBeCloseTo(105, 1);
      expect(timeline.activeAreaIds.has('area-starve')).toBe(false);
      expect(state.isRelocating).toBe(false);
    });
  });

  describe('13.7 Hidden-Label Reentry Synchronization', () => {
    it('immediately synchronizes position on reentry from hidden state without ghost animations', () => {
      const { motionMap, timeline } = createMotionFixture();

      // Old state before fading out: was at Candidate 0 (y = 20)
      registerLabelMotionTarget(motionMap, timeline, 'area-reentry', 0, { x: 0, y: 20 }, 1000);

      // Label is hidden on rear hemisphere. Camera rotates 180 degrees.
      // On reentry, placement resolver chooses Candidate 1 (above: y = -45)
      // When isReentry is true, it must snap immediately to current target with zero transition
      const active = registerLabelMotionTarget(
        motionMap,
        timeline,
        'area-reentry',
        1,
        { x: 0, y: -45 },
        2000,
        false,
        220,
        true // isReentry = true
      );

      expect(active).toBe(false);
      expect(timeline.activeAreaIds.has('area-reentry')).toBe(false);
      const state = motionMap.get('area-reentry')!;
      expect(state.currentOffset).toEqual({ x: 0, y: -45 });
      expect(state.startOffset).toEqual({ x: 0, y: -45 });
      expect(state.targetOffset).toEqual({ x: 0, y: -45 });
      expect(state.candidateIndex).toBe(1);
      expect(state.isRelocating).toBe(false);
    });
  });

  describe('13.8 Frame-Rate Independence & Reduced Motion', () => {
    it('converges identically across 60Hz, 120Hz, and 144Hz animation step timestamps', () => {
      const stepRates = [
        { name: '60Hz', dt: 16.666 },
        { name: '120Hz', dt: 8.333 },
        { name: '144Hz', dt: 6.944 },
      ];

      for (const rate of stepRates) {
        const { motionMap, timeline } = createMotionFixture();
        registerLabelMotionTarget(motionMap, timeline, 'area-rate', 0, { x: 0, y: 0 }, 1000, false, 200);
        registerLabelMotionTarget(motionMap, timeline, 'area-rate', 1, { x: 100, y: 50 }, 1000, false, 200);

        let t = 1000;
        while (t < 1350) {
          t += rate.dt;
          stepSynchronizedMotion(motionMap, timeline, t);
        }

        const finalState = motionMap.get('area-rate')!;
        expect(finalState.currentOffset.x, `Failed on ${rate.name}`).toBe(100);
        expect(finalState.currentOffset.y, `Failed on ${rate.name}`).toBe(50);
        expect(timeline.activeAreaIds.has('area-rate')).toBe(false);
      }
    });

    it('respects prefers-reduced-motion by snapping relocations immediately while preserving tracking', () => {
      const { motionMap, timeline } = createMotionFixture();

      registerLabelMotionTarget(motionMap, timeline, 'area-rm', 0, { x: 0, y: 20 }, 1000, true);
      // Candidate switch under reduced motion
      const active = registerLabelMotionTarget(
        motionMap,
        timeline,
        'area-rm',
        1,
        { x: 0, y: -40 },
        1050,
        true // prefersReducedMotion
      );

      expect(active).toBe(false);
      expect(timeline.activeAreaIds.size).toBe(0);
      const state = motionMap.get('area-rm')!;
      expect(state.currentOffset).toEqual({ x: 0, y: -40 });
      expect(state.isRelocating).toBe(false);

      // Direct anchor tracking under reduced motion: 1px pan still moves label 1px!
      const rectBefore = computeRenderedLabelRect(400, 300, state.currentOffset, 100, 32);
      const rectAfter = computeRenderedLabelRect(401, 300, state.currentOffset, 100, 32);
      expect(rectAfter.x1 - rectBefore.x1).toBe(1);
    });

    it('preserves C1 position and velocity continuity during mid-flight direction reversals', () => {
      const { motionMap, timeline } = createMotionFixture();

      // Start at candidate 0 (below: y = +22)
      registerLabelMotionTarget(motionMap, timeline, 'area-rev', 0, { x: -60, y: 22 }, 1000);

      // Switch to candidate 1 (above: y = -58)
      registerLabelMotionTarget(motionMap, timeline, 'area-rev', 1, { x: -60, y: -58 }, 1000);
      stepSynchronizedMotion(motionMap, timeline, 1040);

      const state = motionMap.get('area-rev')!;
      const yBeforeReversal = state.currentOffset.y;
      const vyBeforeReversal = state.velocity!.y;
      expect(vyBeforeReversal).toBeLessThan(0); // Moving upward

      // Camera reverses direction! Switch back to candidate 0 (below: y = +22) mid-flight
      registerLabelMotionTarget(motionMap, timeline, 'area-rev', 0, { x: -60, y: 22 }, 1040);

      // Position and velocity must be preserved immediately upon retargeting (zero teleport)
      expect(state.currentOffset.y).toBe(yBeforeReversal);
      expect(state.velocity!.y).toBe(vyBeforeReversal);

      // Step 16ms: spring decelerates upward velocity smoothly before turning downward
      stepSynchronizedMotion(motionMap, timeline, 1056);
      expect(Math.abs(state.currentOffset.y - yBeforeReversal)).toBeLessThan(20);

      // Step to settle at candidate 0
      for (let t = 1072; t <= 1400; t += 16) {
        stepSynchronizedMotion(motionMap, timeline, t);
      }
      expect(state.currentOffset).toEqual({ x: -60, y: 22 });
      expect(state.isRelocating).toBe(false);
    });

    it('adjusts relative offset smoothly DURING active camera drag/inertia when hard constraint triggers (never defers until release)', () => {
      const { motionMap, timeline } = createMotionFixture();
      const boxWidth = 120;
      const boxHeight = 32;
      const viewportW = 800;
      const viewportH = 600;

      // Simulate an anchor moving downward during active camera drag + inertia (no mouseup yet)
      let anchor: LabelPlacementAnchor = {
        id: 'area-active-drag',
        screenX: 400,
        screenY: 510,
        radius: 18,
      };

      const emptyObstacles = new LabelCollisionGrid(80);
      const placedLabels = new LabelCollisionGrid(80);
      let lastSwitchTime = 0;

      // Frame 0: inside viewport, selects candidate 0 ('below': yOffset = +22)
      const res0 = resolveAreaLabelPlacement(
        anchor,
        boxWidth,
        boxHeight,
        emptyObstacles,
        viewportW,
        viewportH,
        undefined,
        undefined,
        placedLabels,
        { now: 1000, lastSwitchTime }
      );
      expect(res0.candidateIndex).toBe(0);
      const off0 = computeAnchorRelativeOffset(anchor.screenX, anchor.screenY, res0.rect);
      registerLabelMotionTarget(motionMap, timeline, 'area-active-drag', res0.candidateIndex, off0, 1000);

      let switchedFrame = -1;
      let prevCandidate = res0.candidateIndex;
      const observedMidDragOffsets: number[] = [];

      // Frames 1..30: continuous camera drag/inertia moves anchor downward by 3px/frame toward bottom edge (y=600)
      for (let frame = 1; frame <= 30; frame++) {
        const now = 1000 + frame * 16;
        anchor = { ...anchor, screenY: anchor.screenY + 3 };

        const res = resolveAreaLabelPlacement(
          anchor,
          boxWidth,
          boxHeight,
          emptyObstacles,
          viewportW,
          viewportH,
          undefined,
          prevCandidate,
          placedLabels,
          { now, lastSwitchTime }
        );

        if (res.candidateIndex !== prevCandidate) {
          switchedFrame = frame;
          lastSwitchTime = now;
          prevCandidate = res.candidateIndex;
        }

        const targetOffset = computeAnchorRelativeOffset(anchor.screenX, anchor.screenY, res.rect);
        registerLabelMotionTarget(
          motionMap,
          timeline,
          'area-active-drag',
          res.candidateIndex,
          targetOffset,
          now
        );
        stepSynchronizedMotion(motionMap, timeline, now);

        const state = motionMap.get('area-active-drag')!;
        if (switchedFrame !== -1 && frame >= switchedFrame && frame <= switchedFrame + 4) {
          observedMidDragOffsets.push(state.currentOffset.y);
        }
      }

      // Must have switched to 'above' (candidate 1) DURING active motion before hitting bottom edge
      expect(switchedFrame).toBeGreaterThan(0);
      expect(switchedFrame).toBeLessThan(15);
      expect(prevCandidate).toBe(1);

      // Relative offset must have smoothly adjusted upward across consecutive active-drag frames (not frozen!)
      expect(observedMidDragOffsets.length).toBeGreaterThanOrEqual(4);
      expect(observedMidDragOffsets[observedMidDragOffsets.length - 1]).toBeLessThan(observedMidDragOffsets[0]);

      // After enough frames, spring settles cleanly even while anchor keeps tracking
      const finalState = motionMap.get('area-active-drag')!;
      expect(finalState.currentOffset.y).toBeCloseTo(-(anchor.radius + 4 + boxHeight), 1);
      expect(timeline.activeAreaIds.size).toBe(0);
    });
  });
});
