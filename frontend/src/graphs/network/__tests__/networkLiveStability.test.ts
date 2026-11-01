import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  processSnapshotRevision,
  SnapshotRevisionState,
} from '../layout/snapshotRevision';
import {
  resolveWatcherStatusInfo,
  reconcileSelectedNodeOnSnapshot,
} from '../../../transport/statusInfo';
import {
  FileNode,
  GraphSnapshot,
  NetworkCamera,
} from '../../../types/graph';
import { DEFAULT_YAW, DEFAULT_PITCH } from '../render/networkRenderMath';

const makeNode = (id: string, deps = 1): FileNode => ({
  id,
  relative_path: `${id}.ts`,
  filename: `${id}.ts`,
  language: 'typescript',
  size_bytes: 200,
  file_kind: 'Source',
  analysis_status: 'Analyzed',
  direct_dependency_count: deps,
  direct_dependent_count: deps,
});

const makeSnapshot = (
  repository_id: string,
  revision: number,
  nodeIds: string[]
): GraphSnapshot => ({
  schema_version: '1.0.0',
  repository_id,
  revision,
  nodes: nodeIds.map((id) => makeNode(id)),
  edges: nodeIds.slice(1).map((id, idx) => ({
    id: `${nodeIds[idx]}->${id}`,
    source_file_id: nodeIds[idx],
    target_file_id: id,
    relationship_kind: 'Import',
    resolution_status: 'ResolvedInternal',
    evidence: [],
  })),
  coverage: {
    total_discovered: nodeIds.length,
    total_analyzed: nodeIds.length,
    total_excluded: 0,
    total_issues: 0,
    is_complete: true,
  },
  issues: [],
});

describe('Live Snapshot Stability and SSE Status', () => {
  const viewport = {
    width: 800,
    height: 600,
    insets: { top: 64, bottom: 20, left: 20, right: 20 },
  };

  describe('Snapshot Revision and Camera Stability', () => {
    it('same-repository revision preserves camera state (yaw, pitch, pan, zoom)', () => {
      const snap1 = makeSnapshot('repo-1', 1, ['a', 'b', 'c']);
      const initResult = processSnapshotRevision(
        { repositoryId: null, positions: new Map(), camera: { yaw: DEFAULT_YAW, pitch: DEFAULT_PITCH, panX: 0, panY: 0, zoom: 1 } },
        snap1,
        viewport
      );

      // User customizes camera during live session
      const customCamera: NetworkCamera = {
        yaw: 0.92,
        pitch: -0.25,
        panX: 475,
        panY: 315,
        zoom: 1.85,
      };

      const currentState: SnapshotRevisionState = {
        repositoryId: 'repo-1',
        positions: initResult.state.positions,
        camera: customCamera,
      };

      // Live update rev 2 arrives for the same repository
      const snap2 = makeSnapshot('repo-1', 2, ['a', 'b', 'c', 'd']);
      const revResult = processSnapshotRevision(currentState, snap2, viewport);

      expect(revResult.didTriggerInitialFit).toBe(false);
      expect(revResult.state.camera).toEqual(customCamera);
      expect(revResult.state.camera.yaw).toBe(0.92);
      expect(revResult.state.camera.pitch).toBe(-0.25);
      expect(revResult.state.camera.panX).toBe(475);
      expect(revResult.state.camera.panY).toBe(315);
      expect(revResult.state.camera.zoom).toBe(1.85);
    });

    it('existing node world positions are preserved on new revision', () => {
      const snap1 = makeSnapshot('repo-stable', 1, ['auth', 'db', 'router']);
      const initResult = processSnapshotRevision(
        { repositoryId: null, positions: new Map(), camera: { yaw: DEFAULT_YAW, pitch: DEFAULT_PITCH, panX: 0, panY: 0, zoom: 1 } },
        snap1,
        viewport
      );

      const posAuth1 = initResult.state.positions.get('auth')!;
      const posDb1 = initResult.state.positions.get('db')!;
      const posRouter1 = initResult.state.positions.get('router')!;

      // Ordinary revision adds a new node
      const snap2 = makeSnapshot('repo-stable', 2, ['auth', 'db', 'router', 'cache']);
      const revResult = processSnapshotRevision(initResult.state, snap2, viewport);

      const posAuth2 = revResult.state.positions.get('auth')!;
      const posDb2 = revResult.state.positions.get('db')!;
      const posRouter2 = revResult.state.positions.get('router')!;
      const posCache2 = revResult.state.positions.get('cache');

      expect(posCache2).toBeDefined();
      // Incremental stability: existing node positions are preserved without layout thrashing
      expect(Math.hypot(posAuth2.x - posAuth1.x, posAuth2.y - posAuth1.y)).toBeLessThan(2.0);
      expect(Math.hypot(posDb2.x - posDb1.x, posDb2.y - posDb1.y)).toBeLessThan(2.0);
      expect(Math.hypot(posRouter2.x - posRouter1.x, posRouter2.y - posRouter1.y)).toBeLessThan(2.0);
    });

    it('selected node is preserved across snapshot revisions if it still exists in the new snapshot', () => {
      const nodeA = makeNode('service-a', 2);
      const updatedNodeA = makeNode('service-a', 5); // metadata updated in new revision
      const newSnapshotNodes = [updatedNodeA, makeNode('service-b')];

      const reconciled = reconcileSelectedNodeOnSnapshot(nodeA, newSnapshotNodes);
      expect(reconciled).not.toBeNull();
      expect(reconciled?.id).toBe('service-a');
      expect(reconciled?.direct_dependency_count).toBe(5);
      expect(reconciled).toBe(updatedNodeA);
    });

    it('deleted selected node is cleared safely (becomes null) if missing from the new revision', () => {
      const deletedNode = makeNode('obsolete-worker');
      const newSnapshotNodes = [makeNode('service-a'), makeNode('service-b')];

      const reconciled = reconcileSelectedNodeOnSnapshot(deletedNode, newSnapshotNodes);
      expect(reconciled).toBeNull();
    });

    it('no automatic fit view occurs on ordinary revision of the same repository', () => {
      const snap1 = makeSnapshot('repo-main', 1, ['a', 'b']);
      const initResult = processSnapshotRevision(
        { repositoryId: null, positions: new Map(), camera: { yaw: DEFAULT_YAW, pitch: DEFAULT_PITCH, panX: 0, panY: 0, zoom: 1 } },
        snap1,
        viewport
      );

      const zoomedCamera: NetworkCamera = {
        yaw: 0.6,
        pitch: 0.3,
        panX: 550,
        panY: 380,
        zoom: 3.1,
      };

      const snap2 = makeSnapshot('repo-main', 2, ['a', 'b']);
      const revResult = processSnapshotRevision(
        { ...initResult.state, camera: zoomedCamera },
        snap2,
        viewport
      );

      expect(revResult.didTriggerInitialFit).toBe(false);
      expect(revResult.state.camera.zoom).toBe(3.1);
    });

    it('different repository ID triggers initial fit view', () => {
      const snapRepo1 = makeSnapshot('repo-1', 1, ['a', 'b']);
      const init1 = processSnapshotRevision(
        { repositoryId: null, positions: new Map(), camera: { yaw: DEFAULT_YAW, pitch: DEFAULT_PITCH, panX: 0, panY: 0, zoom: 1 } },
        snapRepo1,
        viewport
      );

      // Mutate camera away from initial fit
      const mutatedCamera: NetworkCamera = {
        yaw: 1.2,
        pitch: -0.5,
        panX: 999,
        panY: 888,
        zoom: 3.5,
      };

      // Switch to an entirely different repository
      const snapRepo2 = makeSnapshot('repo-2', 1, ['x', 'y', 'z']);
      const switchResult = processSnapshotRevision(
        { repositoryId: 'repo-1', positions: init1.state.positions, camera: mutatedCamera },
        snapRepo2,
        viewport
      );

      expect(switchResult.didTriggerInitialFit).toBe(true);
      expect(switchResult.state.repositoryId).toBe('repo-2');
      // Resets orientation to standard default yaw and pitch on repo switch
      expect(switchResult.state.camera.yaw).toBe(DEFAULT_YAW);
      expect(switchResult.state.camera.pitch).toBe(DEFAULT_PITCH);
      // Zoom is fitted to viewport bounding box, not the previous 3.5
      expect(switchResult.state.camera.zoom).not.toBe(3.5);
    });

    it('empty positions triggers initial fit view even if repositoryId matches', () => {
      const snap = makeSnapshot('repo-reinit', 1, ['root', 'child']);
      const result = processSnapshotRevision(
        { repositoryId: 'repo-reinit', positions: new Map(), camera: { yaw: DEFAULT_YAW, pitch: DEFAULT_PITCH, panX: 0, panY: 0, zoom: 1 } },
        snap,
        viewport
      );
      expect(result.didTriggerInitialFit).toBe(true);
      expect(result.state.positions.size).toBe(2);
    });
  });

  describe('SSE Connection Status Transitions and Grace Period', () => {
    it('Connected & Active watcher -> "Live" / "Live Watcher Active"', () => {
      const initialStatus = resolveWatcherStatusInfo('active', 'connected', 0, false);
      expect(initialStatus.text).toBe('Live Watcher Active');
      expect(initialStatus.color).toBe('#2dd4bf');
      expect(initialStatus.pulse).toBe(true);

      const liveStatus = resolveWatcherStatusInfo('active', 'connected', 14, false);
      expect(liveStatus.text).toBe('Live (rev 14)');
      expect(liveStatus.color).toBe('#2dd4bf');
      expect(liveStatus.pulse).toBe(true);
    });

    it('SSE error/reconnecting: during grace period (<2s), does not display permanent failure or disconnect watcher', () => {
      // isDelayedReconnecting is false during grace period
      const graceStatus = resolveWatcherStatusInfo('active', 'reconnecting', 14, false);
      expect(graceStatus.text).toBe('Live (rev 14)');
      expect(graceStatus.color).toBe('#2dd4bf');
      expect(graceStatus.pulse).toBe(false); // subtle pulse pause, no alarming error banner
    });

    it('SSE reconnecting after grace period (>2s) -> "Restoring live updates — showing revision X"', () => {
      // isDelayedReconnecting is true after 2.0s elapsed
      const delayedStatus = resolveWatcherStatusInfo('active', 'reconnecting', 14, true);
      expect(delayedStatus.text).toBe('Restoring live updates — showing revision 14');
      expect(delayedStatus.color).toBe('#f59e0b');
      expect(delayedStatus.pulse).toBe(true);
    });

    it('SSE offline/error -> "Live updates offline — graph remains available (rev X)"', () => {
      const offlineStatus = resolveWatcherStatusInfo('active', 'error', 14, false);
      expect(offlineStatus.text).toBe('Live updates offline — graph remains available (rev 14)');
      expect(offlineStatus.color).toBe('#f59e0b');
      expect(offlineStatus.pulse).toBe(false);

      const offlineNoRev = resolveWatcherStatusInfo('active', 'error', 0, false);
      expect(offlineNoRev.text).toBe('Live updates offline — graph remains available');
    });

    it('Watcher disabled -> "Watcher Disabled (--no-watch)"', () => {
      const disabledStatus = resolveWatcherStatusInfo('disabled', 'connected', 14, false);
      expect(disabledStatus.text).toBe('Watcher Disabled (--no-watch)');
      expect(disabledStatus.color).toBe('#64748b');
      expect(disabledStatus.pulse).toBe(false);
    });

    it('Watcher degraded -> "Watcher Degraded"', () => {
      const degradedStatus = resolveWatcherStatusInfo('degraded', 'connected', 14, false);
      expect(degradedStatus.text).toBe('Watcher Degraded');
      expect(degradedStatus.color).toBe('#f59e0b');
      expect(degradedStatus.pulse).toBe(false);
    });

    describe('Grace Period 2000ms Timer Transitions', () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('transitions isDelayedReconnecting precisely at 2000ms boundary', () => {
        let isDelayedReconnecting = false;
        let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

        const onSseStateChange = (state: 'connected' | 'reconnecting' | 'error') => {
          if (state === 'reconnecting') {
            reconnectTimer = setTimeout(() => {
              isDelayedReconnecting = true;
            }, 2000);
          } else {
            if (reconnectTimer) {
              clearTimeout(reconnectTimer);
              reconnectTimer = null;
            }
            isDelayedReconnecting = false;
          }
        };

        // 1. Reconnection event starts
        onSseStateChange('reconnecting');
        expect(isDelayedReconnecting).toBe(false);
        expect(resolveWatcherStatusInfo('active', 'reconnecting', 8, isDelayedReconnecting).text).toBe(
          'Live (rev 8)'
        );

        // 2. Advance 1999ms (still inside grace period)
        vi.advanceTimersByTime(1999);
        expect(isDelayedReconnecting).toBe(false);
        expect(resolveWatcherStatusInfo('active', 'reconnecting', 8, isDelayedReconnecting).text).toBe(
          'Live (rev 8)'
        );

        // 3. Reach 2000ms boundary
        vi.advanceTimersByTime(1);
        expect(isDelayedReconnecting).toBe(true);
        expect(resolveWatcherStatusInfo('active', 'reconnecting', 8, isDelayedReconnecting).text).toBe(
          'Restoring live updates — showing revision 8'
        );

        // 4. Connection restored before permanent failure
        onSseStateChange('connected');
        expect(isDelayedReconnecting).toBe(false);
        expect(resolveWatcherStatusInfo('active', 'connected', 8, isDelayedReconnecting).text).toBe(
          'Live (rev 8)'
        );
      });
    });
  });
});
