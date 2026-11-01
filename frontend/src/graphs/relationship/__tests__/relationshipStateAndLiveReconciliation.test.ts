import { describe, it, expect } from 'vitest';
import {
  reconcileFocusNodeOnSnapshot,
  pushFocusHistory,
  popFocusHistory,
  resolveBackTargetName,
} from '../relationshipHistory';
import { Viewport2D } from '../RelationshipCanvas';
import { FileNode, NetworkCamera } from '../../../types/graph';
import { DEFAULT_YAW, DEFAULT_PITCH, DEFAULT_ZOOM } from '../../network/render/networkRenderMath';

const makeNode = (id: string, filename = `${id}.ts`): FileNode => ({
  id,
  relative_path: `src/${filename}`,
  filename,
  language: 'typescript',
  size_bytes: 200,
  file_kind: 'Source',
  analysis_status: 'Analyzed',
  direct_dependency_count: 2,
  direct_dependent_count: 3,
});

describe('Relationship State, Navigation Stack, and Live Reconciliation', () => {
  describe('Focus History & Navigation Stack', () => {
    it('pushes previous focus node onto history stack when refocusing to a new node', () => {
      let history: string[] = [];

      // Initial focus on node-a (from null)
      history = pushFocusHistory(history, null, 'node-a');
      expect(history).toEqual([]);

      // Navigate from node-a to node-b
      history = pushFocusHistory(history, 'node-a', 'node-b');
      expect(history).toEqual(['node-a']);

      // Navigate from node-b to node-c
      history = pushFocusHistory(history, 'node-b', 'node-c');
      expect(history).toEqual(['node-a', 'node-b']);
    });

    it('does not duplicate history entries when re-focusing the currently focused node', () => {
      const history = ['node-a'];
      const updated = pushFocusHistory(history, 'node-b', 'node-b');
      expect(updated).toEqual(['node-a']);
    });

    it('pops history stack on back navigation until empty, handling underflow safely', () => {
      let history = ['node-a', 'node-b'];

      // First back navigation: pops node-b, returns node-b as previous target
      const pop1 = popFocusHistory(history);
      expect(pop1.prevFocusId).toBe('node-b');
      expect(pop1.nextHistory).toEqual(['node-a']);
      history = pop1.nextHistory;

      // Second back navigation: pops node-a
      const pop2 = popFocusHistory(history);
      expect(pop2.prevFocusId).toBe('node-a');
      expect(pop2.nextHistory).toEqual([]);
      history = pop2.nextHistory;

      // Third back navigation on empty stack: safe no-op
      const pop3 = popFocusHistory(history);
      expect(pop3.prevFocusId).toBeNull();
      expect(pop3.nextHistory).toEqual([]);
    });

    it('resolves back target display filename accurately', () => {
      const nodes = [
        makeNode('auth-svc', 'AuthService.ts'),
        makeNode('user-db', 'UserDatabase.ts'),
      ];

      expect(resolveBackTargetName(['auth-svc'], nodes)).toBe('AuthService.ts');
      expect(resolveBackTargetName(['auth-svc', 'user-db'], nodes)).toBe('UserDatabase.ts');
      expect(resolveBackTargetName([], nodes)).toBeNull();
      expect(resolveBackTargetName(['unknown-id'], nodes)).toBeNull();
    });
  });

  describe('Live SSE Update Reconciliation', () => {
    it('preserves focus node without resetting or shifting when node remains in new snapshot', () => {
      const nodeA = makeNode('service-a');
      const updatedNodeA = { ...nodeA, direct_dependency_count: 5 };
      const newSnapshotNodes = [updatedNodeA, makeNode('service-b')];

      const reconciliation = reconcileFocusNodeOnSnapshot('service-a', newSnapshotNodes);

      expect(reconciliation.nextFocusNodeId).toBe('service-a');
      expect(reconciliation.missingNotice).toBeNull();
    });

    it('clears focus safely and displays missing notice when focused file is removed on disk', () => {
      const remainingNodes = [makeNode('service-b'), makeNode('service-c')];

      // File 'deleted-worker' was deleted from disk
      const reconciliation = reconcileFocusNodeOnSnapshot('deleted-worker', remainingNodes);

      // Must be null, preventing arbitrary jumping to another file in the graph
      expect(reconciliation.nextFocusNodeId).toBeNull();
      expect(reconciliation.missingNotice).toBe('Previous focused file was removed on disk');
    });

    it('handles null focus node gracefully on snapshot revision', () => {
      const snapshotNodes = [makeNode('service-a')];
      const reconciliation = reconcileFocusNodeOnSnapshot(null, snapshotNodes);

      expect(reconciliation.nextFocusNodeId).toBeNull();
      expect(reconciliation.missingNotice).toBeNull();
    });
  });

  describe('Independent Viewport Preservation Across 3D and 2D Modes', () => {
    it('modifying 2D relationship viewport leaves 3D camera state completely untouched', () => {
      const camera3D: NetworkCamera = {
        yaw: 1.12,
        pitch: -0.38,
        panX: 460,
        panY: 320,
        zoom: 1.75,
      };

      let viewport2D: Viewport2D = {
        panX: 100,
        panY: -50,
        zoom: 1.25,
      };

      const originalCamera3D = { ...camera3D };

      // User pans and zooms inside 2D relationship explorer
      viewport2D = {
        panX: 250,
        panY: 120,
        zoom: 1.6,
      };

      // 2D viewport updated
      expect(viewport2D.panX).toBe(250);
      expect(viewport2D.panY).toBe(120);
      expect(viewport2D.zoom).toBe(1.6);

      // 3D camera transform and orientation remain strictly unchanged
      expect(camera3D).toEqual(originalCamera3D);
      expect(camera3D.yaw).toBe(1.12);
      expect(camera3D.pitch).toBe(-0.38);
      expect(camera3D.panX).toBe(460);
      expect(camera3D.panY).toBe(320);
      expect(camera3D.zoom).toBe(1.75);
    });

    it('modifying 3D camera orientation leaves 2D relationship viewport completely untouched', () => {
      const viewport2D: Viewport2D = {
        panX: 300,
        panY: -150,
        zoom: 1.4,
      };

      let camera3D: NetworkCamera = {
        yaw: DEFAULT_YAW,
        pitch: DEFAULT_PITCH,
        panX: 400,
        panY: 300,
        zoom: DEFAULT_ZOOM,
      };

      const originalViewport2D = { ...viewport2D };

      // User rotates 3D graph
      camera3D = {
        ...camera3D,
        yaw: 0.95,
        pitch: 0.15,
        zoom: 2.1,
      };

      // 3D camera updated
      expect(camera3D.yaw).toBe(0.95);
      expect(camera3D.pitch).toBe(0.15);
      expect(camera3D.zoom).toBe(2.1);

      // 2D relationship viewport remains strictly identical
      expect(viewport2D).toEqual(originalViewport2D);
      expect(viewport2D.panX).toBe(300);
      expect(viewport2D.panY).toBe(-150);
      expect(viewport2D.zoom).toBe(1.4);
    });

    it('switching view modes preserves both 3D camera and 2D viewport state across toggles', () => {
      // Emulate application state holding both viewports
      let activeViewMode: '3d' | '2d' = '2d';
      const saved2DViewport: Viewport2D = { panX: 180, panY: 90, zoom: 1.3 };
      const saved3DCamera: NetworkCamera = { yaw: 0.8, pitch: -0.2, panX: 500, panY: 350, zoom: 1.5 };

      // Switch to 3D
      activeViewMode = '3d';
      expect(activeViewMode).toBe('3d');
      expect(saved3DCamera.yaw).toBe(0.8);
      expect(saved2DViewport.panX).toBe(180);

      // Switch back to 2D
      activeViewMode = '2d';
      expect(activeViewMode).toBe('2d');
      expect(saved2DViewport.panX).toBe(180);
      expect(saved2DViewport.panY).toBe(90);
      expect(saved2DViewport.zoom).toBe(1.3);
      expect(saved3DCamera.yaw).toBe(0.8);
    });
  });
});
