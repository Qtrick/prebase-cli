/**
 * PreBase — Stable Screen-Space Area Label Attachment & Viewport Helpers
 *
 * Computes fixed screen-space label rectangles directly beneath each projected
 * architectural area anchor. Collisions affect label visibility (via opacity),
 * never label position.
 */

import { ScreenRect } from '../render/networkRenderMath';
import { ViewportInsets } from '../../../types/graph';

export interface LabelPlacementAnchor {
  id: string;
  screenX: number;
  screenY: number;
  radius: number;
  isSelected?: boolean;
  isHovered?: boolean;
}

export const DEFAULT_LABEL_GAP = 6;

/**
 * Computes the fixed screen-space label rectangle centered directly beneath
 * the projected area anchor with a consistent vertical gap.
 */
export function computeAttachedLabelRect(
  anchor: Pick<LabelPlacementAnchor, 'screenX' | 'screenY' | 'radius'>,
  boxWidth: number,
  boxHeight: number,
  gap = DEFAULT_LABEL_GAP
): ScreenRect {
  const x1 = anchor.screenX - boxWidth / 2;
  const y1 = anchor.screenY + anchor.radius + gap;
  return {
    x1,
    y1,
    x2: x1 + boxWidth,
    y2: y1 + boxHeight,
  };
}

/**
 * Checks whether a rectangle is safely contained inside the visible viewport insets.
 */
export function isRectInsideViewport(
  rect: ScreenRect,
  viewportWidth: number,
  viewportHeight: number,
  insets?: ViewportInsets,
  margin = 8
): boolean {
  const minX = (insets?.left ?? 0) + margin;
  const maxX = viewportWidth - (insets?.right ?? 0) - margin;
  const minY = (insets?.top ?? 0) + margin;
  const maxY = viewportHeight - (insets?.bottom ?? 0) - margin;

  return rect.x1 >= minX && rect.x2 <= maxX && rect.y1 >= minY && rect.y2 <= maxY;
}
