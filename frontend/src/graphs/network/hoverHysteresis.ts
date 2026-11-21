/**
 * Hover Hysteresis Engine for NetworkCanvas
 * 
 * Behavioral Requirements:
 * 1. Fast pointer traverse across multiple nodes does NOT trigger visual hover strobing.
 * 2. Lingering on a node commits hover after a threshold (~100ms).
 * 3. Moving between nodes resets the linger timer without flashing intermediate nodes.
 * 4. Leaving canvas cancels hover immediately and clears pending timers.
 * 5. Click immediately selects the node without any delay (bypasses 100ms hover delay).
 * 6. Drag/rotation gestures suppress hover highlights during camera movement.
 */

export const HOVER_HYSTERESIS_THRESHOLD_MS = 100;
export const HOVER_RELEASE_GRACE_PERIOD_MS = 60;

export interface HoverHysteresisOptions {
  thresholdMs?: number;
  gracePeriodMs?: number;
  onCommitHover: (nodeId: string | null) => void;
  onSelectNodeImmediate?: (nodeId: string) => void;
}

export interface HoverHysteresisController {
  handlePointerMoveOverNode: (nodeId: string) => void;
  handlePointerMoveOverEmpty: () => void;
  handlePointerLeaveCanvas: () => void;
  handleClickNode: (nodeId: string) => void;
  handleGestureStart: () => void;
  handleGestureEnd: () => void;
  getCommittedHoverNodeId: () => string | null;
  getPendingHoverNodeId: () => string | null;
  isGestureActive: () => boolean;
  dispose: () => void;
}

export function createHoverHysteresisController(
  options: HoverHysteresisOptions
): HoverHysteresisController {
  const thresholdMs = options.thresholdMs ?? HOVER_HYSTERESIS_THRESHOLD_MS;
  const gracePeriodMs = options.gracePeriodMs ?? 0;
  const onCommitHover = options.onCommitHover;
  const onSelectNodeImmediate = options.onSelectNodeImmediate;

  let committedHoverNodeId: string | null = null;
  let pendingHoverNodeId: string | null = null;
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  let emptyGraceTimer: ReturnType<typeof setTimeout> | null = null;
  let isDraggingOrRotating = false;

  const clearPendingTimer = () => {
    if (hoverTimer !== null) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    pendingHoverNodeId = null;
  };

  const clearGraceTimer = () => {
    if (emptyGraceTimer !== null) {
      clearTimeout(emptyGraceTimer);
      emptyGraceTimer = null;
    }
  };

  const commitHover = (nodeId: string | null) => {
    clearGraceTimer();
    if (committedHoverNodeId !== nodeId) {
      committedHoverNodeId = nodeId;
      onCommitHover(nodeId);
    }
  };

  return {
    handlePointerMoveOverNode(nodeId: string) {
      // If a gesture (drag/pan/rotate) is active, do not process hover
      if (isDraggingOrRotating) {
        clearPendingTimer();
        clearGraceTimer();
        return;
      }

      // If returning to the already committed node, cancel any empty grace timer and keep it committed
      if (committedHoverNodeId === nodeId) {
        clearPendingTimer();
        clearGraceTimer();
        return;
      }

      // If already pending this exact node, let the timer run
      if (pendingHoverNodeId === nodeId && hoverTimer !== null) {
        return;
      }

      // Fast pointer traverse: cancel previous timer, clear any empty release grace timer, and schedule new linger check
      clearPendingTimer();
      clearGraceTimer();
      pendingHoverNodeId = nodeId;

      hoverTimer = setTimeout(() => {
        hoverTimer = null;
        const candidate = pendingHoverNodeId;
        pendingHoverNodeId = null;
        if (candidate !== null && !isDraggingOrRotating) {
          commitHover(candidate);
        }
      }, thresholdMs);
    },

    handlePointerMoveOverEmpty() {
      clearPendingTimer();
      if (committedHoverNodeId !== null) {
        if (gracePeriodMs > 0) {
          if (emptyGraceTimer === null) {
            emptyGraceTimer = setTimeout(() => {
              emptyGraceTimer = null;
              commitHover(null);
            }, gracePeriodMs);
          }
        } else {
          commitHover(null);
        }
      }
    },

    handlePointerLeaveCanvas() {
      // Immediately cancel pending linger timer and immediately clear committed hover with zero delay
      clearPendingTimer();
      clearGraceTimer();
      commitHover(null);
    },

    handleClickNode(nodeId: string) {
      // Immediate selection: NEVER delay click behind 100ms hover hysteresis
      clearPendingTimer();
      clearGraceTimer();
      // Synchronously select
      onSelectNodeImmediate?.(nodeId);
      // Synchronously commit hover state to clicked node
      commitHover(nodeId);
    },

    handleGestureStart() {
      isDraggingOrRotating = true;
      clearPendingTimer();
      clearGraceTimer();
      if (committedHoverNodeId !== null) {
        commitHover(null);
      }
    },

    handleGestureEnd() {
      isDraggingOrRotating = false;
      clearPendingTimer();
      clearGraceTimer();
    },

    getCommittedHoverNodeId() {
      return committedHoverNodeId;
    },

    getPendingHoverNodeId() {
      return pendingHoverNodeId;
    },

    isGestureActive() {
      return isDraggingOrRotating;
    },

    dispose() {
      clearPendingTimer();
      clearGraceTimer();
      committedHoverNodeId = null;
    },
  };
}
