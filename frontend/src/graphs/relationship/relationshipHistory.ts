import { FileNode } from '../../types/graph';

/**
 * Reconciles the 2D focus node when a new graph snapshot arrives:
 * - If the focus node still exists in the new snapshot, it is preserved.
 * - If the focus node was removed on disk, it is cleared to null and a missing notice
 *   is returned, preventing arbitrary jumping to unrelated files.
 */
export function reconcileFocusNodeOnSnapshot(
  currentFocusNodeId: string | null,
  newSnapshotNodes: readonly FileNode[]
): { nextFocusNodeId: string | null; missingNotice: string | null } {
  if (!currentFocusNodeId) {
    return { nextFocusNodeId: null, missingNotice: null };
  }

  const stillExists = newSnapshotNodes.some((n) => n.id === currentFocusNodeId);
  if (!stillExists) {
    return {
      nextFocusNodeId: null,
      missingNotice: 'Previous focused file was removed on disk',
    };
  }

  return { nextFocusNodeId: currentFocusNodeId, missingNotice: null };
}

/**
 * Pushes a new node onto the focus history stack.
 * If currentFocusId is null or identical to nextFocusId, history is unchanged.
 */
export function pushFocusHistory(
  currentHistory: readonly string[],
  currentFocusId: string | null,
  nextFocusId: string
): string[] {
  if (currentFocusId && currentFocusId !== nextFocusId) {
    return [...currentHistory, currentFocusId];
  }
  return [...currentHistory];
}

/**
 * Pops the top node from the focus history stack for back navigation.
 * Returns the updated history and the previous focus node ID, or null if history was empty.
 */
export function popFocusHistory(
  currentHistory: readonly string[]
): { nextHistory: string[]; prevFocusId: string | null } {
  if (currentHistory.length === 0) {
    return { nextHistory: [], prevFocusId: null };
  }

  const prevFocusId = currentHistory[currentHistory.length - 1];
  return {
    nextHistory: currentHistory.slice(0, -1),
    prevFocusId,
  };
}

/**
 * Resolves the display filename for the back navigation button.
 */
export function resolveBackTargetName(
  history: readonly string[],
  nodes: readonly FileNode[]
): string | null {
  if (history.length === 0) return null;
  const targetId = history[history.length - 1];
  return nodes.find((n) => n.id === targetId)?.filename ?? null;
}
