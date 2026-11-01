import { FileNode, WatcherHealth } from '../types/graph';

export interface WatcherStatusBadgeInfo {
  text: string;
  color: string;
  pulse: boolean;
}

/**
 * Resolves the display text, indicator color, and pulse animation for the live watcher badge.
 * Implements decoupled watcher health checks and a 2.0s SSE reconnection grace period.
 */
export function resolveWatcherStatusInfo(
  watcherHealth: WatcherHealth,
  sseState: 'connected' | 'reconnecting' | 'error',
  liveRevision: number,
  isDelayedReconnecting: boolean
): WatcherStatusBadgeInfo {
  if (watcherHealth === 'disabled') {
    return {
      text: 'Watcher Disabled (--no-watch)',
      color: '#64748b',
      pulse: false,
    };
  }
  if (watcherHealth === 'degraded') {
    return {
      text: 'Watcher Degraded',
      color: '#f59e0b',
      pulse: false,
    };
  }
  if (sseState === 'connected') {
    return {
      text: liveRevision > 0 ? `Live (rev ${liveRevision})` : 'Live Watcher Active',
      color: '#2dd4bf',
      pulse: true,
    };
  }
  if (sseState === 'reconnecting') {
    if (isDelayedReconnecting) {
      return {
        text:
          liveRevision > 0
            ? `Restoring live updates — showing revision ${liveRevision}`
            : 'Restoring live updates...',
        color: '#f59e0b',
        pulse: true,
      };
    }
    return {
      text: liveRevision > 0 ? `Live (rev ${liveRevision})` : 'Live Watcher Active',
      color: '#2dd4bf',
      pulse: false,
    };
  }
  return {
    text:
      liveRevision > 0
        ? `Live updates offline — graph remains available (rev ${liveRevision})`
        : 'Live updates offline — graph remains available',
    color: '#f59e0b',
    pulse: false,
  };
}

/**
 * Reconciles the selected node across snapshot revisions:
 * Returns the fresh node object if it still exists in the new snapshot;
 * returns null if the node was deleted.
 */
export function reconcileSelectedNodeOnSnapshot(
  prevSelectedNode: FileNode | null,
  newSnapshotNodes: readonly FileNode[]
): FileNode | null {
  if (!prevSelectedNode) return null;
  return newSnapshotNodes.find((n) => n.id === prevSelectedNode.id) || null;
}
