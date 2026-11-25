/**
 * PreBase — Continuous Geometry-Driven Area Label Placement Engine
 *
 * Computes smooth, sliding anchor-relative label positions on a directional support
 * perimeter around each area anchor using continuous penetration/clearance costs
 * and local coherence regularization — with zero discrete candidate cliffs,
 * zero interaction locks, and zero timer-driven jumps.
 */

import { ScreenRect, LabelCollisionGrid } from '../render/networkRenderMath';
import { ViewportInsets } from '../../../types/graph';

export type CandidatePlacement =
  | 'below'
  | 'above'
  | 'right'
  | 'left'
  | 'below-right'
  | 'below-left';

export interface LabelPlacementResult {
  rect: ScreenRect;
  theta: number;
  offset: { x: number; y: number };
  placement: CandidatePlacement;
  isSuppressed: boolean;
}

export interface LabelPlacementAnchor {
  id: string;
  screenX: number;
  screenY: number;
  radius: number;
  isSelected?: boolean;
  isHovered?: boolean;
}

export const DEFAULT_LABEL_GAP = 4;
export const DEFAULT_BELOW_THETA = Math.PI / 2;

/**
 * Directional support distance from anchor center to label center along unit vector (ux, uy).
 * Guarantees the label box never overlaps the circular anchor monogram of `radius` + `gap`.
 */
export function computeSupportDistance(
  radius: number,
  gap: number,
  halfWidth: number,
  halfHeight: number,
  ux: number,
  uy: number
): number {
  return radius + gap + halfWidth * Math.abs(ux) + halfHeight * Math.abs(uy);
}

/**
 * Computes the anchor-relative top-left offset { x, y } for a label box at angle `theta`
 * on the anchor's directional support perimeter.
 */
export function computeOffsetForAngle(
  theta: number,
  radius: number,
  gap: number,
  boxWidth: number,
  boxHeight: number
): { x: number; y: number } {
  const ux = Math.cos(theta);
  const uy = Math.sin(theta);
  const dist = computeSupportDistance(radius, gap, boxWidth / 2, boxHeight / 2, ux, uy);
  return {
    x: ux * dist - boxWidth / 2,
    y: uy * dist - boxHeight / 2,
  };
}

/**
 * Maps a continuous angle `theta` to the nearest descriptive placement label (for telemetry/ARIA).
 */
export function classifyAnglePlacement(theta: number): CandidatePlacement {
  const a = Math.atan2(Math.sin(theta), Math.cos(theta));
  if (a >= Math.PI * 0.375 && a <= Math.PI * 0.625) return 'below';
  if (a > Math.PI * 0.125 && a < Math.PI * 0.375) return 'below-right';
  if (a > Math.PI * 0.625 && a < Math.PI * 0.875) return 'below-left';
  if (a >= -Math.PI * 0.625 && a <= -Math.PI * 0.375) return 'above';
  if (Math.abs(a) <= Math.PI * 0.375) return 'right';
  return 'left';
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

/**
 * Computes minimum signed distance from `rect` to the usable viewport edges.
 * Positive when comfortably inside; negative when overflowing.
 */
export function computeViewportEdgeMargin(
  rect: ScreenRect,
  viewportWidth: number,
  viewportHeight: number,
  insets?: ViewportInsets,
  margin = 6
): number {
  const minX = (insets?.left ?? 0) + margin;
  const maxX = viewportWidth - (insets?.right ?? 0) - margin;
  const minY = (insets?.top ?? 0) + margin;
  const maxY = viewportHeight - (insets?.bottom ?? 0) - margin;

  return Math.min(rect.x1 - minX, maxX - rect.x2, rect.y1 - minY, maxY - rect.y2);
}

/**
 * Evaluates continuous penetration, viewport overflow, directional preference, and
 * local angular coherence cost for a label at angle `theta` around `anchor`.
 */
function evaluateAngleCost(
  theta: number,
  anchor: LabelPlacementAnchor,
  boxWidth: number,
  boxHeight: number,
  collisionGrid: LabelCollisionGrid,
  viewportWidth: number,
  viewportHeight: number,
  insets?: ViewportInsets,
  placedLabelsGrid?: LabelCollisionGrid,
  previousTheta?: number,
  gap = DEFAULT_LABEL_GAP
): { cost: number; rect: ScreenRect; offset: { x: number; y: number }; hardArea: number } {
  const offset = computeOffsetForAngle(theta, anchor.radius, gap, boxWidth, boxHeight);
  const rect: ScreenRect = {
    x1: anchor.screenX + offset.x,
    y1: anchor.screenY + offset.y,
    x2: anchor.screenX + offset.x + boxWidth,
    y2: anchor.screenY + offset.y + boxHeight,
  };

  // 1. Continuous viewport overflow penalty
  const minX = (insets?.left ?? 0) + 6;
  const maxX = viewportWidth - (insets?.right ?? 0) - 6;
  const minY = (insets?.top ?? 0) + 6;
  const maxY = viewportHeight - (insets?.bottom ?? 0) - 6;
  const overflowX = Math.max(0, minX - rect.x1) + Math.max(0, rect.x2 - maxX);
  const overflowY = Math.max(0, minY - rect.y1) + Math.max(0, rect.y2 - maxY);
  let cost = (overflowX + overflowY) * 80 + (overflowX * overflowX + overflowY * overflowY) * 4;

  // 2. Continuous hard collision penalty (other placed area labels & anchor badges, 3px soft margin)
  const hardArea = placedLabelsGrid ? placedLabelsGrid.queryOverlapArea(rect, 3) : 0;
  cost += hardArea * 25;

  // 3. Continuous soft collision penalty (foreground file nodes)
  const softArea = collisionGrid.queryOverlapArea(rect, 0);
  cost += softArea * 0.4;

  // 4. Gentle directional preference for 'below' (theta = PI/2)
  cost += (1 - Math.sin(theta)) * 4 + Math.abs(Math.cos(theta)) * 1.5;

  // 5. Local coherence regularizer (hysteresis without hard lock)
  if (previousTheta !== undefined) {
    const dTheta = Math.atan2(Math.sin(theta - previousTheta), Math.cos(theta - previousTheta));
    cost += dTheta * dTheta * 18;
  }

  return { cost, rect, offset, hardArea };
}

/**
 * Resolves the continuous optimal target angle and offset on the anchor's support
 * perimeter using coarse ring sampling followed by local angular refinement.
 */
export function resolveAreaLabelPlacement(
  anchor: LabelPlacementAnchor,
  boxWidth: number,
  boxHeight: number,
  collisionGrid: LabelCollisionGrid,
  viewportWidth: number,
  viewportHeight: number,
  insets?: ViewportInsets,
  previousTheta?: number,
  placedLabelsGrid?: LabelCollisionGrid,
  gap = DEFAULT_LABEL_GAP
): LabelPlacementResult {
  const seedAngles: number[] = [];
  if (previousTheta !== undefined) {
    seedAngles.push(previousTheta);
  }
  seedAngles.push(DEFAULT_BELOW_THETA);

  // 24 uniform samples around the support ring (15-degree resolution)
  const ringSamples = 24;
  for (let i = 0; i < ringSamples; i++) {
    seedAngles.push((i / ringSamples) * Math.PI * 2 - Math.PI);
  }

  let bestTheta = seedAngles[0];
  let bestEval = evaluateAngleCost(
    bestTheta,
    anchor,
    boxWidth,
    boxHeight,
    collisionGrid,
    viewportWidth,
    viewportHeight,
    insets,
    placedLabelsGrid,
    previousTheta,
    gap
  );

  for (let i = 1; i < seedAngles.length; i++) {
    const t = seedAngles[i];
    const ev = evaluateAngleCost(
      t,
      anchor,
      boxWidth,
      boxHeight,
      collisionGrid,
      viewportWidth,
      viewportHeight,
      insets,
      placedLabelsGrid,
      previousTheta,
      gap
    );
    if (ev.cost < bestEval.cost) {
      bestTheta = t;
      bestEval = ev;
    }
  }

  // Local continuous angular refinement (7.5 deg -> 3 deg -> 1 deg)
  const refineSteps = [0.13, 0.05, 0.017];
  for (const step of refineSteps) {
    for (const dir of [-1, 1]) {
      const candTheta = bestTheta + dir * step;
      const ev = evaluateAngleCost(
        candTheta,
        anchor,
        boxWidth,
        boxHeight,
        collisionGrid,
        viewportWidth,
        viewportHeight,
        insets,
        placedLabelsGrid,
        previousTheta,
        gap
      );
      if (ev.cost < bestEval.cost) {
        bestTheta = candTheta;
        bestEval = ev;
      }
    }
  }

  const normalizedTheta = Math.atan2(Math.sin(bestTheta), Math.cos(bestTheta));
  const isSeverelyBlocked =
    bestEval.hardArea > 4.0 && !anchor.isSelected && !anchor.isHovered;

  return {
    rect: bestEval.rect,
    theta: normalizedTheta,
    offset: bestEval.offset,
    placement: classifyAnglePlacement(normalizedTheta),
    isSuppressed: isSeverelyBlocked,
  };
}
