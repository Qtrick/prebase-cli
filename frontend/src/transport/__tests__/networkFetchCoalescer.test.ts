import { describe, it, expect, vi } from 'vitest';
import { createNetworkSnapshotCoordinator } from '../networkSnapshotCoordinator';
import { GraphSnapshot } from '../../types/graph';

const makeSnap = (rev: number): GraphSnapshot => ({
  schema_version: '1.0.0',
  repository_id: 'test',
  revision: rev,
  nodes: [],
  edges: [],
  coverage: {
    total_discovered: 0,
    total_analyzed: 0,
    total_excluded: 0,
    total_issues: 0,
    is_complete: true,
  },
  issues: [],
});

describe('Network Snapshot In-Flight Coalescer & Revision Guard', () => {
  describe('Consolidated NetworkSnapshotCoordinator 10 Required Behavioral Cases', () => {
    // 1. Two concurrent requests for the same revision (single in-flight fetch returned to both callers).
    it('Case 1: two concurrent requests for the same revision share a single in-flight fetch returned to both callers', async () => {
      let callCount = 0;
      let resolveFetch: (snap: GraphSnapshot) => void;
      const inFlightPromise = new Promise<GraphSnapshot>((resolve) => {
        resolveFetch = resolve;
      });

      const mockFetch = vi.fn().mockImplementation(() => {
        callCount++;
        return inFlightPromise;
      });

      const coordinator = createNetworkSnapshotCoordinator(mockFetch);

      // Trigger two concurrent fetch requests
      const promise1 = coordinator.fetchSnapshot();
      const promise2 = coordinator.fetchSnapshot();

      // Only one underlying network fetch should have been initiated
      expect(callCount).toBe(1);
      // Both callers receive the exact same in-flight promise
      expect(promise1).toBe(promise2);

      // Settle the network fetch
      resolveFetch!(makeSnap(1));

      const [snap1, snap2] = await Promise.all([promise1, promise2]);
      expect(snap1).toBe(snap2);
      expect(snap1.revision).toBe(1);
      expect(snap2.revision).toBe(1);
      expect(callCount).toBe(1);
    });

    // 2. Ten rapid SSE events (filtered down to strictly monotonic events, coalescing in-flight network requests).
    it('Case 2: ten rapid SSE events are filtered down to strictly monotonic events, coalescing in-flight network requests', async () => {
      let callCount = 0;
      let resolveFirstCall: (snap: GraphSnapshot) => void;
      const firstCallPromise = new Promise<GraphSnapshot>((resolve) => {
        resolveFirstCall = resolve;
      });

      const mockFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return firstCallPromise;
        }
        return makeSnap(10);
      });

      const coordinator = createNetworkSnapshotCoordinator(mockFetch);

      // 10 rapid SSE events with duplicates and out-of-order jitter
      const tenIncomingEvents = [1, 1, 2, 2, 4, 3, 5, 5, 8, 10];
      const processedRevisions: number[] = [];
      const fetchPromises: Promise<GraphSnapshot>[] = [];

      for (const rev of tenIncomingEvents) {
        if (coordinator.shouldProcessSseEvent(rev)) {
          coordinator.recordObservedEventRevision(rev);
          processedRevisions.push(rev);
          // Launch fetch coalesced under the single in-flight promise
          fetchPromises.push(coordinator.fetchSnapshot());
        }
      }

      // Filtered down strictly monotonic sequence
      expect(processedRevisions).toEqual([1, 2, 4, 5, 8, 10]);
      // Exactly 1 network fetch launched during active in-flight period
      expect(callCount).toBe(1);

      // Resolve first fetch with revision 1 snapshot
      resolveFirstCall!(makeSnap(1));
      const snaps = await Promise.all(fetchPromises);
      snaps.forEach((snap) => expect(snap.revision).toBe(1));

      // Client applies revision 1
      expect(coordinator.shouldApplySnapshot(1)).toBe(true);
      coordinator.recordAppliedRevision(1);
      expect(coordinator.getLatestAppliedRevision()).toBe(1);

      // Coordinator identifies that newer revisions (up to 10) arrived during the in-flight fetch
      expect(coordinator.hasPendingNewerRevision()).toBe(true);
      expect(coordinator.getHighestObservedRevision()).toBe(10);

      // Follow-up fetch is triggered for coalesced newer revision
      const followUpSnap = await coordinator.fetchSnapshot();
      expect(callCount).toBe(2);
      expect(followUpSnap.revision).toBe(10);
      expect(coordinator.shouldApplySnapshot(followUpSnap.revision)).toBe(true);
      coordinator.recordAppliedRevision(followUpSnap.revision);

      expect(coordinator.getLatestAppliedRevision()).toBe(10);
      expect(coordinator.hasPendingNewerRevision()).toBe(false);
    });

    // 3. Two events with the same revision (duplicate revision correctly rejected by shouldProcessSseEvent and shouldApplySnapshot).
    it('Case 3: two events with the same revision are correctly rejected by shouldProcessSseEvent and shouldApplySnapshot', () => {
      const coordinator = createNetworkSnapshotCoordinator(vi.fn());

      // Initial event at revision 3
      expect(coordinator.shouldProcessSseEvent(3)).toBe(true);
      coordinator.recordObservedEventRevision(3);

      // Duplicate event at revision 3 must be rejected by shouldProcessSseEvent
      expect(coordinator.shouldProcessSseEvent(3)).toBe(false);

      // First snapshot application at revision 3 must be accepted
      expect(coordinator.shouldApplySnapshot(3)).toBe(true);
      coordinator.recordAppliedRevision(3);
      expect(coordinator.getLatestAppliedRevision()).toBe(3);

      // Duplicate snapshot application at revision 3 must be rejected by shouldApplySnapshot
      expect(coordinator.shouldApplySnapshot(3)).toBe(false);
      // Even if mistakenly processed, recorded revision remains 3
      coordinator.recordAppliedRevision(3);
      expect(coordinator.getLatestAppliedRevision()).toBe(3);
      // shouldProcessSseEvent continues rejecting duplicate revision 3
      expect(coordinator.shouldProcessSseEvent(3)).toBe(false);
    });

    // 4. An older event arriving after a newer event (out-of-order event rejected).
    it('Case 4: an older event arriving after a newer event is rejected', () => {
      const coordinator = createNetworkSnapshotCoordinator(vi.fn());

      // Newer event at revision 5 arrives first
      expect(coordinator.shouldProcessSseEvent(5)).toBe(true);
      coordinator.recordObservedEventRevision(5);
      expect(coordinator.shouldApplySnapshot(5)).toBe(true);
      coordinator.recordAppliedRevision(5);
      expect(coordinator.getLatestAppliedRevision()).toBe(5);

      // Older out-of-order event at revision 3 arrives later
      expect(coordinator.shouldProcessSseEvent(3)).toBe(false);
      expect(coordinator.shouldApplySnapshot(3)).toBe(false);

      // Stale event at revision 2 also rejected
      expect(coordinator.shouldProcessSseEvent(2)).toBe(false);
      expect(coordinator.shouldApplySnapshot(2)).toBe(false);

      // Revision state does not regress
      expect(coordinator.getLatestAppliedRevision()).toBe(5);
      expect(coordinator.getHighestObservedRevision()).toBe(5);
    });

    // 5. A higher revision arriving during an in-flight fetch (hasPendingNewerRevision() returns true, enabling follow-up fetch).
    it('Case 5: a higher revision arriving during an in-flight fetch sets hasPendingNewerRevision to true, enabling follow-up fetch', async () => {
      let callCount = 0;
      let resolveFirst: (snap: GraphSnapshot) => void;
      const firstPromise = new Promise<GraphSnapshot>((resolve) => {
        resolveFirst = resolve;
      });

      const mockFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return firstPromise;
        return makeSnap(7);
      });

      const coordinator = createNetworkSnapshotCoordinator(mockFetch);

      // 1. Initial state at revision 2
      coordinator.recordAppliedRevision(2);
      expect(coordinator.getLatestAppliedRevision()).toBe(2);

      // 2. Start in-flight fetch
      const inFlightFetch = coordinator.fetchSnapshot();
      expect(coordinator.hasPendingNewerRevision()).toBe(false);

      // 3. Higher revision 7 arrives via SSE while fetch 1 is in-flight
      expect(coordinator.shouldProcessSseEvent(7)).toBe(true);
      coordinator.recordObservedEventRevision(7);

      // Coordinator immediately flags pending newer revision
      expect(coordinator.hasPendingNewerRevision()).toBe(true);

      // 4. First in-flight fetch completes with snapshot revision 2
      resolveFirst!(makeSnap(2));
      const snap1 = await inFlightFetch;
      expect(snap1.revision).toBe(2);

      // Coordinator still has pending newer revision (7 > 2)
      expect(coordinator.hasPendingNewerRevision()).toBe(true);

      // 5. Caller performs follow-up fetch for the pending revision
      const followUpSnap = await coordinator.fetchSnapshot();
      expect(callCount).toBe(2);
      expect(followUpSnap.revision).toBe(7);
      expect(coordinator.shouldApplySnapshot(followUpSnap.revision)).toBe(true);
      coordinator.recordAppliedRevision(followUpSnap.revision);

      expect(coordinator.getLatestAppliedRevision()).toBe(7);
      expect(coordinator.hasPendingNewerRevision()).toBe(false);
    });

    // 6. A fetch failing while a newer event arrives (in-flight promise cleans up on error, allowing subsequent fetch to succeed for the newer revision).
    it('Case 6: a fetch failing while a newer event arrives cleans up in-flight promise and allows subsequent fetch to succeed for newer revision', async () => {
      let callCount = 0;
      let rejectFirst: (err: Error) => void;
      const firstPromise = new Promise<GraphSnapshot>((_, reject) => {
        rejectFirst = reject;
      });

      const mockFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return firstPromise;
        return makeSnap(4);
      });

      const coordinator = createNetworkSnapshotCoordinator(mockFetch);

      // First fetch initiated
      const failedFetch = coordinator.fetchSnapshot();
      expect(callCount).toBe(1);

      // Newer revision arrives while first fetch is in flight
      expect(coordinator.shouldProcessSseEvent(4)).toBe(true);
      coordinator.recordObservedEventRevision(4);
      expect(coordinator.hasPendingNewerRevision()).toBe(true);

      // First fetch encounters a network failure
      rejectFirst!(new Error('Network error 503 Service Unavailable'));
      await expect(failedFetch).rejects.toThrow('Network error 503 Service Unavailable');

      // In-flight promise was cleaned up on error; subsequent fetch initiates a new network call
      const retryFetch = coordinator.fetchSnapshot();
      expect(callCount).toBe(2);

      const retrySnap = await retryFetch;
      expect(retrySnap.revision).toBe(4);
      expect(coordinator.shouldApplySnapshot(retrySnap.revision)).toBe(true);
      coordinator.recordAppliedRevision(retrySnap.revision);

      expect(coordinator.getLatestAppliedRevision()).toBe(4);
      expect(coordinator.hasPendingNewerRevision()).toBe(false);
    });

    // 7. SSE disconnection and reconnection (reconnect reconciles status, applies newer snapshot if revision increased).
    it('Case 7: SSE disconnection and reconnection reconciles status and applies newer snapshot if revision increased', async () => {
      let currentServerRevision = 2;
      const mockFetch = vi.fn().mockImplementation(async () => {
        return makeSnap(currentServerRevision);
      });

      const coordinator = createNetworkSnapshotCoordinator(mockFetch);

      // 1. Initial snapshot applied at revision 2
      const initialSnap = await coordinator.fetchSnapshot();
      coordinator.recordAppliedRevision(initialSnap.revision);
      expect(coordinator.getLatestAppliedRevision()).toBe(2);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // 2. Simulate SSE disconnection -> reconnection where status revision did NOT increase
      const reconnectStatusUnchanged = { revision: 2 };
      if (coordinator.shouldApplySnapshot(reconnectStatusUnchanged.revision)) {
        await coordinator.fetchSnapshot();
      }
      // No redundant network fetch triggered
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(coordinator.getLatestAppliedRevision()).toBe(2);

      // 3. Simulate updates occurred during disconnection; status on reconnect reports revision 6
      currentServerRevision = 6;
      const reconnectStatusIncreased = { revision: 6 };

      expect(coordinator.shouldApplySnapshot(reconnectStatusIncreased.revision)).toBe(true);
      coordinator.recordObservedEventRevision(reconnectStatusIncreased.revision);

      const reconnectedSnap = await coordinator.fetchSnapshot();
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(reconnectedSnap.revision).toBe(6);
      expect(coordinator.shouldApplySnapshot(reconnectedSnap.revision)).toBe(true);
      coordinator.recordAppliedRevision(reconnectedSnap.revision);

      expect(coordinator.getLatestAppliedRevision()).toBe(6);
      expect(coordinator.hasPendingNewerRevision()).toBe(false);
    });

    // 8. Request cancellation with AbortSignal (aborted request rejects properly without breaking coordinator subsequent fetch).
    it('Case 8: request cancellation with AbortSignal rejects properly without breaking coordinator subsequent fetch', async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation((signal?: AbortSignal) => {
        callCount++;
        return new Promise<GraphSnapshot>((resolve, reject) => {
          if (signal?.aborted) {
            reject(new DOMException('This operation was aborted', 'AbortError'));
            return;
          }
          const timeout = setTimeout(() => {
            resolve(makeSnap(callCount));
          }, 40);

          signal?.addEventListener('abort', () => {
            clearTimeout(timeout);
            reject(new DOMException('This operation was aborted', 'AbortError'));
          });
        });
      });

      const coordinator = createNetworkSnapshotCoordinator(mockFetch);

      // 1. Abort a signaled request
      const abortController = new AbortController();
      const abortedPromise = coordinator.fetchSnapshot(abortController.signal);
      abortController.abort();

      await expect(abortedPromise).rejects.toThrow('This operation was aborted');

      // 2. Verify coordinator is healthy and subsequent fetch executes cleanly
      const healthySnap = await coordinator.fetchSnapshot();
      expect(healthySnap.revision).toBe(2);
      expect(coordinator.shouldApplySnapshot(healthySnap.revision)).toBe(true);
      coordinator.recordAppliedRevision(healthySnap.revision);
      expect(coordinator.getLatestAppliedRevision()).toBe(2);

      // 3. Aborting a signaled request does not disrupt an active un-signaled in-flight fetch
      let resolveActive: (snap: GraphSnapshot) => void;
      mockFetch.mockImplementationOnce(() => new Promise((res) => { resolveActive = res; }));

      const activeInFlight = coordinator.fetchSnapshot(); // un-signaled in-flight
      const separateAbortCtrl = new AbortController();
      const separateSignaledFetch = coordinator.fetchSnapshot(separateAbortCtrl.signal);

      separateAbortCtrl.abort();
      await expect(separateSignaledFetch).rejects.toThrow('This operation was aborted');

      // Un-signaled in-flight request resolves successfully
      resolveActive!(makeSnap(3));
      const activeSnap = await activeInFlight;
      expect(activeSnap.revision).toBe(3);
    });

    // 9. Snapshot revision 0 (initial repository state at revision 0 is accepted on first load because coordinator starts at -1, but duplicate revision 0 is rejected).
    it('Case 9: snapshot revision 0 is accepted on first load because coordinator starts at -1, but duplicate revision 0 is rejected', () => {
      const coordinator = createNetworkSnapshotCoordinator(vi.fn());

      // Coordinator starts at initial revision -1
      expect(coordinator.getLatestAppliedRevision()).toBe(-1);
      expect(coordinator.getHighestObservedRevision()).toBe(-1);

      // Initial repository state at revision 0 must be accepted
      expect(coordinator.shouldApplySnapshot(0)).toBe(true);
      expect(coordinator.shouldProcessSseEvent(0)).toBe(true);

      // Apply initial revision 0
      coordinator.recordAppliedRevision(0);
      expect(coordinator.getLatestAppliedRevision()).toBe(0);
      expect(coordinator.getHighestObservedRevision()).toBe(0);

      // Duplicate revision 0 must be rejected
      expect(coordinator.shouldApplySnapshot(0)).toBe(false);
      expect(coordinator.shouldProcessSseEvent(0)).toBe(false);

      // Subsequent revision 1 must be accepted
      expect(coordinator.shouldApplySnapshot(1)).toBe(true);
      expect(coordinator.shouldProcessSseEvent(1)).toBe(true);
    });

    // 10. Stale server responses (server returns an older revision than currently applied; shouldApplySnapshot rejects it and getLatestAppliedRevision() does not regress).
    it('Case 10: stale server responses are rejected by shouldApplySnapshot and getLatestAppliedRevision does not regress', () => {
      const coordinator = createNetworkSnapshotCoordinator(vi.fn());

      // Client has applied revision 5
      coordinator.recordAppliedRevision(5);
      expect(coordinator.getLatestAppliedRevision()).toBe(5);

      // Stale responses for older revisions arrive from server (revisions 4, 3, 0)
      expect(coordinator.shouldApplySnapshot(4)).toBe(false);
      expect(coordinator.shouldApplySnapshot(3)).toBe(false);
      expect(coordinator.shouldApplySnapshot(0)).toBe(false);

      // Attempting to record older revisions does not cause regression
      coordinator.recordAppliedRevision(4);
      coordinator.recordAppliedRevision(2);
      coordinator.recordAppliedRevision(0);
      expect(coordinator.getLatestAppliedRevision()).toBe(5);

      // Duplicate response for revision 5 is also rejected
      expect(coordinator.shouldApplySnapshot(5)).toBe(false);
      coordinator.recordAppliedRevision(5);
      expect(coordinator.getLatestAppliedRevision()).toBe(5);

      // Strictly newer revision 6 is accepted and advances revision
      expect(coordinator.shouldApplySnapshot(6)).toBe(true);
      coordinator.recordAppliedRevision(6);
      expect(coordinator.getLatestAppliedRevision()).toBe(6);
    });
  });

  describe('Additional Monotonicity & Lifecycle Invariants', () => {
    it('allows subsequent calls after in-flight promise completes', async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        return makeSnap(callCount);
      });

      const coordinator = createNetworkSnapshotCoordinator(mockFetch);
      const snap1 = await coordinator.fetchSnapshot();
      const snap2 = await coordinator.fetchSnapshot();

      expect(callCount).toBe(2);
      expect(snap1.revision).toBe(1);
      expect(snap2.revision).toBe(2);
    });

    it('rejects stale or duplicate revisions from re-triggering application state', () => {
      const coordinator = createNetworkSnapshotCoordinator(vi.fn());
      coordinator.recordAppliedRevision(5);

      expect(coordinator.shouldApplySnapshot(4)).toBe(false); // Stale
      expect(coordinator.shouldApplySnapshot(5)).toBe(false); // Duplicate
      expect(coordinator.shouldApplySnapshot(6)).toBe(true);  // Strictly newer
    });

    it('enforces strict monotonicity invariant across arbitrary out-of-order sequences', () => {
      const coordinator = createNetworkSnapshotCoordinator(vi.fn());
      const arrivals = [1, 5, 3, 2, 6, 4, 7, 7, 8, 3];
      const appliedRevisions: number[] = [];

      for (const rev of arrivals) {
        if (coordinator.shouldApplySnapshot(rev)) {
          coordinator.recordAppliedRevision(rev);
          appliedRevisions.push(rev);
        }
      }

      // Only strictly increasing revisions are accepted
      expect(appliedRevisions).toEqual([1, 5, 6, 7, 8]);
      for (let i = 1; i < appliedRevisions.length; i++) {
        expect(appliedRevisions[i]).toBeGreaterThan(appliedRevisions[i - 1]);
      }
    });

    it('resets coordinator state back to initial uninitialized values', () => {
      const coordinator = createNetworkSnapshotCoordinator(vi.fn());
      coordinator.recordAppliedRevision(10);
      coordinator.recordObservedEventRevision(15);
      expect(coordinator.getLatestAppliedRevision()).toBe(10);
      expect(coordinator.getHighestObservedRevision()).toBe(15);

      coordinator.reset();
      expect(coordinator.getLatestAppliedRevision()).toBe(-1);
      expect(coordinator.getHighestObservedRevision()).toBe(-1);
      expect(coordinator.hasPendingNewerRevision()).toBe(false);
      expect(coordinator.shouldApplySnapshot(0)).toBe(true);
      expect(coordinator.shouldProcessSseEvent(0)).toBe(true);
    });
  });
});
