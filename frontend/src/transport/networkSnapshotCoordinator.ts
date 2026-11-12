import { GraphSnapshot } from '../types/graph';

export interface NetworkSnapshotCoordinator {
  fetchSnapshot: (signal?: AbortSignal) => Promise<GraphSnapshot>;
  shouldApplySnapshot: (revision: number) => boolean;
  recordAppliedRevision: (revision: number) => void;
  getLatestAppliedRevision: () => number;
  shouldProcessSseEvent: (revision: number) => boolean;
  recordObservedEventRevision: (revision: number) => void;
  getHighestObservedRevision: () => number;
}

/**
 * Coordinates Network graph snapshot fetching and revision monotonicity:
 * - Coalesces concurrent in-flight requests to /api/v1/network.
 * - Enforces strictly monotonic snapshot application (> check) to prevent
 *   stale or duplicate revisions from re-triggering expensive React updates.
 * - Filters out-of-order and redundant SSE event notifications.
 */
export function createNetworkSnapshotCoordinator(
  fetchFn: (signal?: AbortSignal) => Promise<GraphSnapshot>
): NetworkSnapshotCoordinator {
  let inFlight: Promise<GraphSnapshot> | null = null;
  let latestAppliedRevision = 0;
  let highestObservedRevision = 0;

  return {
    fetchSnapshot(signal?: AbortSignal): Promise<GraphSnapshot> {
      if (!signal && inFlight) {
        return inFlight;
      }
      const promise = fetchFn(signal).finally(() => {
        if (inFlight === promise) {
          inFlight = null;
        }
      });
      if (!signal) {
        inFlight = promise;
      }
      return promise;
    },

    shouldApplySnapshot(revision: number): boolean {
      return revision > latestAppliedRevision;
    },

    recordAppliedRevision(revision: number) {
      if (revision > latestAppliedRevision) {
        latestAppliedRevision = revision;
      }
      if (revision > highestObservedRevision) {
        highestObservedRevision = revision;
      }
    },

    getLatestAppliedRevision(): number {
      return latestAppliedRevision;
    },

    shouldProcessSseEvent(revision: number): boolean {
      return revision > Math.max(latestAppliedRevision, highestObservedRevision);
    },

    recordObservedEventRevision(revision: number) {
      if (revision > highestObservedRevision) {
        highestObservedRevision = revision;
      }
    },

    getHighestObservedRevision(): number {
      return highestObservedRevision;
    },
  };
}
