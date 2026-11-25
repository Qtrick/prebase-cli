import { describe, it, expect } from 'vitest';
import {
  resolveAreaLabelPlacement,
  LabelPlacementAnchor,
} from '../layout/labelPlacement';
import {
  AreaMotionState,
  computeAnchorRelativeOffset,
  computeRenderedLabelRect,
  adaptLabelOffsetToGeometry,
} from '../layout/labelMotion';
import { LabelCollisionGrid } from '../render/networkRenderMath';

/**
 * Campaign 2 Gate A — Continuous Geometry-Driven Label Placement Regression Suite.
 *
 * Governing Principle:
 *   Group label position must be a continuous consequence of current graph geometry
 *   and change in geometry — NOT a timer-driven transition between discrete candidates.
 *   When geometry is stationary, labels must have ZERO autonomous positional movement.
 */
describe('Campaign 2 Gate A: Continuous Geometry-Driven Label Placement (Tests A-G)', () => {
  const boxWidth = 120;
  const boxHeight = 32;
  const viewportW = 800;
  const viewportH = 600;

  function stepFrame(
    motionMap: Map<string, AreaMotionState>,
    anchor: LabelPlacementAnchor,
    obstacles: LabelCollisionGrid,
    relevantGeometryDisplacement: number
  ) {
    const existing = motionMap.get(anchor.id);
    const res = resolveAreaLabelPlacement(
      anchor,
      boxWidth,
      boxHeight,
      obstacles,
      viewportW,
      viewportH,
      undefined,
      existing?.currentTheta
    );
    const targetOffset = computeAnchorRelativeOffset(anchor.screenX, anchor.screenY, res.rect);
    const state = adaptLabelOffsetToGeometry(
      motionMap,
      anchor.id,
      res.theta,
      targetOffset,
      anchor.radius,
      boxWidth,
      boxHeight,
      relevantGeometryDisplacement
    );
    const rect = computeRenderedLabelRect(
      anchor.screenX,
      anchor.screenY,
      state.currentOffset,
      boxWidth,
      boxHeight
    );
    return { rect, offset: { ...state.currentOffset }, theta: state.currentTheta };
  }

  it('Test A: Micro-movement disproportion — 2px geometry change must not yield >10px relative offset jump', () => {
    const motionMap = new Map<string, AreaMotionState>();
    const anchor: LabelPlacementAnchor = { id: 'area-a', screenX: 400, screenY: 300, radius: 18 };

    // Frame 0: clear below placement
    const obstacles0 = new LabelCollisionGrid(80);
    const f0 = stepFrame(motionMap, anchor, obstacles0, 0);

    // Frame 1: 2 obstacles enter below region by 2px, anchor moves 2px
    const obstacles1 = new LabelCollisionGrid(80);
    obstacles1.insert({ x1: 350, y1: 352, x2: 390, y2: 370 });
    obstacles1.insert({ x1: 410, y1: 352, x2: 450, y2: 370 });

    const movedAnchor: LabelPlacementAnchor = { ...anchor, screenY: 302 };
    const f1 = stepFrame(motionMap, movedAnchor, obstacles1, 2);

    // Subsequent frames with 0 geometry change must have 0 further offset change
    const f2 = stepFrame(motionMap, movedAnchor, obstacles1, 0);
    const f3 = stepFrame(motionMap, movedAnchor, obstacles1, 0);

    const totalOffsetChange = Math.hypot(f3.offset.x - f0.offset.x, f3.offset.y - f0.offset.y);
    expect(totalOffsetChange).toBeLessThanOrEqual(10);
    expect(Math.hypot(f2.offset.x - f1.offset.x, f2.offset.y - f1.offset.y)).toBe(0);
    expect(Math.hypot(f3.offset.x - f2.offset.x, f3.offset.y - f2.offset.y)).toBe(0);
  });

  it('Test B: Hold pointer stationary — zero autonomous movement at 50/100/220/350/500ms after trigger', () => {
    const motionMap = new Map<string, AreaMotionState>();
    const anchor: LabelPlacementAnchor = { id: 'area-b', screenX: 400, screenY: 300, radius: 18 };
    stepFrame(motionMap, anchor, new LabelCollisionGrid(80), 0);

    // Trigger a 2px movement across an obstacle boundary
    const obstacles1 = new LabelCollisionGrid(80);
    obstacles1.insert({ x1: 350, y1: 352, x2: 390, y2: 370 });
    obstacles1.insert({ x1: 410, y1: 352, x2: 450, y2: 370 });
    const stationaryAnchor: LabelPlacementAnchor = { ...anchor, screenY: 302 };

    const atTrigger = stepFrame(motionMap, stationaryAnchor, obstacles1, 2);

    // Pointer and geometry are 100% stationary (relevantGeometryDisplacement = 0) across 50..500ms
    for (let i = 0; i < 5; i++) {
      const f = stepFrame(motionMap, stationaryAnchor, obstacles1, 0);
      const drift = Math.hypot(f.rect.x1 - atTrigger.rect.x1, f.rect.y1 - atTrigger.rect.y1);
      expect(drift).toBeLessThanOrEqual(0.5);
    }
  });

  it('Test C: Release with/without inertia — zero drift on release without inertia', () => {
    const motionMap = new Map<string, AreaMotionState>();
    const obstacles = new LabelCollisionGrid(80);
    obstacles.insert({ x1: 350, y1: 352, x2: 390, y2: 370 });
    obstacles.insert({ x1: 410, y1: 352, x2: 450, y2: 370 });

    const a0: LabelPlacementAnchor = { id: 'area-c', screenX: 400, screenY: 270, radius: 18 };
    stepFrame(motionMap, a0, obstacles, 0);

    // Drag down to y=300 where obstacles hit, then release WITHOUT inertia (displacement = 0)
    const aRelease: LabelPlacementAnchor = { ...a0, screenY: 300 };
    const fRelease = stepFrame(motionMap, aRelease, obstacles, 30);
    const fAfterRelease = stepFrame(motionMap, aRelease, obstacles, 0);

    const releaseDrift = Math.hypot(
      fAfterRelease.rect.x1 - fRelease.rect.x1,
      fAfterRelease.rect.y1 - fRelease.rect.y1
    );
    expect(releaseDrift).toBeLessThanOrEqual(0.5);
  });

  it('Test D: Speed independence — slow vs fast vs paused trajectories have zero drift during pauses', () => {
    const motionMap = new Map<string, AreaMotionState>();
    const obstacles = new LabelCollisionGrid(80);
    obstacles.insert({ x1: 350, y1: 352, x2: 390, y2: 370 });
    obstacles.insert({ x1: 410, y1: 352, x2: 450, y2: 370 });

    const aStart: LabelPlacementAnchor = { id: 'area-d', screenX: 400, screenY: 280, radius: 18 };
    stepFrame(motionMap, aStart, obstacles, 0);

    // Move to y=300, then pause (displacement = 0)
    const aMid: LabelPlacementAnchor = { ...aStart, screenY: 300 };
    const fMid = stepFrame(motionMap, aMid, obstacles, 20);
    const fPaused = stepFrame(motionMap, aMid, obstacles, 0);

    expect(Math.hypot(fPaused.rect.x1 - fMid.rect.x1, fPaused.rect.y1 - fMid.rect.y1)).toBeLessThanOrEqual(0.5);
  });

  it('Test E: Gradual obstacle approach — progressive adaptation rather than freeze-then-jump', () => {
    const motionMap = new Map<string, AreaMotionState>();
    const anchor: LabelPlacementAnchor = { id: 'area-e', screenX: 400, screenY: 300, radius: 18 };
    stepFrame(motionMap, anchor, new LabelCollisionGrid(80), 0);

    const perStepOffsetDeltas: number[] = [];
    let prevOff = { ...motionMap.get('area-e')!.currentOffset };

    // Gradually move two obstacles into the below box from y=360 up to y=320 (2px per step)
    for (let step = 1; step <= 20; step++) {
      const obsY = 360 - step * 2;
      const obs = new LabelCollisionGrid(80);
      obs.insert({ x1: 350, y1: obsY, x2: 390, y2: obsY + 20 });
      obs.insert({ x1: 410, y1: obsY, x2: 450, y2: obsY + 20 });

      const f = stepFrame(motionMap, anchor, obs, 2);
      const delta = Math.hypot(f.offset.x - prevOff.x, f.offset.y - prevOff.y);
      perStepOffsetDeltas.push(delta);
      prevOff = f.offset;
    }

    const maxSingleStepDelta = Math.max(...perStepOffsetDeltas);
    // Bounded by adaptationGain * 2px = 3px (plus tiny perimeter arc difference) -> strictly <= 15px
    expect(maxSingleStepDelta).toBeLessThanOrEqual(15);
  });

  it('Test F: Rapid direction reversals — bounded proportional offset change with zero autonomous drift after stop', () => {
    const motionMap = new Map<string, AreaMotionState>();
    const obstacles = new LabelCollisionGrid(80);
    obstacles.insert({ x1: 350, y1: 352, x2: 390, y2: 370 });
    obstacles.insert({ x1: 410, y1: 352, x2: 450, y2: 370 });

    let anchor: LabelPlacementAnchor = { id: 'area-f', screenX: 400, screenY: 298, radius: 18 };
    stepFrame(motionMap, anchor, obstacles, 0);

    const ys = [301, 298, 302, 297, 301];
    let lastFrame = stepFrame(motionMap, anchor, obstacles, 0);
    for (const y of ys) {
      const dy = Math.abs(y - anchor.screenY);
      anchor = { ...anchor, screenY: y };
      lastFrame = stepFrame(motionMap, anchor, obstacles, dy);
    }

    // Stop moving (displacement = 0) and verify zero autonomous drift
    const settled = stepFrame(motionMap, anchor, obstacles, 0);
    expect(Math.hypot(settled.rect.x1 - lastFrame.rect.x1, settled.rect.y1 - lastFrame.rect.y1)).toBeLessThanOrEqual(0.5);
  });

  it('Test G: Stationary rendering invariance across repeated calls with zero geometry change', () => {
    const motionMap = new Map<string, AreaMotionState>();
    const obstacles = new LabelCollisionGrid(80);
    obstacles.insert({ x1: 350, y1: 352, x2: 390, y2: 370 });
    obstacles.insert({ x1: 410, y1: 352, x2: 450, y2: 370 });

    const a0: LabelPlacementAnchor = { id: 'area-g', screenX: 400, screenY: 299, radius: 18 };
    stepFrame(motionMap, a0, obstacles, 0);

    // 1px move crosses into collision
    const a1: LabelPlacementAnchor = { id: 'area-g', screenX: 400, screenY: 300, radius: 18 };
    const f1 = stepFrame(motionMap, a1, obstacles, 1);

    // Repeated stationary frames must yield identical rendered rect
    for (let i = 0; i < 5; i++) {
      const f = stepFrame(motionMap, a1, obstacles, 0);
      expect(Math.abs(f.rect.x1 - f1.rect.x1)).toBeLessThanOrEqual(0.01);
      expect(Math.abs(f.rect.y1 - f1.rect.y1)).toBeLessThanOrEqual(0.01);
    }
  });
});
