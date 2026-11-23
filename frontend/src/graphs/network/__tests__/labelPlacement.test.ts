import { describe, it, expect } from 'vitest';
import {
  generateLabelCandidates,
  isRectInsideViewport,
  resolveAreaLabelPlacement,
  LabelPlacementAnchor,
} from '../layout/labelPlacement';
import { LabelCollisionGrid } from '../render/networkRenderMath';

describe('Collision-Aware Area Label Placement (labelPlacement.ts)', () => {
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

  describe('generateLabelCandidates', () => {
    it('generates 6 distinct bounded candidates around the anchor', () => {
      const candidates = generateLabelCandidates(anchor, boxWidth, boxHeight);
      expect(candidates.length).toBe(6);

      const placements = candidates.map((c) => c.placement);
      expect(placements).toEqual([
        'below',
        'above',
        'right',
        'left',
        'below-right',
        'below-left',
      ]);

      // Candidate 0 (below): top edge is below anchor bottom edge
      expect(candidates[0].rect.y1).toBeGreaterThanOrEqual(anchor.screenY + anchor.radius);

      // Candidate 1 (above): bottom edge is above anchor top edge
      expect(candidates[1].rect.y2).toBeLessThanOrEqual(anchor.screenY - anchor.radius);

      // Candidate 2 (right): left edge is to the right of anchor
      expect(candidates[2].rect.x1).toBeGreaterThanOrEqual(anchor.screenX + anchor.radius);

      // Candidate 3 (left): right edge is to the left of anchor
      expect(candidates[3].rect.x2).toBeLessThanOrEqual(anchor.screenX - anchor.radius);
    });
  });

  describe('isRectInsideViewport', () => {
    const viewport = { width: 800, height: 600 };
    const insets = { left: 0, right: 80, top: 50, bottom: 0 };

    it('returns true when completely inside usable viewport', () => {
      const rect = { x1: 200, y1: 200, x2: 300, y2: 240 };
      expect(isRectInsideViewport(rect, viewport.width, viewport.height, insets)).toBe(true);
    });

    it('returns false when extending past right inset (e.g. into inspector)', () => {
      // Usable max X is 800 - 80 - 8 = 712
      const rect = { x1: 700, y1: 200, x2: 730, y2: 240 };
      expect(isRectInsideViewport(rect, viewport.width, viewport.height, insets)).toBe(false);
    });

    it('returns false when extending above top inset (e.g. into toolbar)', () => {
      // Usable min Y is 50 + 8 = 58
      const rect = { x1: 200, y1: 40, x2: 300, y2: 80 };
      expect(isRectInsideViewport(rect, viewport.width, viewport.height, insets)).toBe(false);
    });
  });

  describe('resolveAreaLabelPlacement', () => {
    it('selects default below placement when all candidates are collision-free', () => {
      const grid = new LabelCollisionGrid(80);
      const res = resolveAreaLabelPlacement(
        anchor,
        boxWidth,
        boxHeight,
        grid,
        800,
        600
      );

      expect(res.placement).toBe('below');
      expect(res.candidateIndex).toBe(0);
      expect(res.isSuppressed).toBe(false);
    });

    it('chooses above placement when file nodes occupy space below the anchor', () => {
      const grid = new LabelCollisionGrid(80);
      // Place an obstacle directly below the anchor where Candidate 0 would sit
      grid.insert({
        x1: 380,
        y1: 320,
        x2: 420,
        y2: 360,
      });

      const res = resolveAreaLabelPlacement(
        anchor,
        boxWidth,
        boxHeight,
        grid,
        800,
        600
      );

      // Should automatically route to 'above' to avoid covering the obstacle
      expect(res.placement).toBe('above');
      expect(res.candidateIndex).toBe(1);
      expect(res.isSuppressed).toBe(false);
    });

    it('chooses right placement when obstacles block both below and above', () => {
      const grid = new LabelCollisionGrid(80);
      // Obstacle below
      grid.insert({ x1: 380, y1: 320, x2: 420, y2: 360 });
      // Obstacle above
      grid.insert({ x1: 380, y1: 240, x2: 420, y2: 280 });

      const res = resolveAreaLabelPlacement(
        anchor,
        boxWidth,
        boxHeight,
        grid,
        800,
        600
      );

      expect(res.placement).toBe('right');
      expect(res.candidateIndex).toBe(2);
    });

    it('avoids viewport overflow near bottom boundary by selecting above placement', () => {
      const bottomAnchor: LabelPlacementAnchor = {
        id: 'bottom-anchor',
        screenX: 400,
        screenY: 580, // Near bottom edge (viewport height 600)
        radius: 15,
      };

      const grid = new LabelCollisionGrid(80);
      const res = resolveAreaLabelPlacement(
        bottomAnchor,
        boxWidth,
        boxHeight,
        grid,
        800,
        600
      );

      expect(res.placement).toBe('above');
    });

    it('applies temporal hysteresis to stabilize placement across frames', () => {
      const grid = new LabelCollisionGrid(80);
      // Even if 'below' (0) has slightly lower baseline penalty, if 'above' (1) was
      // previously active and remains free, hysteresis bias maintains 'above'
      const res = resolveAreaLabelPlacement(
        anchor,
        boxWidth,
        boxHeight,
        grid,
        800,
        600,
        undefined,
        1 // previousCandidateIndex = 1 ('above')
      );

      expect(res.placement).toBe('above');
      expect(res.candidateIndex).toBe(1);
    });

    it('never suppresses selected or hovered area labels even under severe crowding', () => {
      const grid = new LabelCollisionGrid(80);
      // Completely saturate the region with an obstacle
      grid.insert({ x1: 200, y1: 100, x2: 600, y2: 500 });

      const selectedAnchor: LabelPlacementAnchor = {
        ...anchor,
        isSelected: true,
      };

      const res = resolveAreaLabelPlacement(
        selectedAnchor,
        boxWidth,
        boxHeight,
        grid,
        800,
        600
      );

      expect(res.isSuppressed).toBe(false);
    });

    it('avoids overlapping other placed area labels by selecting an alternate candidate', () => {
      const obstacleGrid = new LabelCollisionGrid(80);
      const placedLabelsGrid = new LabelCollisionGrid(80);

      // Another area label is already placed directly below
      placedLabelsGrid.insert({
        x1: 340,
        y1: 320,
        x2: 460,
        y2: 360,
      });

      const res = resolveAreaLabelPlacement(
        anchor,
        boxWidth,
        boxHeight,
        obstacleGrid,
        800,
        600,
        undefined,
        undefined,
        placedLabelsGrid
      );

      expect(res.placement).toBe('above');
      expect(res.candidateIndex).toBe(1);
      expect(res.isSuppressed).toBe(false);
    });

    it('does not suppress area labels in dense graphs with scattered file nodes', () => {
      const obstacleGrid = new LabelCollisionGrid(80);
      // Place single file nodes near candidates 0 and 1
      obstacleGrid.insert({ x1: 395, y1: 330, x2: 405, y2: 340 });
      obstacleGrid.insert({ x1: 395, y1: 260, x2: 405, y2: 270 });

      const res = resolveAreaLabelPlacement(
        anchor,
        boxWidth,
        boxHeight,
        obstacleGrid,
        800,
        600
      );

      // Right placement has 0 collisions and should be chosen
      expect(res.placement).toBe('right');
      expect(res.isSuppressed).toBe(false);
    });

    it('chooses left placement when below, above, and right are all blocked', () => {
      const obstacleGrid = new LabelCollisionGrid(80);
      // Block below (Candidate 0)
      obstacleGrid.insert({ x1: 380, y1: 320, x2: 420, y2: 360 });
      // Block above (Candidate 1)
      obstacleGrid.insert({ x1: 380, y1: 240, x2: 420, y2: 280 });
      // Block right (Candidate 2)
      obstacleGrid.insert({ x1: 425, y1: 290, x2: 465, y2: 310 });

      const res = resolveAreaLabelPlacement(
        anchor,
        boxWidth,
        boxHeight,
        obstacleGrid,
        800,
        600
      );

      expect(res.placement).toBe('left');
      expect(res.candidateIndex).toBe(3);
      expect(res.isSuppressed).toBe(false);
    });

    it('chooses staggered placement (below-right) when all four cardinal directions are blocked', () => {
      const obstacleGrid = new LabelCollisionGrid(80);
      // Candidate 0 (below) spans [340, 460], Candidate 4 (below-right) spans [376, 496]
      // An obstacle at [340, 370] blocks 'below' but leaves 'below-right' clear
      obstacleGrid.insert({ x1: 340, y1: 322, x2: 370, y2: 354 }); // blocks below
      obstacleGrid.insert({ x1: 380, y1: 240, x2: 420, y2: 280 }); // blocks above
      obstacleGrid.insert({ x1: 425, y1: 290, x2: 520, y2: 310 }); // blocks right
      obstacleGrid.insert({ x1: 280, y1: 290, x2: 375, y2: 310 }); // blocks left

      const res = resolveAreaLabelPlacement(
        anchor,
        boxWidth,
        boxHeight,
        obstacleGrid,
        800,
        600
      );

      // Staggered below-right (Candidate 4) should be selected
      expect(res.placement).toBe('below-right');
      expect(res.candidateIndex).toBe(4);
      expect(res.isSuppressed).toBe(false);
    });

    it('prioritizes soft file node collision over hard area label / anchor collision', () => {
      const obstacleGrid = new LabelCollisionGrid(80);
      const placedLabelsGrid = new LabelCollisionGrid(80);

      // Candidates 1..5 all overlap placed area labels / anchors (+3000 hard collision penalty)
      placedLabelsGrid.insert({ x1: 360, y1: 240, x2: 440, y2: 280 }); // Candidate 1 (above)
      placedLabelsGrid.insert({ x1: 430, y1: 290, x2: 550, y2: 320 }); // Candidate 2 (right)
      placedLabelsGrid.insert({ x1: 250, y1: 290, x2: 370, y2: 320 }); // Candidate 3 (left)
      placedLabelsGrid.insert({ x1: 470, y1: 330, x2: 520, y2: 350 }); // Candidate 4 (below-right)
      placedLabelsGrid.insert({ x1: 280, y1: 330, x2: 330, y2: 350 }); // Candidate 5 (below-left)

      // Candidate 0 (below) touches 1 small file node (+45 soft collision penalty)
      obstacleGrid.insert({ x1: 395, y1: 335, x2: 405, y2: 345 });

      const res = resolveAreaLabelPlacement(
        anchor,
        boxWidth,
        boxHeight,
        obstacleGrid,
        800,
        600,
        undefined,
        undefined,
        placedLabelsGrid
      );

      // Candidate 0 (below) must be chosen because 45 << 3000 (soft file node collision is strongly preferred over hard label overlap)
      expect(res.placement).toBe('below');
      expect(res.candidateIndex).toBe(0);
      expect(res.isSuppressed).toBe(false);
    });

    it('routes away from viewport insets (e.g. right inspector or top toolbar)', () => {
      // Anchor near the right usable boundary when inspector is open (insets.right = 300)
      const nearInspectorAnchor: LabelPlacementAnchor = {
        id: 'inspector-edge',
        screenX: 470, // In 800px viewport, usable right edge is 800 - 300 - 6 = 494
        screenY: 300,
        radius: 16,
      };

      const insets = { left: 0, right: 300, top: 50, bottom: 0 };
      const grid = new LabelCollisionGrid(80);

      const res = resolveAreaLabelPlacement(
        nearInspectorAnchor,
        boxWidth, // 120px: Candidate 2 ('right') would span 470 + 16 + 6 to 470 + 22 + 120 = 612 > 494
        boxHeight,
        grid,
        800,
        600,
        insets
      );

      // Right candidate is penalized by 10000; engine must route to 'below', 'above', or 'left'
      expect(res.placement).not.toBe('right');
      expect(res.isSuppressed).toBe(false);
    });

    it('never suppresses hovered area labels even when surrounded by severe obstacles', () => {
      const obstacleGrid = new LabelCollisionGrid(80);
      // Completely saturate the region around the anchor
      obstacleGrid.insert({ x1: 200, y1: 100, x2: 600, y2: 500 });

      const hoveredAnchor: LabelPlacementAnchor = {
        ...anchor,
        isHovered: true,
      };

      const res = resolveAreaLabelPlacement(
        hoveredAnchor,
        boxWidth,
        boxHeight,
        obstacleGrid,
        800,
        600
      );

      expect(res.isSuppressed).toBe(false);
    });

    it('overrides temporal hysteresis when previous candidate position is overtaken by an obstacle', () => {
      const obstacleGrid = new LabelCollisionGrid(80);
      // Place an obstacle directly covering Candidate 0 ('below')
      obstacleGrid.insert({ x1: 350, y1: 320, x2: 450, y2: 360 });

      // Even though previousCandidateIndex was 0 ('below'), the collision penalty overrides the -25 bonus
      const res = resolveAreaLabelPlacement(
        anchor,
        boxWidth,
        boxHeight,
        obstacleGrid,
        800,
        600,
        undefined,
        0 // previousCandidateIndex = 0
      );

      expect(res.placement).toBe('above');
      expect(res.candidateIndex).toBe(1);
    });
  });
});
