import { GraphSnapshot } from '../types/graph';

export interface NetworkSnapshotCoordinator {
  fetchSnapshot: (signal?: AbortSignal) => Promise<GraphSnapshot>;
  shouldApplySnapshot: (revision: number) => boolean;
  recordAppliedRevision: (revision: number) => void;
  getLatestAppliedRevision: () => number;
  shouldProcessSseEvent: (revision: number) => boolean;
  recordObservedEventRevision: (revision: number) => void;
  getHighestObservedRevision: () => number;
  hasPendingNewerRevision: () => boolean;
  reset: () => void;
}

/**
 * Coordinates Network graph snapshot fetching and revision monotonicity:
 * - Coalesces concurrent in-flight requests to /api/v1/network.
 * - Enforces strictly monotonic snapshot application (> check) to prevent
 *   stale or duplicate revisions from re-triggering expensive React updates.
 * - Handles initial revision 0 (starts at -1 so rev 0 is accepted once).
 * - Filters out-of-order and redundant SSE event notifications.
 * - Tracks pending newer revisions when rapid updates occur during in-flight fetches.
 */
export function createNetworkSnapshotCoordinator(
  fetchFn: (signal?: AbortSignal) => Promise<GraphSnapshot>
): NetworkSnapshotCoordinator {
  let inFlight: Promise<GraphSnapshot> | null = null;
  // Initialize to -1 to cleanly support initial repository snapshot at revision 0
  let latestAppliedRevision = -1;
  let highestObservedRevision = -1;
  let failedRevision = -1;

  return {
    fetchSnapshot(signal?: AbortSignal): Promise<GraphSnapshot> {
      if (!signal && inFlight) {
        return inFlight;
      }
      const promise = fetchFn(signal)
        .then((snap) => {
          failedRevision = -1;
          return snap;
        })
        .catch((err) => {
          if (!signal?.aborted) {
            failedRevision = highestObservedRevision;
          }
          throw err;
        })
        .finally(() => {
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
      if (revision >= failedRevision) {
        failedRevision = -1;
      }
    },

    getLatestAppliedRevision(): number {
      return latestAppliedRevision;
    },

    shouldProcessSseEvent(revision: number): boolean {
      if (revision <= latestAppliedRevision) {
        return false;
      }
      if (revision > highestObservedRevision) {
        return true;
      }
      // If revision <= highestObservedRevision but > latestAppliedRevision:
      // It was observed before but failed during fetch. Allow retry if previous fetch failed and no fetch is in-flight.
      return revision === failedRevision && inFlight === null;
    },

    recordObservedEventRevision(revision: number) {
      if (revision > highestObservedRevision) {
        highestObservedRevision = revision;
      }
    },

    getHighestObservedRevision(): number {
      return highestObservedRevision;
    },

    hasPendingNewerRevision(): boolean {
      return highestObservedRevision > latestAppliedRevision;
    },

    reset() {
      inFlight = null;
      latestAppliedRevision = -1;
      highestObservedRevision = -1;
      failedRevision = -1;
    },
  };
}
