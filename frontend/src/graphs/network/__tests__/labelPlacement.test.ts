import { describe, it, expect } from 'vitest';
import {
  computeAttachedLabelRect,
  isRectInsideViewport,
  DEFAULT_LABEL_GAP,
  LabelPlacementAnchor,
} from '../layout/labelPlacement';

describe('Stable Screen-Space Area Label Attachment & Viewport Helpers (labelPlacement.ts)', () => {
  const baseAnchor: LabelPlacementAnchor = {
    id: 'area-core',
    screenX: 400,
    screenY: 300,
    radius: 18,
    isSelected: false,
    isHovered: false,
  };

  describe('computeAttachedLabelRect', () => {
    it('attaches label centered directly beneath the anchor using DEFAULT_LABEL_GAP', () => {
      const boxWidth = 120;
      const boxHeight = 32;
      const rect = computeAttachedLabelRect(baseAnchor, boxWidth, boxHeight);

      expect(rect.x1).toBe(baseAnchor.screenX - boxWidth / 2);
      expect(rect.x2).toBe(baseAnchor.screenX + boxWidth / 2);
      expect(rect.y1).toBe(baseAnchor.screenY + baseAnchor.radius + DEFAULT_LABEL_GAP);
      expect(rect.y2).toBe(rect.y1 + boxHeight);

      // Horizontal centering & exact dimensions
      expect((rect.x1 + rect.x2) / 2).toBe(baseAnchor.screenX);
      expect(rect.x2 - rect.x1).toBe(boxWidth);
      expect(rect.y2 - rect.y1).toBe(boxHeight);
    });

    it('respects custom vertical gap without altering horizontal centering', () => {
      const customGap = 14;
      const rect = computeAttachedLabelRect(baseAnchor, 100, 28, customGap);

      expect(rect.x1).toBe(350);
      expect(rect.x2).toBe(450);
      expect(rect.y1).toBe(baseAnchor.screenY + baseAnchor.radius + customGap);
      expect(rect.y2).toBe(rect.y1 + 28);
    });

    it('adjusts vertical attachment cleanly for varying anchor radii without overlapping the circle', () => {
      const radii = [4, 12, 18, 36, 64];
      const boxWidth = 110;
      const boxHeight = 26;

      for (const radius of radii) {
        const rect = computeAttachedLabelRect({ ...baseAnchor, radius }, boxWidth, boxHeight);
        // Horizontal bounds remain invariant to radius
        expect(rect.x1).toBe(baseAnchor.screenX - boxWidth / 2);
        expect(rect.x2).toBe(baseAnchor.screenX + boxWidth / 2);
        // Top of label stays strictly below bottom edge of anchor circle by DEFAULT_LABEL_GAP
        expect(rect.y1 - (baseAnchor.screenY + radius)).toBe(DEFAULT_LABEL_GAP);
        expect(rect.y2 - rect.y1).toBe(boxHeight);
      }
    });

    it('handles varying text box dimensions symmetrically around anchor.screenX', () => {
      const dimensions = [
        { width: 48, height: 18 },
        { width: 120, height: 32 },
        { width: 260, height: 48 },
        { width: 0, height: 0 },
      ];

      for (const { width, height } of dimensions) {
        const rect = computeAttachedLabelRect(baseAnchor, width, height);
        expect((rect.x1 + rect.x2) / 2).toBeCloseTo(baseAnchor.screenX, 6);
        expect(rect.x2 - rect.x1).toBeCloseTo(width, 6);
        expect(rect.y2 - rect.y1).toBeCloseTo(height, 6);
        expect(rect.y1).toBe(baseAnchor.screenY + baseAnchor.radius + DEFAULT_LABEL_GAP);
      }
    });

    it('preserves pure translation invariance when anchor moves across the screen', () => {
      const boxWidth = 132;
      const boxHeight = 30;
      const originRect = computeAttachedLabelRect(baseAnchor, boxWidth, boxHeight);

      const deltas = [
        { dx: 125.5, dy: -42.25 },
        { dx: -300, dy: 180 },
        { dx: 0, dy: 0 },
      ];

      for (const { dx, dy } of deltas) {
        const movedAnchor = {
          ...baseAnchor,
          screenX: baseAnchor.screenX + dx,
          screenY: baseAnchor.screenY + dy,
        };
        const movedRect = computeAttachedLabelRect(movedAnchor, boxWidth, boxHeight);

        expect(movedRect.x1 - originRect.x1).toBeCloseTo(dx, 6);
        expect(movedRect.x2 - originRect.x2).toBeCloseTo(dx, 6);
        expect(movedRect.y1 - originRect.y1).toBeCloseTo(dy, 6);
        expect(movedRect.y2 - originRect.y2).toBeCloseTo(dy, 6);
        expect(movedRect.x2 - movedRect.x1).toBeCloseTo(boxWidth, 6);
        expect(movedRect.y2 - movedRect.y1).toBeCloseTo(boxHeight, 6);
      }
    });

    it('tracks zoom-dependent radius changes monotonically with zero roaming drift', () => {
      const boxWidth = 100;
      const boxHeight = 24;
      const zoomFactors = [0.5, 1.0, 1.75, 2.5];
      const baseRadius = 16;

      let prevY1 = -Infinity;
      for (const zoom of zoomFactors) {
        const zoomedRadius = baseRadius * zoom;
        const rect = computeAttachedLabelRect(
          { screenX: 250, screenY: 200, radius: zoomedRadius },
          boxWidth,
          boxHeight
        );

        expect(rect.x1).toBe(200);
        expect(rect.x2).toBe(300);
        expect(rect.y1).toBeCloseTo(200 + zoomedRadius + DEFAULT_LABEL_GAP, 6);
        expect(rect.y1).toBeGreaterThan(prevY1);
        prevY1 = rect.y1;
      }
    });
  });

  describe('isRectInsideViewport', () => {
    const viewport = { width: 800, height: 600 };

    it('returns true when rectangle is inside default 8px margin without insets', () => {
      expect(isRectInsideViewport({ x1: 100, y1: 100, x2: 220, y2: 132 }, viewport.width, viewport.height)).toBe(true);
      // Exact default margin boundary (8 .. 792, 8 .. 592)
      expect(isRectInsideViewport({ x1: 8, y1: 8, x2: 792, y2: 592 }, viewport.width, viewport.height)).toBe(true);
    });

    it('returns false when overflowing any edge beyond the margin', () => {
      expect(isRectInsideViewport({ x1: 7.9, y1: 100, x2: 200, y2: 132 }, viewport.width, viewport.height)).toBe(false);
      expect(isRectInsideViewport({ x1: 600, y1: 100, x2: 792.1, y2: 132 }, viewport.width, viewport.height)).toBe(false);
      expect(isRectInsideViewport({ x1: 100, y1: 7.9, x2: 200, y2: 132 }, viewport.width, viewport.height)).toBe(false);
      expect(isRectInsideViewport({ x1: 100, y1: 500, x2: 200, y2: 592.1 }, viewport.width, viewport.height)).toBe(false);
    });

    it('enforces viewport insets on all four sides (left, right, top, bottom)', () => {
      const insets = { left: 40, right: 320, top: 64, bottom: 24 };
      // Usable bounds with default margin=8: x in [48, 472], y in [72, 568]
      expect(isRectInsideViewport({ x1: 48, y1: 72, x2: 472, y2: 568 }, viewport.width, viewport.height, insets)).toBe(true);

      // Violating each inset boundary individually
      expect(isRectInsideViewport({ x1: 47, y1: 100, x2: 200, y2: 130 }, viewport.width, viewport.height, insets)).toBe(false);
      expect(isRectInsideViewport({ x1: 300, y1: 100, x2: 473, y2: 130 }, viewport.width, viewport.height, insets)).toBe(false);
      expect(isRectInsideViewport({ x1: 100, y1: 71, x2: 200, y2: 130 }, viewport.width, viewport.height, insets)).toBe(false);
      expect(isRectInsideViewport({ x1: 100, y1: 500, x2: 200, y2: 569 }, viewport.width, viewport.height, insets)).toBe(false);
    });

    it('supports custom margin overrides including zero margin', () => {
      const insets = { left: 10, right: 100, top: 50, bottom: 20 };
      const exactEdgeRect = { x1: 10, y1: 50, x2: 700, y2: 580 };

      expect(isRectInsideViewport(exactEdgeRect, viewport.width, viewport.height, insets, 0)).toBe(true);
      expect(isRectInsideViewport(exactEdgeRect, viewport.width, viewport.height, insets, 1)).toBe(false);
    });

    it('returns false when viewport insets + margin leave no usable area', () => {
      const tinyViewport = { width: 300, height: 200 };
      const largeInsets = { left: 160, right: 160, top: 100, bottom: 100 };
      expect(isRectInsideViewport({ x1: 150, y1: 100, x2: 150, y2: 100 }, tinyViewport.width, tinyViewport.height, largeInsets)).toBe(false);
    });
  });
});
