import { Transform } from '../../types/graph';
import { LayoutCommit } from './temporalLayout';

export interface TemporalScrollBounds {
  minY: number;
  maxY: number;
}

/**
 * Computes bounded vertical scroll limits for the Temporal Timeline canvas.
 * Top limit keeps newest commit visible near the top margin.
 * Bottom limit prevents scrolling empty space past the oldest commit.
 */
export function computeTemporalScrollBounds(
  contentHeight: number,
  viewportHeight: number,
  topPadding = 60,
  bottomPadding = 120
): TemporalScrollBounds {
  const maxY = topPadding;
  const minY = Math.min(maxY, viewportHeight - contentHeight - bottomPadding);
  return { minY, maxY };
}

/**
 * Applies native vertical mouse wheel / trackpad scrolling to the Temporal Timeline canvas.
 * 
 * CRITICAL BEHAVIORAL INVARIANT:
 * Preserves transform.k (zoom scale) exactly.
 * Wheel scroll strictly updates transform.y (vertical panning) without wheel-based zoom scaling!
 */
export function applyTemporalWheelScroll(
  currentTransform: Transform,
  deltaY: number,
  contentHeight: number,
  viewportHeight: number,
  options?: {
    scrollSpeed?: number;
    clampToBounds?: boolean;
  }
): Transform {
  const speed = options?.scrollSpeed ?? 1.0;
  const clampToBounds = options?.clampToBounds ?? true;

  // Natural scroll: positive deltaY (scrolling down) moves timeline content up (decreases y)
  const targetY = currentTransform.y - deltaY * speed;

  let nextY = targetY;
  if (clampToBounds) {
    const { minY, maxY } = computeTemporalScrollBounds(contentHeight, viewportHeight);
    nextY = Math.max(minY, Math.min(maxY, targetY));
  }

  return {
    x: currentTransform.x,
    y: nextY,
    k: currentTransform.k, // SCALE IS PRESERVED! Zero wheel-based zoom scaling!
  };
}

/**
 * Reconciles Temporal canvas camera transform across cursor pagination events.
 * 
 * CRITICAL BEHAVIORAL INVARIANT:
 * When older commits are appended, the existing viewport scroll position (transform.x, transform.y, transform.k)
 * MUST NOT jump or reset to initial view.
 * The commits currently in view remain at their exact screen coordinates.
 */
export function reconcilePaginationTransform(
  currentTransform: Transform,
  hasInitializedBefore: boolean
): Transform {
  // If already initialized and user has scrolled, maintain exact camera coordinates
  if (hasInitializedBefore) {
    return { ...currentTransform };
  }
  return currentTransform;
}

/**
 * Computes updated transform to ensure the active commit is comfortably visible within the viewport.
 */
export function computeCommitScrollIntoView(
  currentTransform: Transform,
  targetNode: LayoutCommit,
  viewportHeight: number,
  margin = 80
): Transform {
  const screenY = currentTransform.y + targetNode.y * currentTransform.k;

  if (screenY < margin) {
    return {
      ...currentTransform,
      y: margin - targetNode.y * currentTransform.k,
    };
  } else if (screenY > viewportHeight - margin) {
    return {
      ...currentTransform,
      y: viewportHeight - margin - targetNode.y * currentTransform.k,
    };
  }

  return currentTransform;
}

/**
 * Handles accessible keyboard navigation for commit history DAG.
 */
export function handleKeyboardCommitStep(
  currentIndex: number,
  totalNodes: number,
  key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'
): number | null {
  if (totalNodes <= 0) return null;

  switch (key) {
    case 'ArrowDown':
      if (currentIndex === -1) return 0;
      return Math.min(totalNodes - 1, currentIndex + 1);

    case 'ArrowUp':
      if (currentIndex === -1) return totalNodes - 1;
      return Math.max(0, currentIndex - 1);

    case 'Home':
      return 0;

    case 'End':
      return totalNodes - 1;

    default:
      return null;
  }
}
