import { describe, it, expect } from 'vitest';
import {
  reconcileFocusHistoryOnSnapshot,
  popFocusHistory,
  resolveBackTargetName,
} from '../relationshipHistory';
import { FileNode } from '../../../types/graph';

const makeNode = (id: string, filename: string): FileNode => ({
  id,
  relative_path: `src/${filename}`,
  filename,
  language: 'typescript',
  size_bytes: 100,
  file_kind: 'Source',
  analysis_status: 'Analyzed',
  direct_dependency_count: 0,
  direct_dependent_count: 0,
});

describe('2D Focus History Reconciliation', () => {
  it('prunes deleted nodes from focus history when snapshot updates', () => {
    const nodes = [makeNode('node-b', 'b.ts'), makeNode('node-c', 'c.ts')];
    // History contains node-a, which was deleted on disk
    const history = ['node-a', 'node-b'];

    const reconciled = reconcileFocusHistoryOnSnapshot(history, nodes);
    expect(reconciled).toEqual(['node-b']);
  });

  it('handles complete history deletion without leaving invalid state', () => {
    const nodes = [makeNode('node-c', 'c.ts')];
    const history = ['node-a', 'node-b']; // both deleted

    const reconciled = reconcileFocusHistoryOnSnapshot(history, nodes);
    expect(reconciled).toEqual([]);
    expect(resolveBackTargetName(reconciled, nodes)).toBeNull();
  });

  it('safely skips missing entries during repeated back operations', () => {
    const nodes = [makeNode('node-a', 'a.ts')];
    const history = ['node-a', 'missing-node'];

    // With reconciliation before pop:
    const cleaned = reconcileFocusHistoryOnSnapshot(history, nodes);
    expect(cleaned).toEqual(['node-a']);
    const { nextHistory, prevFocusId } = popFocusHistory(cleaned);
    expect(prevFocusId).toBe('node-a');
    expect(nextHistory).toEqual([]);
  });

  it('preserves history order when all nodes remain valid', () => {
    const nodes = [makeNode('node-a', 'a.ts'), makeNode('node-b', 'b.ts'), makeNode('node-c', 'c.ts')];
    const history = ['node-a', 'node-b'];

    const reconciled = reconcileFocusHistoryOnSnapshot(history, nodes);
    expect(reconciled).toEqual(['node-a', 'node-b']);
    expect(resolveBackTargetName(reconciled, nodes)).toBe('b.ts');
  });

  it('returns empty array when history is already empty', () => {
    const nodes = [makeNode('node-a', 'a.ts')];
    expect(reconcileFocusHistoryOnSnapshot([], nodes)).toEqual([]);
  });
});
