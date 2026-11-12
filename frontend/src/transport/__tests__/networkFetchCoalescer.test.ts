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
  it('coalesces multiple rapid requests into a single in-flight network call', async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return makeSnap(1);
    });

    const coordinator = createNetworkSnapshotCoordinator(mockFetch);

    // Trigger 3 simultaneous calls
    const [snap1, snap2, snap3] = await Promise.all([
      coordinator.fetchSnapshot(),
      coordinator.fetchSnapshot(),
      coordinator.fetchSnapshot(),
    ]);

    expect(callCount).toBe(1);
    expect(snap1.revision).toBe(1);
    expect(snap2.revision).toBe(1);
    expect(snap3.revision).toBe(1);
  });

  it('rejects stale or duplicate revisions from re-triggering application state', () => {
    const coordinator = createNetworkSnapshotCoordinator(vi.fn());
    coordinator.recordAppliedRevision(5);

    expect(coordinator.shouldApplySnapshot(4)).toBe(false); // Stale
    expect(coordinator.shouldApplySnapshot(5)).toBe(false); // Duplicate
    expect(coordinator.shouldApplySnapshot(6)).toBe(true);  // Strictly newer
  });

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

  describe('Finding F: SSE event coalescing and snapshot revision monotonicity', () => {
    it('drops out-of-order SSE notifications to prevent redundant network requests', () => {
      const coordinator = createNetworkSnapshotCoordinator(vi.fn());

      // Event rev 3 arrives first
      expect(coordinator.shouldProcessSseEvent(3)).toBe(true);
      coordinator.recordObservedEventRevision(3);

      // Out-of-order event rev 2 arrives second (delayed in network)
      expect(coordinator.shouldProcessSseEvent(2)).toBe(false); // Must be dropped!

      // Event rev 4 arrives later
      expect(coordinator.shouldProcessSseEvent(4)).toBe(true);
      coordinator.recordObservedEventRevision(4);

      // Duplicate event rev 4 arrives
      expect(coordinator.shouldProcessSseEvent(4)).toBe(false);
    });

    it('rejects out-of-order snapshot responses when a newer revision was already applied', () => {
      const coordinator = createNetworkSnapshotCoordinator(vi.fn());

      // Client applied revision 3
      coordinator.recordAppliedRevision(3);
      expect(coordinator.getLatestAppliedRevision()).toBe(3);

      // Delayed network response for revision 2 arrives
      expect(coordinator.shouldApplySnapshot(2)).toBe(false);
      // State revision must not regress
      expect(coordinator.getLatestAppliedRevision()).toBe(3);

      // Newer network response for revision 4 arrives
      expect(coordinator.shouldApplySnapshot(4)).toBe(true);
      coordinator.recordAppliedRevision(4);
      expect(coordinator.getLatestAppliedRevision()).toBe(4);
    });

    it('coalesces rapid burst of SSE events during an active network fetch', async () => {
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
        return makeSnap(5);
      });

      const coordinator = createNetworkSnapshotCoordinator(mockFetch);

      // 1. Initial event arrives for revision 2 -> triggers in-flight fetch
      const fetch1 = coordinator.fetchSnapshot();
      expect(callCount).toBe(1);

      // 2. Rapid burst of SSE notifications arrive while fetch 1 is in-flight: rev 3, 4, 5
      const burstRevisions = [3, 4, 5];
      const fetchPromises = burstRevisions.map((rev) => {
        if (coordinator.shouldProcessSseEvent(rev)) {
          coordinator.recordObservedEventRevision(rev);
        }
        // In-flight coalescing ensures subsequent fetchSnapshot() calls share the active promise
        return coordinator.fetchSnapshot();
      });

      // No additional network calls were launched during the in-flight period
      expect(callCount).toBe(1);

      // 3. Complete first fetch with revision 2
      resolveFirstCall!(makeSnap(2));
      const [snap1, ...burstSnaps] = await Promise.all([fetch1, ...fetchPromises]);

      expect(snap1.revision).toBe(2);
      burstSnaps.forEach((s) => expect(s.revision).toBe(2));

      // After in-flight fetch settles, coordinator applied revision 2
      coordinator.recordAppliedRevision(2);

      // 4. Follow-up fetch for coalesced latest revision (5) executes cleanly as exactly one call
      const snapFinal = await coordinator.fetchSnapshot();
      expect(callCount).toBe(2);
      expect(snapFinal.revision).toBe(5);
      expect(coordinator.shouldApplySnapshot(snapFinal.revision)).toBe(true);
      coordinator.recordAppliedRevision(snapFinal.revision);
      expect(coordinator.getLatestAppliedRevision()).toBe(5);
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
  });
});
