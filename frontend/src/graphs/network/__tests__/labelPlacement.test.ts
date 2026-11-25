import { describe, it, expect } from 'vitest';
import {
  computeSupportDistance,
  computeOffsetForAngle,
  classifyAnglePlacement,
  isRectInsideViewport,
  computeViewportEdgeMargin,
  resolveAreaLabelPlacement,
  DEFAULT_BELOW_THETA,
  LabelPlacementAnchor,
} from '../layout/labelPlacement';
import { LabelCollisionGrid } from '../render/networkRenderMath';

describe('Continuous Geometry-Driven Area Label Placement (labelPlacement.ts)', () => {
  const anchor: LabelPlacementAnchor = {
    id: 'area-core',
    screenX: 400,
    screenY: 300,
    radius: 18,
    isSelected: false,
    isHovered: false,
  };

  const boxWidth = 120;
  const boxHeight = 32;

  describe('Directional support perimeter', () => {
    it('places label cleanly below anchor at DEFAULT_BELOW_THETA without overlapping anchor badge', () => {
      const dist = computeSupportDistance(anchor.radius, 4, boxWidth / 2, boxHeight / 2, 0, 1);
      expect(dist).toBe(anchor.radius + 4 + boxHeight / 2);

      const offset = computeOffsetForAngle(DEFAULT_BELOW_THETA, anchor.radius, 4, boxWidth, boxHeight);
      expect(offset.x).toBeCloseTo(-boxWidth / 2, 5);
      expect(offset.y).toBeCloseTo(anchor.radius + 4, 5);
    });

    it('varies continuously around the entire 360-degree support perimeter', () => {
      const steps = 36;
      let prev = computeOffsetForAngle(-Math.PI, anchor.radius, 4, boxWidth, boxHeight);
      for (let i = 1; i <= steps; i++) {
        const theta = -Math.PI + (i / steps) * Math.PI * 2;
        const curr = computeOffsetForAngle(theta, anchor.radius, 4, boxWidth, boxHeight);
        const stepDist = Math.hypot(curr.x - prev.x, curr.y - prev.y);
        expect(stepDist).toBeLessThan(20);
        prev = curr;
      }
    });

    it('classifies angles to descriptive placement names', () => {
      expect(classifyAnglePlacement(Math.PI / 2)).toBe('below');
      expect(classifyAnglePlacement(-Math.PI / 2)).toBe('above');
      expect(classifyAnglePlacement(0)).toBe('right');
      expect(classifyAnglePlacement(Math.PI)).toBe('left');
    });
  });

  describe('isRectInsideViewport & computeViewportEdgeMargin', () => {
    const viewport = { width: 800, height: 600 };
    const insets = { left: 0, right: 80, top: 50, bottom: 0 };

    it('returns true when completely inside usable viewport', () => {
      const rect = { x1: 200, y1: 200, x2: 300, y2: 240 };
      expect(isRectInsideViewport(rect, viewport.width, viewport.height, insets)).toBe(true);
      expect(computeViewportEdgeMargin(rect, viewport.width, viewport.height, insets)).toBeGreaterThan(0);
    });

    it('returns false when extending past right or top inset', () => {
      expect(isRectInsideViewport({ x1: 700, y1: 200, x2: 730, y2: 240 }, viewport.width, viewport.height, insets)).toBe(false);
      expect(isRectInsideViewport({ x1: 200, y1: 40, x2: 300, y2: 80 }, viewport.width, viewport.height, insets)).toBe(false);
      expect(computeViewportEdgeMargin({ x1: 700, y1: 200, x2: 730, y2: 240 }, viewport.width, viewport.height, insets)).toBeLessThan(0);
    });
  });

  describe('resolveAreaLabelPlacement', () => {
    it('defaults to below placement when all directions are clear', () => {
      const grid = new LabelCollisionGrid(80);
      const res = resolveAreaLabelPlacement(anchor, boxWidth, boxHeight, grid, 800, 600);
      expect(res.placement).toBe('below');
      expect(res.theta).toBeCloseTo(DEFAULT_BELOW_THETA, 2);
      expect(res.isSuppressed).toBe(false);
    });

    it('slides smoothly away from hard area-label obstacles without overlapping', () => {
      const obstacleGrid = new LabelCollisionGrid(80);
      const placedLabelsGrid = new LabelCollisionGrid(80);
      // Block below
      placedLabelsGrid.insert({ x1: 340, y1: 320, x2: 460, y2: 360 });

      const res = resolveAreaLabelPlacement(
        anchor,
        boxWidth,
        boxHeight,
        obstacleGrid,
        800,
        600,
        undefined,
        DEFAULT_BELOW_THETA,
        placedLabelsGrid
      );

      expect(res.placement).not.toBe('below');
      expect(placedLabelsGrid.collides(res.rect)).toBe(false);
      expect(res.isSuppressed).toBe(false);
    });

    it('avoids viewport overflow near bottom boundary and right inspector inset', () => {
      const bottomAnchor: LabelPlacementAnchor = { id: 'bottom', screenX: 400, screenY: 580, radius: 15 };
      const grid = new LabelCollisionGrid(80);
      const resBottom = resolveAreaLabelPlacement(bottomAnchor, boxWidth, boxHeight, grid, 800, 600);
      expect(resBottom.rect.y2).toBeLessThanOrEqual(594);

      const nearInspector: LabelPlacementAnchor = { id: 'insp', screenX: 470, screenY: 300, radius: 16 };
      const insets = { left: 0, right: 300, top: 50, bottom: 0 };
      const resInsp = resolveAreaLabelPlacement(nearInspector, boxWidth, boxHeight, grid, 800, 600, insets);
      expect(resInsp.rect.x2).toBeLessThanOrEqual(494);
    });

    it('never suppresses selected or hovered labels even under severe crowding', () => {
      const placedLabelsGrid = new LabelCollisionGrid(80);
      placedLabelsGrid.insert({ x1: 200, y1: 100, x2: 600, y2: 500 });

      const resSel = resolveAreaLabelPlacement(
        { ...anchor, isSelected: true },
        boxWidth,
        boxHeight,
        new LabelCollisionGrid(80),
        800,
        600,
        undefined,
        undefined,
        placedLabelsGrid
      );
      expect(resSel.isSuppressed).toBe(false);

      const resHov = resolveAreaLabelPlacement(
        { ...anchor, isHovered: true },
        boxWidth,
        boxHeight,
        new LabelCollisionGrid(80),
        800,
        600,
        undefined,
        undefined,
        placedLabelsGrid
      );
      expect(resHov.isSuppressed).toBe(false);
    });

    it('applies local angular coherence so tiny soft grazing does not flip label to opposite side', () => {
      const obstacleGrid = new LabelCollisionGrid(80);
      // Tiny 4x4 file node barely grazing bottom-left corner of below label
      obstacleGrid.insert({ x1: 340, y1: 348, x2: 344, y2: 352 });

      const res = resolveAreaLabelPlacement(
        anchor,
        boxWidth,
        boxHeight,
        obstacleGrid,
        800,
        600,
        undefined,
        DEFAULT_BELOW_THETA
      );
      expect(Math.abs(res.theta - DEFAULT_BELOW_THETA)).toBeLessThan(0.35);
    });
  });
});
