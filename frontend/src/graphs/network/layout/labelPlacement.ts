/**
 * PreBase — Collision-Aware Architectural Label Placement Engine
 *
 * Implements deterministic multi-candidate placement, obstacle collision avoidance,
 * spatial hashing, and temporal hysteresis to guarantee that area labels never
 * unintentionally obscure or collide with file nodes or other labels.
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

export interface LabelCandidate {
  placement: CandidatePlacement;
  rect: ScreenRect;
  index: number;
}

export interface LabelPlacementResult {
  rect: ScreenRect;
  placement: CandidatePlacement;
  candidateIndex: number;
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

export const CANDIDATE_PLACEMENTS: CandidatePlacement[] = [
  'below',
  'above',
  'right',
  'left',
  'below-right',
  'below-left',
];

export const TEMPORAL_HYSTERESIS_BONUS = 60;

/**
 * Generates bounded candidate positions for an area label around its anchor.
 */
export function generateLabelCandidates(
  anchor: LabelPlacementAnchor,
  boxWidth: number,
  boxHeight: number,
  gap = 4
): LabelCandidate[] {
  const candidates: LabelCandidate[] = [];
  const { screenX, screenY, radius } = anchor;

  // 0: Below (default standard)
  candidates.push({
    placement: 'below',
    index: 0,
    rect: {
      x1: screenX - boxWidth / 2,
      y1: screenY + radius + gap,
      x2: screenX + boxWidth / 2,
      y2: screenY + radius + gap + boxHeight,
    },
  });

  // 1: Above
  candidates.push({
    placement: 'above',
    index: 1,
    rect: {
      x1: screenX - boxWidth / 2,
      y1: screenY - radius - gap - boxHeight,
      x2: screenX + boxWidth / 2,
      y2: screenY - radius - gap,
    },
  });

  // 2: Right
  candidates.push({
    placement: 'right',
    index: 2,
    rect: {
      x1: screenX + radius + gap + 2,
      y1: screenY - boxHeight / 2,
      x2: screenX + radius + gap + 2 + boxWidth,
      y2: screenY + boxHeight / 2,
    },
  });

  // 3: Left
  candidates.push({
    placement: 'left',
    index: 3,
    rect: {
      x1: screenX - radius - gap - 2 - boxWidth,
      y1: screenY - boxHeight / 2,
      x2: screenX - radius - gap - 2,
      y2: screenY + boxHeight / 2,
    },
  });

  // 4: Below-Right (staggered)
  candidates.push({
    placement: 'below-right',
    index: 4,
    rect: {
      x1: screenX - boxWidth * 0.2,
      y1: screenY + radius + gap,
      x2: screenX - boxWidth * 0.2 + boxWidth,
      y2: screenY + radius + gap + boxHeight,
    },
  });

  // 5: Below-Left (staggered)
  candidates.push({
    placement: 'below-left',
    index: 5,
    rect: {
      x1: screenX - boxWidth * 0.8,
      y1: screenY + radius + gap,
      x2: screenX - boxWidth * 0.8 + boxWidth,
      y2: screenY + radius + gap + boxHeight,
    },
  });

  return candidates;
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

  return (
    rect.x1 >= minX &&
    rect.x2 <= maxX &&
    rect.y1 >= minY &&
    rect.y2 <= maxY
  );
}

/**
 * Returns the exact bounding rectangle for a given candidate index.
 */
export function getCandidateRect(
  anchor: LabelPlacementAnchor,
  candidateIndex: number,
  boxWidth: number,
  boxHeight: number,
  gap = 4
): ScreenRect {
  const candidates = generateLabelCandidates(anchor, boxWidth, boxHeight, gap);
  const validIndex = Math.max(0, Math.min(candidates.length - 1, candidateIndex));
  return candidates[validIndex].rect;
}

/**
 * Returns the candidate placement name for a given candidate index.
 */
export function getCandidatePlacement(candidateIndex: number): CandidatePlacement {
  const validIndex = Math.max(0, Math.min(CANDIDATE_PLACEMENTS.length - 1, candidateIndex));
  return CANDIDATE_PLACEMENTS[validIndex];
}

/**
 * Evaluates candidate placements against the spatial obstacle grid and selects
 * the candidate with the lowest collision penalty, applying temporal hysteresis
 * to prevent frame-to-frame jumping.
 *
 * Architecture Invariants:
 * 1. Interaction-Locked Stability: During active camera interaction (dragging, rotating,
 *    panning, inertia, or camera animation), candidate switching is completely locked.
 *    Labels track their projected anchors 1:1 with zero re-evaluation and zero teleportation.
 * 2. Persistent Candidate Authority: Once a candidate placement is established, it remains
 *    authoritative unless a hard constraint (severe viewport exit or hard collision with
 *    another area label) invalidates it. Soft file-node collisions NEVER trigger candidate switching.
 * 3. Initial & Fallback Optimization: Multi-candidate scoring is only performed on initial
 *    mount or when an existing persistent placement is genuinely hard-invalidated.
 */
export function resolveAreaLabelPlacement(
  anchor: LabelPlacementAnchor,
  boxWidth: number,
  boxHeight: number,
  collisionGrid: LabelCollisionGrid,
  viewportWidth: number,
  viewportHeight: number,
  insets?: ViewportInsets,
  previousCandidateIndex?: number,
  placedLabelsGrid?: LabelCollisionGrid,
  isInteractionLocked = false
): LabelPlacementResult {
  const candidates = generateLabelCandidates(anchor, boxWidth, boxHeight);

  // Invariant 1: During active camera interaction (drag, rotate, pan, inertia coasting,
  // or camera animation), candidate switching is strictly locked to prevent teleportation.
  if (isInteractionLocked && previousCandidateIndex !== undefined) {
    const validIndex = Math.max(0, Math.min(candidates.length - 1, previousCandidateIndex));
    const cand = candidates[validIndex];
    return {
      rect: cand.rect,
      placement: cand.placement,
      candidateIndex: cand.index,
      isSuppressed: false,
    };
  }

  // Invariant 2: When stationary (not actively dragging/rotating), treat the previously
  // selected candidate as durable persistent state. It remains authoritative as long as it
  // satisfies hard constraints (contained inside usable viewport and not overlapping another
  // area label or anchor monogram). Soft collisions (overlapping 0 or 1 file node) MUST NEVER
  // cause a label to flip to the opposite side of its anchor!
  if (
    previousCandidateIndex !== undefined &&
    previousCandidateIndex >= 0 &&
    previousCandidateIndex < candidates.length
  ) {
    const prevCand = candidates[previousCandidateIndex];
    const insideViewport = isRectInsideViewport(
      prevCand.rect,
      viewportWidth,
      viewportHeight,
      insets,
      6
    );
    const hardCollision = placedLabelsGrid ? placedLabelsGrid.collides(prevCand.rect) : false;
    const nodeCollisions = collisionGrid.countCollisions(prevCand.rect);

    // If candidate is inside the viewport, does not collide with another placed area label,
    // and is not heavily obstructed by multiple file nodes (nodeCollisions < 2), PRESERVE IT!
    if (
      (insideViewport && !hardCollision && nodeCollisions < 2) ||
      anchor.isSelected ||
      anchor.isHovered
    ) {
      return {
        rect: prevCand.rect,
        placement: prevCand.placement,
        candidateIndex: prevCand.index,
        isSuppressed: false,
      };
    }
  }

  // Invariant 3: Initial placement or hard-invalidated candidate: evaluate all candidates
  let bestCandidate = candidates[0];
  let minPenalty = Infinity;

  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    let penalty = 0;

    // Viewport containment penalty
    const insideViewport = isRectInsideViewport(
      cand.rect,
      viewportWidth,
      viewportHeight,
      insets,
      6
    );
    if (!insideViewport) {
      penalty += 10000;
    }

    // Hard collision penalty: overlapping other placed area labels or area anchors
    if (placedLabelsGrid && placedLabelsGrid.collides(cand.rect)) {
      penalty += 3000;
    }

    // Soft collision penalty: overlapping foreground file nodes (fewer overlapping nodes is strongly preferred)
    const nodeCollisions = collisionGrid.countCollisions(cand.rect);
    if (nodeCollisions > 0) {
      penalty += nodeCollisions * 45;
    }

    // Placement preference bias: prefer 'below' (0), then 'above' (1), then 'right'/'left'
    if (cand.placement === 'below') {
      penalty += 0;
    } else if (cand.placement === 'above') {
      penalty += 5;
    } else if (cand.placement === 'right' || cand.placement === 'left') {
      penalty += 10;
    } else {
      penalty += 15;
    }

    // Temporal Hysteresis: strongly prefer keeping the previous frame's candidate position
    // if it remains collision-free or lightly contested, completely eliminating position oscillation
    if (previousCandidateIndex !== undefined && previousCandidateIndex === cand.index) {
      penalty -= TEMPORAL_HYSTERESIS_BONUS;
    }

    if (penalty < minPenalty) {
      minPenalty = penalty;
      bestCandidate = cand;
    }
  }

  // An area label is only suppressed if it suffers a hard collision (e.g. overlap with another area label)
  // or falls outside the viewport, AND is not currently selected or hovered.
  const isSeverelyBlocked = minPenalty >= 2000 && !anchor.isSelected && !anchor.isHovered;

  return {
    rect: bestCandidate.rect,
    placement: bestCandidate.placement,
    candidateIndex: bestCandidate.index,
    isSuppressed: isSeverelyBlocked,
  };
}
