import { describe, it, expect } from 'vitest';
import type { LayoutBounds } from '../relationshipLayout';
import {
  computeFitPadding,
  fitViewportToBounds,
  isBoundsVisible,
  MAX_FIT_ZOOM,
  MIN_FIT_ZOOM,
  recenterViewportForResize,
} from '../relationshipViewport';

function makeBounds(minX: number, maxX: number, minY: number, maxY: number): LayoutBounds {
  return {
    minX,
    maxX,
    minY,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
  };
}

// Three-column horizontal relationship layout: dependents (-270), focus (0), dependencies (270).
const threeColumnBounds = makeBounds(-368, 368, -120, 100);

describe('relationship viewport fitting', () => {
  it('frames the whole graph inside the measured canvas width', () => {
    for (const width of [640, 660, 720, 900, 1200]) {
      for (const height of [520, 600, 800]) {
        const viewport = fitViewportToBounds(threeColumnBounds, width, height);
        expect(
          isBoundsVisible(threeColumnBounds, viewport, width, height),
          `bounds clipped at ${width}x${height}`
        ).toBe(true);
      }
    }
  });

  it('centers the graph in the canvas', () => {
    const viewport = fitViewportToBounds(threeColumnBounds, 660, 600);
    const centerX = viewport.panX + threeColumnBounds.centerX * viewport.zoom;
    const centerY = viewport.panY + threeColumnBounds.centerY * viewport.zoom;
    expect(centerX).toBeCloseTo(330, 6);
    expect(centerY).toBeCloseTo(300, 6);
  });

  it('regression: a viewport fitted to a stale 800px fallback clips a 640px canvas', () => {
    const stale = fitViewportToBounds(threeColumnBounds, 800, 600);
    // The old code fitted against the 800x600 default before the ResizeObserver
    // reported the real container size. The right column then fell outside.
    expect(isBoundsVisible(threeColumnBounds, stale, 640, 600)).toBe(false);
    expect(stale.panX + threeColumnBounds.maxX * stale.zoom).toBeGreaterThan(640);

    // Refitting against the measured width restores full visibility.
    const corrected = fitViewportToBounds(threeColumnBounds, 640, 600);
    expect(isBoundsVisible(threeColumnBounds, corrected, 640, 600)).toBe(true);
  });

  it('respects adaptive padding instead of touching the canvas edge', () => {
    const width = 900;
    const height = 700;
    const padding = computeFitPadding(width, height);
    const viewport = fitViewportToBounds(threeColumnBounds, width, height);
    const left = viewport.panX + threeColumnBounds.minX * viewport.zoom;
    const right = viewport.panX + threeColumnBounds.maxX * viewport.zoom;
    expect(padding).toBeGreaterThanOrEqual(32);
    expect(padding).toBeLessThanOrEqual(64);
    expect(left).toBeGreaterThanOrEqual(padding);
    expect(right).toBeLessThanOrEqual(width - padding);
  });

  it('clamps zoom so tiny graphs do not balloon and huge graphs stay readable', () => {
    const tiny = fitViewportToBounds(makeBounds(-10, 10, -10, 10), 1200, 800);
    expect(tiny.zoom).toBe(MAX_FIT_ZOOM);

    const huge = fitViewportToBounds(makeBounds(-100000, 100000, -100000, 100000), 800, 600);
    expect(huge.zoom).toBe(MIN_FIT_ZOOM);
  });

  it('falls back to a centered identity camera for degenerate inputs', () => {
    const empty = makeBounds(0, 0, 0, 0);
    expect(fitViewportToBounds(empty, 640, 480)).toEqual({ panX: 320, panY: 240, zoom: 1 });
    expect(fitViewportToBounds(threeColumnBounds, 0, 480)).toEqual({
      panX: 0,
      panY: 0,
      zoom: 1,
    });
    expect(fitViewportToBounds(threeColumnBounds, 640, 0)).toEqual({
      panX: 0,
      panY: 0,
      zoom: 1,
    });
  });

  it('keeps the world point under the canvas center stable across a resize', () => {
    const viewport = { panX: 60, panY: 20, zoom: 1.4 };
    const previous = { width: 640, height: 600 };
    const next = { width: 900, height: 720 };

    const worldCenterBefore = {
      x: (previous.width / 2 - viewport.panX) / viewport.zoom,
      y: (previous.height / 2 - viewport.panY) / viewport.zoom,
    };

    const resized = recenterViewportForResize(viewport, previous, next);

    const worldCenterAfter = {
      x: (next.width / 2 - resized.panX) / resized.zoom,
      y: (next.height / 2 - resized.panY) / resized.zoom,
    };

    expect(resized.zoom).toBe(viewport.zoom);
    expect(worldCenterAfter.x).toBeCloseTo(worldCenterBefore.x, 6);
    expect(worldCenterAfter.y).toBeCloseTo(worldCenterBefore.y, 6);
  });

  it('only reports visibility for bounds that are actually inside the canvas', () => {
    const viewport = fitViewportToBounds(threeColumnBounds, 640, 600);
    expect(isBoundsVisible(threeColumnBounds, viewport, 640, 600)).toBe(true);
    expect(isBoundsVisible(threeColumnBounds, viewport, 320, 300)).toBe(false);
    expect(isBoundsVisible(threeColumnBounds, viewport, 1200, 600)).toBe(true);
  });
});
