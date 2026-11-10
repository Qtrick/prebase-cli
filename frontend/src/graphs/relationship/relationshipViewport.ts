import type { LayoutBounds } from './relationshipLayout';

export interface Viewport2D {
  panX: number;
  panY: number;
  zoom: number;
}

export interface CanvasSize {
  width: number;
  height: number;
}

export const MIN_FIT_ZOOM = 0.25;
export const MAX_FIT_ZOOM = 1.6;

const MIN_PADDING = 32;
const MAX_PADDING = 64;
const PADDING_RATIO = 0.06;

export function computeFitPadding(width: number, height: number): number {
  return Math.min(MAX_PADDING, Math.max(MIN_PADDING, Math.min(width, height) * PADDING_RATIO));
}

/**
 * Camera that frames every node and header inside the canvas, with adaptive
 * padding. The returned viewport is always computed against the supplied canvas
 * size, so callers must pass the *measured* container size — never a fallback
 * default, or the framed graph will be offset off-canvas.
 */
export function fitViewportToBounds(
  bounds: LayoutBounds,
  width: number,
  height: number
): Viewport2D {
  if (width <= 0 || height <= 0) {
    return { panX: 0, panY: 0, zoom: 1.0 };
  }

  if (bounds.width <= 0 || bounds.height <= 0) {
    return { panX: width / 2, panY: height / 2, zoom: 1.0 };
  }

  const padding = computeFitPadding(width, height);
  const availableW = Math.max(100, width - padding * 2);
  const availableH = Math.max(100, height - padding * 2);

  const zoomX = availableW / bounds.width;
  const zoomY = availableH / bounds.height;
  const zoom = Math.min(MAX_FIT_ZOOM, Math.max(MIN_FIT_ZOOM, Math.min(zoomX, zoomY)));

  return {
    panX: width / 2 - bounds.centerX * zoom,
    panY: height / 2 - bounds.centerY * zoom,
    zoom,
  };
}

/**
 * Keeps the world point that sat under the canvas center under the new center
 * after the container is resized. Used when the user has manually panned or
 * zoomed, so a resize does not throw away their framing.
 */
export function recenterViewportForResize(
  viewport: Viewport2D,
  previous: CanvasSize,
  next: CanvasSize
): Viewport2D {
  return {
    panX: viewport.panX + (next.width - previous.width) / 2,
    panY: viewport.panY + (next.height - previous.height) / 2,
    zoom: viewport.zoom,
  };
}

/** Returns true when the graph bounds fit inside the canvas at this viewport. */
export function isBoundsVisible(
  bounds: LayoutBounds,
  viewport: Viewport2D,
  width: number,
  height: number
): boolean {
  if (bounds.width <= 0 || bounds.height <= 0) return true;
  const left = viewport.panX + bounds.minX * viewport.zoom;
  const right = viewport.panX + bounds.maxX * viewport.zoom;
  const top = viewport.panY + bounds.minY * viewport.zoom;
  const bottom = viewport.panY + bounds.maxY * viewport.zoom;
  const epsilon = 0.5;
  return (
    left >= -epsilon &&
    top >= -epsilon &&
    right <= width + epsilon &&
    bottom <= height + epsilon
  );
}
