import { describe, it, expect } from 'vitest';
import {
  reconcileSelectedEdgeOnSnapshot,
  reconcileSelectedAreaOnSnapshot,
  reconcileSelectedNodeOnSnapshot,
  resolveWatcherStatusInfo,
} from '../statusInfo';
import { DependencyEdge, FileNode } from '../../types/graph';

const makeNode = (id: string, relative_path: string): FileNode => ({
  id,
  relative_path,
  filename: relative_path.split('/').pop() || id,
  language: 'typescript',
  size_bytes: 250,
  file_kind: 'Source',
  analysis_status: 'Analyzed',
  direct_dependency_count: 1,
  direct_dependent_count: 1,
});

const makeEdge = (
  id: string,
  source_file_id: string,
  target_file_id: string,
  overrides?: Partial<DependencyEdge>
): DependencyEdge => ({
  id,
  source_file_id,
  target_file_id,
  relationship_kind: 'Import',
  resolution_status: 'ResolvedInternal',
  evidence: [
    {
      source_file_id,
      import_specifier: `./${target_file_id}`,
      line: 10,
      column: 1,
      relationship_kind: 'Import',
      is_type_only: false,
    },
  ],
  ...overrides,
});

describe('Live Snapshot Reconciliation Helpers (statusInfo)', () => {
  describe('reconcileSelectedEdgeOnSnapshot', () => {
    it('preserves and updates the selected edge when it still exists in the new snapshot matching by authoritative ID', () => {
      const prevEdge = makeEdge('edge-a-b', 'file-a', 'file-b', {
        relationship_kind: 'Import',
      });

      const updatedEdgeInSnapshot = makeEdge('edge-a-b', 'file-a', 'file-b', {
        relationship_kind: 'TypeOnly',
        evidence: [
          {
            source_file_id: 'file-a',
            import_specifier: './file-b',
            line: 42,
            column: 5,
            relationship_kind: 'TypeOnly',
            is_type_only: true,
          },
        ],
      });

      const snapshotEdges = [
        makeEdge('edge-x-y', 'file-x', 'file-y'),
        updatedEdgeInSnapshot,
        makeEdge('edge-b-c', 'file-b', 'file-c'),
      ];

      const reconciled = reconcileSelectedEdgeOnSnapshot(prevEdge, snapshotEdges);

      expect(reconciled).not.toBeNull();
      expect(reconciled).toBe(updatedEdgeInSnapshot);
      expect(reconciled?.id).toBe('edge-a-b');
      expect(reconciled?.relationship_kind).toBe('TypeOnly');
      expect(reconciled?.evidence[0].line).toBe(42);
      expect(reconciled?.evidence[0].is_type_only).toBe(true);
    });

    it('preserves and updates the selected edge when edge ID is regenerated but source_file_id and target_file_id match', () => {
      // Edge ID regenerated across analysis passes (e.g., hash or revision-prefixed id)
      const prevEdge = makeEdge('rev1_edge_1', 'file-auth', 'file-db');

      const regeneratedEdgeInSnapshot = makeEdge('rev2_edge_99', 'file-auth', 'file-db', {
        resolution_status: 'ResolvedInternal',
        evidence: [
          {
            source_file_id: 'file-auth',
            import_specifier: '../db/client',
            line: 15,
            column: 8,
            relationship_kind: 'Import',
            is_type_only: false,
          },
        ],
      });

      const snapshotEdges = [
        makeEdge('rev2_edge_10', 'file-auth', 'file-config'),
        regeneratedEdgeInSnapshot,
      ];

      const reconciled = reconcileSelectedEdgeOnSnapshot(prevEdge, snapshotEdges);

      expect(reconciled).not.toBeNull();
      expect(reconciled).toBe(regeneratedEdgeInSnapshot);
      expect(reconciled?.id).toBe('rev2_edge_99');
      expect(reconciled?.source_file_id).toBe('file-auth');
      expect(reconciled?.target_file_id).toBe('file-db');
    });

    it('returns null when the import relationship was deleted in code between existing files', () => {
      const prevEdge = makeEdge('edge-a-b', 'file-a', 'file-b');

      // Both file-a and file-b exist in the repo, but the import from a to b was removed
      const snapshotEdges = [
        makeEdge('edge-a-c', 'file-a', 'file-c'),
        makeEdge('edge-b-d', 'file-b', 'file-d'),
      ];

      const reconciled = reconcileSelectedEdgeOnSnapshot(prevEdge, snapshotEdges);

      expect(reconciled).toBeNull();
    });

    it('returns null when the source file was deleted from disk', () => {
      const prevEdge = makeEdge('edge-deleted-target', 'deleted-service', 'target-file');

      // deleted-service is removed, so no outgoing edges from deleted-service exist
      const snapshotEdges = [
        makeEdge('edge-other-target', 'active-service', 'target-file'),
      ];

      const reconciled = reconcileSelectedEdgeOnSnapshot(prevEdge, snapshotEdges);

      expect(reconciled).toBeNull();
    });

    it('returns null when the target file was deleted from disk', () => {
      const prevEdge = makeEdge('edge-source-deleted', 'source-file', 'deleted-target');

      // deleted-target is removed, so no incoming edges to deleted-target exist
      const snapshotEdges = [
        makeEdge('edge-source-other', 'source-file', 'surviving-target'),
      ];

      const reconciled = reconcileSelectedEdgeOnSnapshot(prevEdge, snapshotEdges);

      expect(reconciled).toBeNull();
    });

    it('returns null when only one endpoint matches (does not falsely match partial endpoint pairs)', () => {
      const prevEdge = makeEdge('edge-a-b', 'file-a', 'file-b');

      // Has file-a as source, but target is file-c (not file-b)
      // Has file-c as source, and file-b as target (not file-a)
      const snapshotEdges = [
        makeEdge('edge-a-c', 'file-a', 'file-c'),
        makeEdge('edge-c-b', 'file-c', 'file-b'),
      ];

      const reconciled = reconcileSelectedEdgeOnSnapshot(prevEdge, snapshotEdges);

      expect(reconciled).toBeNull();
    });

    it('returns null safely when previous edge was null or new snapshot edges list is empty', () => {
      const edge = makeEdge('edge-1', 'a', 'b');

      expect(reconcileSelectedEdgeOnSnapshot(null, [edge])).toBeNull();
      expect(reconcileSelectedEdgeOnSnapshot(edge, [])).toBeNull();
      expect(reconcileSelectedEdgeOnSnapshot(null, [])).toBeNull();
    });
  });

  describe('reconcileSelectedAreaOnSnapshot', () => {
    it('preserves the area ID when files belonging to that area still exist in new snapshot nodes', () => {
      const selectedArea = 'src/components';

      const snapshotNodes = [
        makeNode('btn', 'src/components/Button.tsx'),
        makeNode('modal', 'src/components/Modal.tsx'),
        makeNode('util', 'src/utils/format.ts'),
      ];

      const reconciled = reconcileSelectedAreaOnSnapshot(selectedArea, snapshotNodes);

      expect(reconciled).toBe('src/components');
    });

    it('preserves the area ID when some files in the area are deleted but at least one remains', () => {
      const selectedArea = 'src/components';

      // Button.tsx was deleted; Modal.tsx is the sole survivor in src/components
      const snapshotNodes = [
        makeNode('modal', 'src/components/Modal.tsx'),
        makeNode('store', 'src/stores/appStore.ts'),
      ];

      const reconciled = reconcileSelectedAreaOnSnapshot(selectedArea, snapshotNodes);

      expect(reconciled).toBe('src/components');
    });

    it('preserves area ID across diverse directory structures (monorepo crates, nested fullstack, root)', () => {
      // 1. Monorepo crate workspace: crates/parser
      const crateNodes = [makeNode('parser-lib', 'crates/parser/src/lib.rs')];
      expect(reconcileSelectedAreaOnSnapshot('crates/parser', crateNodes)).toBe('crates/parser');

      // 2. Nested fullstack directory: frontend/src/transport
      const nestedNodes = [makeNode('status-info', 'frontend/src/transport/statusInfo.ts')];
      expect(reconcileSelectedAreaOnSnapshot('frontend/src/transport', nestedNodes)).toBe('frontend/src/transport');

      // 3. Root directory: (root)
      const rootNodes = [makeNode('pkg', 'package.json')];
      expect(reconcileSelectedAreaOnSnapshot('(root)', rootNodes)).toBe('(root)');

      // 4. Test directory: tests
      const testNodes = [makeNode('e2e-spec', 'tests/e2e/app.spec.ts')];
      expect(reconcileSelectedAreaOnSnapshot('tests', testNodes)).toBe('tests');
    });

    it('returns null when all files belonging to that area were deleted from the repository', () => {
      const selectedArea = 'src/legacy';

      // All files in src/legacy/* were deleted; only other areas remain
      const snapshotNodes = [
        makeNode('btn', 'src/components/Button.tsx'),
        makeNode('util', 'src/utils/format.ts'),
      ];

      const reconciled = reconcileSelectedAreaOnSnapshot(selectedArea, snapshotNodes);

      expect(reconciled).toBeNull();
    });

    it('returns null when all files in the area were moved or renamed to another directory', () => {
      const selectedArea = 'src/deprecated';

      // src/deprecated/oldUtil.ts was moved to src/utils/oldUtil.ts
      const snapshotNodes = [
        makeNode('moved-util', 'src/utils/oldUtil.ts'),
        makeNode('btn', 'src/components/Button.tsx'),
      ];

      const reconciled = reconcileSelectedAreaOnSnapshot(selectedArea, snapshotNodes);

      expect(reconciled).toBeNull();
    });

    it('returns null safely when previous area ID was null, unknown, or new snapshot nodes is empty', () => {
      const nodes = [makeNode('btn', 'src/components/Button.tsx')];

      expect(reconcileSelectedAreaOnSnapshot(null, nodes)).toBeNull();
      expect(reconcileSelectedAreaOnSnapshot('nonexistent/area', nodes)).toBeNull();
      expect(reconcileSelectedAreaOnSnapshot('src/components', [])).toBeNull();
      expect(reconcileSelectedAreaOnSnapshot(null, [])).toBeNull();
    });
  });

  describe('reconcileSelectedNodeOnSnapshot', () => {
    it('returns updated node reference when node still exists in new snapshot', () => {
      const prevNode = makeNode('node-1', 'src/app.ts');
      const updatedNode = { ...makeNode('node-1', 'src/app.ts'), direct_dependency_count: 5 };
      const snapshotNodes = [updatedNode, makeNode('node-2', 'src/util.ts')];

      const reconciled = reconcileSelectedNodeOnSnapshot(prevNode, snapshotNodes);

      expect(reconciled).toBe(updatedNode);
      expect(reconciled?.direct_dependency_count).toBe(5);
    });

    it('returns null when selected node was deleted in new snapshot', () => {
      const prevNode = makeNode('deleted-node', 'src/deleted.ts');
      const snapshotNodes = [makeNode('active-node', 'src/active.ts')];

      const reconciled = reconcileSelectedNodeOnSnapshot(prevNode, snapshotNodes);

      expect(reconciled).toBeNull();
    });

    it('returns null when prevSelectedNode is null', () => {
      const snapshotNodes = [makeNode('active-node', 'src/active.ts')];

      expect(reconcileSelectedNodeOnSnapshot(null, snapshotNodes)).toBeNull();
    });
  });

  describe('resolveWatcherStatusInfo', () => {
    it('handles watcher disabled (--no-watch)', () => {
      const info = resolveWatcherStatusInfo('disabled', 'connected', 5, false);
      expect(info.text).toBe('Watcher Disabled (--no-watch)');
      expect(info.color).toBe('#64748b');
      expect(info.pulse).toBe(false);
    });

    it('handles watcher degraded', () => {
      const info = resolveWatcherStatusInfo('degraded', 'connected', 5, false);
      expect(info.text).toBe('Watcher Degraded');
      expect(info.color).toBe('#f59e0b');
      expect(info.pulse).toBe(false);
    });

    it('handles sse connected at rev 0 vs rev > 0', () => {
      const infoRev0 = resolveWatcherStatusInfo('active', 'connected', 0, false);
      expect(infoRev0.text).toBe('Live Watcher Active');
      expect(infoRev0.pulse).toBe(true);

      const infoRev3 = resolveWatcherStatusInfo('active', 'connected', 3, false);
      expect(infoRev3.text).toBe('Live (rev 3)');
      expect(infoRev3.pulse).toBe(true);
    });

    it('handles reconnecting grace period vs delayed reconnecting', () => {
      // Reconnecting within grace period (< 2.0s): stays calm, no alarming banner
      const graceInfo = resolveWatcherStatusInfo('active', 'reconnecting', 5, false);
      expect(graceInfo.text).toBe('Live (rev 5)');
      expect(graceInfo.color).toBe('#2dd4bf');
      expect(graceInfo.pulse).toBe(false);

      // Reconnecting past grace period (>= 2.0s): informative restoring message
      const delayedInfo = resolveWatcherStatusInfo('active', 'reconnecting', 5, true);
      expect(delayedInfo.text).toBe('Restoring live updates — showing revision 5');
      expect(delayedInfo.color).toBe('#f59e0b');
      expect(delayedInfo.pulse).toBe(true);
    });

    it('handles terminal offline error', () => {
      const errorInfo = resolveWatcherStatusInfo('active', 'error', 7, false);
      expect(errorInfo.text).toBe('Live updates offline — graph remains available (rev 7)');
      expect(errorInfo.color).toBe('#f59e0b');
      expect(errorInfo.pulse).toBe(false);
    });
  });
});
