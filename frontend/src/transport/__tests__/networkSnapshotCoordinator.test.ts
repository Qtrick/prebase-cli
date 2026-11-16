import { describe, it, expect, vi } from 'vitest';
import { createNetworkSnapshotCoordinator } from '../networkSnapshotCoordinator';
import { GraphSnapshot } from '../../types/graph';

const makeSnap = (rev: number): GraphSnapshot => ({
  schema_version: '1.0.0',
  repository_id: 'test-repo',
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

describe('NetworkSnapshotCoordinator Failure Recovery & Monotonicity', () => {
  describe('Coordinator Recovery When a Fetch Fails', () => {
    it('cleans up in-flight state on fetch failure allowing subsequent fetch to execute', async () => {
      let callCount = 0;
      let shouldFail = true;

      const mockFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (shouldFail) {
          throw new Error('503 Service Unavailable: indexing engine busy');
        }
        return makeSnap(1);
      });

      const coordinator = createNetworkSnapshotCoordinator(mockFetch);

      // First fetch fails
      await expect(coordinator.fetchSnapshot()).rejects.toThrow('503 Service Unavailable');
      expect(callCount).toBe(1);

      // Coordinator must not be locked in-flight; second fetch must execute
      shouldFail = false;
      const snap = await coordinator.fetchSnapshot();
      expect(callCount).toBe(2);
      expect(snap.revision).toBe(1);
    });
  });

  describe('Same-Revision Retry After Fetch Failure', () => {
    it('allows same-revision retry via shouldProcessSseEvent when previous fetch failed and revision was never applied', async () => {
      let callCount = 0;
      let shouldFail = true;

      const mockFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (shouldFail) {
          throw new Error('Transient network error');
        }
        return makeSnap(2);
      });

      const coordinator = createNetworkSnapshotCoordinator(mockFetch);

      // 1. Initial snapshot applied at revision 1
      coordinator.recordAppliedRevision(1);
      expect(coordinator.getLatestAppliedRevision()).toBe(1);

      // 2. SSE event for revision 2 arrives
      expect(coordinator.shouldProcessSseEvent(2)).toBe(true);
      coordinator.recordObservedEventRevision(2);
      expect(coordinator.getHighestObservedRevision()).toBe(2);

      // 3. Network fetch for revision 2 is triggered, but FAILS
      await expect(coordinator.fetchSnapshot()).rejects.toThrow('Transient network error');
      expect(callCount).toBe(1);

      // Crucial verification: Revision 2 was NEVER applied!
      expect(coordinator.getLatestAppliedRevision()).toBe(1);

      // 4. A second SSE event for revision 2 arrives (e.g. server repeat, SSE retry, or reconnect sync)
      // DEFECT: Currently, shouldProcessSseEvent(2) checks: revision > Math.max(latestAppliedRevision, highestObservedRevision)
      // Since highestObservedRevision is 2, 2 > 2 evaluates to false!
      // This causes the retry to be dropped as a duplicate, leaving the UI permanently stalled at revision 1!
      // A robust coordinator must allow processing the retry because revision 2 was never applied.
      expect(coordinator.shouldProcessSseEvent(2)).toBe(true);

      // 5. On retry, the fetch succeeds
      shouldFail = false;
      coordinator.recordObservedEventRevision(2);
      const snap = await coordinator.fetchSnapshot();
      expect(callCount).toBe(2);
      expect(snap.revision).toBe(2);

      // 6. Snapshot revision 2 is applied
      expect(coordinator.shouldApplySnapshot(2)).toBe(true);
      coordinator.recordAppliedRevision(2);
      expect(coordinator.getLatestAppliedRevision()).toBe(2);

      // 7. NOW duplicate revision 2 SSE events MUST be rejected (since it was successfully applied)
      expect(coordinator.shouldProcessSseEvent(2)).toBe(false);
      expect(coordinator.shouldApplySnapshot(2)).toBe(false);
    });

    it('supports multiple consecutive fetch failures before eventually succeeding on retry', async () => {
      let callCount = 0;
      let failCount = 2; // Fail twice, then succeed

      const mockFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (failCount > 0) {
          failCount--;
          throw new Error(`Connection reset attempt ${callCount}`);
        }
        return makeSnap(5);
      });

      const coordinator = createNetworkSnapshotCoordinator(mockFetch);
      coordinator.recordAppliedRevision(4);

      // Attempt 1: event 5 arrives, fetch fails
      expect(coordinator.shouldProcessSseEvent(5)).toBe(true);
      coordinator.recordObservedEventRevision(5);
      await expect(coordinator.fetchSnapshot()).rejects.toThrow('Connection reset attempt 1');
      expect(coordinator.getLatestAppliedRevision()).toBe(4);

      // Attempt 2: retry event 5 arrives, fetch fails again
      expect(coordinator.shouldProcessSseEvent(5)).toBe(true);
      coordinator.recordObservedEventRevision(5);
      await expect(coordinator.fetchSnapshot()).rejects.toThrow('Connection reset attempt 2');
      expect(coordinator.getLatestAppliedRevision()).toBe(4);

      // Attempt 3: retry event 5 arrives, fetch succeeds
      expect(coordinator.shouldProcessSseEvent(5)).toBe(true);
      coordinator.recordObservedEventRevision(5);
      const snap = await coordinator.fetchSnapshot();
      expect(snap.revision).toBe(5);

      coordinator.recordAppliedRevision(5);
      expect(coordinator.getLatestAppliedRevision()).toBe(5);

      // After successful application, subsequent event 5 is rejected
      expect(coordinator.shouldProcessSseEvent(5)).toBe(false);
    });
  });

  describe('Pending Newer Revisions When Stale Snapshot is Rejected', () => {
    it('preserves pending newer revision flag when a stale snapshot is rejected by shouldApplySnapshot', () => {
      const coordinator = createNetworkSnapshotCoordinator(vi.fn());

      // 1. Client has applied revision 3
      coordinator.recordAppliedRevision(3);
      expect(coordinator.getLatestAppliedRevision()).toBe(3);

      // 2. High revision 5 is observed via SSE while older responses are in transit
      expect(coordinator.shouldProcessSseEvent(5)).toBe(true);
      coordinator.recordObservedEventRevision(5);
      expect(coordinator.getHighestObservedRevision()).toBe(5);
      expect(coordinator.hasPendingNewerRevision()).toBe(true);

      // 3. Stale snapshot revision 2 arrives (e.g. out-of-order response)
      const shouldApplyStale = coordinator.shouldApplySnapshot(2);
      expect(shouldApplyStale).toBe(false);

      // DEFECT CHECK: In App.tsx, the trailing fetch check:
      //   if (coordinator.hasPendingNewerRevision()) { ... }
      // is located INSIDE the `if (coordinator.shouldApplySnapshot(newSnap.revision))` block!
      // When a snapshot is rejected as stale (shouldApplyStale === false), the trailing fetch
      // for revision 5 is completely skipped!
      // Here we verify that coordinator.hasPendingNewerRevision() remains true despite the stale snapshot:
      expect(coordinator.hasPendingNewerRevision()).toBe(true);
      expect(coordinator.getLatestAppliedRevision()).toBe(3);
      expect(coordinator.getHighestObservedRevision()).toBe(5);
    });

    it('simulates application handler pattern: stale snapshot must trigger follow-up fetch for pending newer revisions', async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        return makeSnap(5);
      });

      const coordinator = createNetworkSnapshotCoordinator(mockFetch);
      coordinator.recordAppliedRevision(3);

      // Newer revision 5 observed
      coordinator.recordObservedEventRevision(5);
      expect(coordinator.hasPendingNewerRevision()).toBe(true);

      // Stale snapshot 2 arrives
      const incomingSnap = makeSnap(2);
      let followUpTriggered = false;

      // Behavioral simulation of snapshot handler:
      // If snapshot is stale, we must NOT apply it, BUT if hasPendingNewerRevision is true,
      // a follow-up fetch MUST still be initiated!
      const handleSnapshot = async (snap: GraphSnapshot) => {
        if (coordinator.shouldApplySnapshot(snap.revision)) {
          coordinator.recordAppliedRevision(snap.revision);
        }
        // Correct pattern: check hasPendingNewerRevision regardless of whether the stale snapshot was applied
        if (coordinator.hasPendingNewerRevision()) {
          followUpTriggered = true;
          const newer = await coordinator.fetchSnapshot();
          if (coordinator.shouldApplySnapshot(newer.revision)) {
            coordinator.recordAppliedRevision(newer.revision);
          }
        }
      };

      await handleSnapshot(incomingSnap);

      expect(followUpTriggered).toBe(true);
      expect(callCount).toBe(1);
      expect(coordinator.getLatestAppliedRevision()).toBe(5);
      expect(coordinator.hasPendingNewerRevision()).toBe(false);
    });

    it('demonstrates App.tsx nesting defect: placing hasPendingNewerRevision inside shouldApplySnapshot skips pending recovery', async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        return makeSnap(5);
      });

      const coordinator = createNetworkSnapshotCoordinator(mockFetch);
      coordinator.recordAppliedRevision(3);
      coordinator.recordObservedEventRevision(5);
      expect(coordinator.hasPendingNewerRevision()).toBe(true);

      // Flawed pattern in current App.tsx:
      let flawedFollowUpTriggered = false;
      const flawedApplySnapshot = (snap: GraphSnapshot) => {
        if (coordinator.shouldApplySnapshot(snap.revision)) {
          coordinator.recordAppliedRevision(snap.revision);
          // DEFECT: Nested inside shouldApplySnapshot block!
          if (coordinator.hasPendingNewerRevision()) {
            flawedFollowUpTriggered = true;
            coordinator.fetchSnapshot();
          }
        }
      };

      // Stale revision 2 arrives
      flawedApplySnapshot(makeSnap(2));
      // Stale revision was rejected, so the nested check NEVER ran!
      expect(flawedFollowUpTriggered).toBe(false);
      expect(callCount).toBe(0);
      expect(coordinator.hasPendingNewerRevision()).toBe(true); // Still pending revision 5, but abandoned!

      // Corrected pattern: check hasPendingNewerRevision regardless of whether current snap was applied
      let correctedFollowUpTriggered = false;
      const correctedApplySnapshot = async (snap: GraphSnapshot) => {
        if (coordinator.shouldApplySnapshot(snap.revision)) {
          coordinator.recordAppliedRevision(snap.revision);
        }
        if (coordinator.hasPendingNewerRevision()) {
          correctedFollowUpTriggered = true;
          const newer = await coordinator.fetchSnapshot();
          if (coordinator.shouldApplySnapshot(newer.revision)) {
            coordinator.recordAppliedRevision(newer.revision);
          }
        }
      };

      await correctedApplySnapshot(makeSnap(2));
      expect(correctedFollowUpTriggered).toBe(true);
      expect(callCount).toBe(1);
      expect(coordinator.getLatestAppliedRevision()).toBe(5);
      expect(coordinator.hasPendingNewerRevision()).toBe(false);
    });

    it('does not trigger follow-up fetch when stale snapshot arrives and no newer revisions are pending', async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        return makeSnap(3);
      });

      const coordinator = createNetworkSnapshotCoordinator(mockFetch);
      coordinator.recordAppliedRevision(3);
      // No newer revision observed; highest observed is 3
      expect(coordinator.hasPendingNewerRevision()).toBe(false);

      let followUpTriggered = false;
      const handleSnapshot = async (snap: GraphSnapshot) => {
        if (coordinator.shouldApplySnapshot(snap.revision)) {
          coordinator.recordAppliedRevision(snap.revision);
        }
        if (coordinator.hasPendingNewerRevision()) {
          followUpTriggered = true;
          await coordinator.fetchSnapshot();
        }
      };

      // Stale revision 1 arrives
      await handleSnapshot(makeSnap(1));

      expect(followUpTriggered).toBe(false);
      expect(callCount).toBe(0);
      expect(coordinator.getLatestAppliedRevision()).toBe(3);
    });
  });

  describe('Monotonicity Across Interleaved Failures and Newer Revisions', () => {
    it('accepts newer revision even if an earlier revision failed and was never applied', async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Revision 2 fetch failed');
        }
        return makeSnap(3);
      });

      const coordinator = createNetworkSnapshotCoordinator(mockFetch);
      coordinator.recordAppliedRevision(1);

      // Revision 2 arrives and fails
      expect(coordinator.shouldProcessSseEvent(2)).toBe(true);
      coordinator.recordObservedEventRevision(2);
      await expect(coordinator.fetchSnapshot()).rejects.toThrow('Revision 2 fetch failed');
      expect(coordinator.getLatestAppliedRevision()).toBe(1);

      // Now revision 3 arrives
      expect(coordinator.shouldProcessSseEvent(3)).toBe(true);
      coordinator.recordObservedEventRevision(3);

      const snap3 = await coordinator.fetchSnapshot();
      expect(snap3.revision).toBe(3);
      expect(coordinator.shouldApplySnapshot(3)).toBe(true);
      coordinator.recordAppliedRevision(3);
      expect(coordinator.getLatestAppliedRevision()).toBe(3);

      // Now if an old delayed retry for revision 2 arrives, it must be rejected
      expect(coordinator.shouldProcessSseEvent(2)).toBe(false);
      expect(coordinator.shouldApplySnapshot(2)).toBe(false);
    });
  });

  describe('Defect A: Obsolete requests do not mutate reset coordinator state', () => {
    it('prevents an in-flight request from an old generation from corrupting a reset coordinator', async () => {
      let rejectOldFetch!: (err: Error) => void;
      const oldPromise = new Promise<GraphSnapshot>((_, reject) => {
        rejectOldFetch = reject;
      });

      let fetchCall = 0;
      const mockFetch = vi.fn().mockImplementation(() => {
        fetchCall++;
        if (fetchCall === 1) return oldPromise;
        return Promise.resolve(makeSnap(2));
      });

      const coordinator = createNetworkSnapshotCoordinator(mockFetch);

      // Generation 1: observes rev 8, fetch begins
      coordinator.recordObservedEventRevision(8);
      const inflight1 = coordinator.fetchSnapshot();
      inflight1.catch(() => {}); // catch unhandled rejection

      // Reset coordinator (e.g. unmount or re-initialization)
      coordinator.reset();
      expect(coordinator.getLatestAppliedRevision()).toBe(-1);
      expect(coordinator.getHighestObservedRevision()).toBe(-1);

      // Generation 2: starts fresh, observes rev 2
      coordinator.recordObservedEventRevision(2);
      expect(coordinator.getHighestObservedRevision()).toBe(2);

      // Old generation 1 fetch now rejects with an error
      rejectOldFetch(new Error('Network 503 from old generation'));
      await expect(inflight1).rejects.toThrow('Network 503 from old generation');

      // The old failure must NOT have assigned failedRevision = 2 in the new generation!
      // In particular, duplicate revision 2 event should NOT be granted false retry if revision 2 wasn't fetched yet.
      // And when generation 2 fetches revision 2:
      const snap2 = await coordinator.fetchSnapshot();
      expect(snap2.revision).toBe(2);
      coordinator.recordAppliedRevision(2);
      expect(coordinator.getLatestAppliedRevision()).toBe(2);
      expect(coordinator.hasPendingNewerRevision()).toBe(false);
    });

    it('prevents late success of an old generation request from clearing newer failure tracking', async () => {
      let resolveOldFetch!: (snap: GraphSnapshot) => void;
      const oldPromise = new Promise<GraphSnapshot>((resolve) => {
        resolveOldFetch = resolve;
      });

      let fetchCall = 0;
      const mockFetch = vi.fn().mockImplementation(() => {
        fetchCall++;
        if (fetchCall === 1) return oldPromise;
        return Promise.reject(new Error('Gen 2 fetch failed'));
      });

      const coordinator = createNetworkSnapshotCoordinator(mockFetch);
      const inflight1 = coordinator.fetchSnapshot();

      // Reset
      coordinator.reset();

      // Generation 2 observes revision 3 and fails
      coordinator.recordObservedEventRevision(3);
      await expect(coordinator.fetchSnapshot()).rejects.toThrow('Gen 2 fetch failed');
      expect(coordinator.shouldProcessSseEvent(3)).toBe(true); // retry allowed

      // Old generation 1 resolves successfully
      resolveOldFetch(makeSnap(1));
      await inflight1;

      // Old success must NOT clear Generation 2's failedRevision!
      expect(coordinator.shouldProcessSseEvent(3)).toBe(true);
    });
  });

  describe('Defect B: Stale successful responses do not suppress retry eligibility', () => {
    it('preserves retry eligibility when a fetch returns an older revision than observed', async () => {
      let fetchCall = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        fetchCall++;
        if (fetchCall === 1) {
          // Server returned stale rev 1 even though rev 3 was announced
          return makeSnap(1);
        }
        return makeSnap(3);
      });

      const coordinator = createNetworkSnapshotCoordinator(mockFetch);

      // Latest applied is 1
      coordinator.recordAppliedRevision(1);
      expect(coordinator.getLatestAppliedRevision()).toBe(1);

      // Revision 3 is announced
      expect(coordinator.shouldProcessSseEvent(3)).toBe(true);
      coordinator.recordObservedEventRevision(3);
      expect(coordinator.getHighestObservedRevision()).toBe(3);

      // Fetch executes, but HTTP 200 returns rev 1 (stale snapshot)
      const snap1 = await coordinator.fetchSnapshot();
      expect(snap1.revision).toBe(1);

      // Stale rev 1 is NOT applied (not > latestAppliedRevision)
      expect(coordinator.shouldApplySnapshot(snap1.revision)).toBe(false);

      // Crucial assertion: hasPendingNewerRevision() remains true!
      expect(coordinator.hasPendingNewerRevision()).toBe(true);

      // Crucial Defect B assertion: shouldProcessSseEvent(3) MUST return true!
      // In the broken implementation, failedRevision was cleared to -1 by snap1,
      // so shouldProcessSseEvent(3) returned false and stranded revision 3 forever.
      expect(coordinator.shouldProcessSseEvent(3)).toBe(true);

      // Next fetch returns revision 3
      const snap3 = await coordinator.fetchSnapshot();
      expect(snap3.revision).toBe(3);
      expect(coordinator.shouldApplySnapshot(3)).toBe(true);
      coordinator.recordAppliedRevision(3);
      expect(coordinator.getLatestAppliedRevision()).toBe(3);
      expect(coordinator.hasPendingNewerRevision()).toBe(false);
      expect(coordinator.shouldProcessSseEvent(3)).toBe(false);
    });
  });

  describe('isConverged() semantics', () => {
    it('accurately tracks convergence state across observed and applied revisions', () => {
      const coordinator = createNetworkSnapshotCoordinator(async () => makeSnap(1));

      // Initially at (-1, -1): converged
      expect(coordinator.isConverged()).toBe(true);

      // Revision 1 observed from SSE: not converged
      coordinator.recordObservedEventRevision(1);
      expect(coordinator.isConverged()).toBe(false);
      expect(coordinator.hasPendingNewerRevision()).toBe(true);

      // Revision 1 applied: converged
      coordinator.recordAppliedRevision(1);
      expect(coordinator.isConverged()).toBe(true);
      expect(coordinator.hasPendingNewerRevision()).toBe(false);

      // Revision 2 observed: not converged
      coordinator.recordObservedEventRevision(2);
      expect(coordinator.isConverged()).toBe(false);

      // Revision 3 observed: not converged
      coordinator.recordObservedEventRevision(3);
      expect(coordinator.isConverged()).toBe(false);

      // Revision 3 applied: converged directly
      coordinator.recordAppliedRevision(3);
      expect(coordinator.isConverged()).toBe(true);
      expect(coordinator.hasPendingNewerRevision()).toBe(false);
    });
  });
});
