import { describe, it, expect } from 'vitest';
import {
  applyTemporalWheelScroll,
  computeTemporalScrollBounds,
  reconcilePaginationTransform,
  computeCommitScrollIntoView,
  handleKeyboardCommitStep,
} from '../temporalScroll';
import { computeTemporalLayout, LayoutCommit } from '../temporalLayout';
import { CommitSummary } from '../../../types/temporal';
import { Transform } from '../../../types/graph';

function createMockCommit(hash: string, parentHashes: string[] = [], timestamp = 1700000000): CommitSummary {
  return {
    hash,
    short_hash: hash.slice(0, 7),
    parent_hashes: parentHashes,
    author_name: 'Developer',
    author_email: 'dev@prebase.dev',
    author_timestamp: timestamp,
    summary: `Commit ${hash}`,
    lane: 0,
  };
}

describe('History Timeline Behavioral Regression Suite', () => {
  describe('Native Vertical Scrolling (Scale Invariant Invariant)', () => {
    it('applies native vertical scrolling without mutating wheel-based zoom scaling', () => {
      const initialTransform: Transform = { x: 60, y: 60, k: 0.85 };
      const contentHeight = 3000;
      const viewportHeight = 600;

      // User scrolls down by 120px (wheel deltaY = 120)
      const scrolledDown = applyTemporalWheelScroll(
        initialTransform,
        120,
        contentHeight,
        viewportHeight
      );

      // 1. Zoom scale k MUST remain unchanged! Zero wheel-based zoom scaling!
      expect(scrolledDown.k).toBe(initialTransform.k);
      expect(scrolledDown.k).toBe(0.85);

      // 2. Horizontal position x MUST remain unchanged
      expect(scrolledDown.x).toBe(initialTransform.x);

      // 3. Vertical position y MUST scroll up (decrease by deltaY)
      expect(scrolledDown.y).toBe(initialTransform.y - 120);

      // User scrolls back up by 60px (wheel deltaY = -60)
      const scrolledUp = applyTemporalWheelScroll(
        scrolledDown,
        -60,
        contentHeight,
        viewportHeight
      );

      expect(scrolledUp.k).toBe(initialTransform.k);
      expect(scrolledUp.y).toBe(scrolledDown.y + 60);
    });

    it('clamps scrolling within bounded content margins to prevent losing commits offscreen', () => {
      const initialTransform: Transform = { x: 60, y: 60, k: 1.0 };
      const contentHeight = 1000;
      const viewportHeight = 500;

      // Attempt to scroll past top limit (deltaY = -500)
      const pastTop = applyTemporalWheelScroll(
        initialTransform,
        -500,
        contentHeight,
        viewportHeight
      );
      const bounds = computeTemporalScrollBounds(contentHeight, viewportHeight);
      expect(pastTop.y).toBe(bounds.maxY);

      // Attempt to scroll past bottom limit (deltaY = 5000)
      const pastBottom = applyTemporalWheelScroll(
        initialTransform,
        5000,
        contentHeight,
        viewportHeight
      );
      expect(pastBottom.y).toBe(bounds.minY);
    });
  });

  describe('Cursor Pagination Scroll Position Preservation', () => {
    it('appends older commits without jumping or resetting scroll position', () => {
      // Simulate initial 50 commits loaded
      const initialCommits: CommitSummary[] = [];
      for (let i = 0; i < 50; i++) {
        initialCommits.push(
          createMockCommit(`hash-${i}`, i < 49 ? [`hash-${i + 1}`] : [], 1700000000 - i * 3600)
        );
      }

      const initialLayout = computeTemporalLayout(initialCommits);
      expect(initialLayout.nodes).toHaveLength(50);

      // User has scrolled down into the history (e.g. y = -850)
      const activeScrolledTransform: Transform = { x: 70, y: -850, k: 0.9 };

      // Commit #20's original screen coordinate
      const commit20Node = initialLayout.nodes[20];
      const screenYBefore = activeScrolledTransform.y + commit20Node.y * activeScrolledTransform.k;

      // User clicks "Load older commits" -> cursor pagination fetches next 50 commits (total 100)
      const paginatedCommits: CommitSummary[] = [...initialCommits];
      for (let i = 50; i < 100; i++) {
        paginatedCommits.push(
          createMockCommit(`hash-${i}`, i < 99 ? [`hash-${i + 1}`] : [], 1700000000 - i * 3600)
        );
      }

      const paginatedLayout = computeTemporalLayout(paginatedCommits);
      expect(paginatedLayout.nodes).toHaveLength(100);

      // Camera reconciliation during pagination
      const reconciledTransform = reconcilePaginationTransform(activeScrolledTransform, true);

      // 1. Transform must not reset to initial view or (0, 0)
      expect(reconciledTransform.x).toBe(activeScrolledTransform.x);
      expect(reconciledTransform.y).toBe(activeScrolledTransform.y);
      expect(reconciledTransform.k).toBe(activeScrolledTransform.k);

      // 2. Commit #20 MUST remain at the exact same screen position! Zero scroll jumping!
      const commit20After = paginatedLayout.nodes[20];
      const screenYAfter = reconciledTransform.y + commit20After.y * reconciledTransform.k;
      expect(screenYAfter).toBe(screenYBefore);

      // 3. New commits are appended below
      const commit60Node = paginatedLayout.nodes[60];
      expect(commit60Node.y).toBeGreaterThan(commit20After.y);
    });
  });

  describe('Accessible Keyboard Navigation', () => {
    it('navigates commits sequentially with ArrowDown and ArrowUp', () => {
      const totalNodes = 10;

      // No initial selection: ArrowDown selects first commit (0)
      expect(handleKeyboardCommitStep(-1, totalNodes, 'ArrowDown')).toBe(0);

      // Step down: 0 -> 1 -> 2
      expect(handleKeyboardCommitStep(0, totalNodes, 'ArrowDown')).toBe(1);
      expect(handleKeyboardCommitStep(1, totalNodes, 'ArrowDown')).toBe(2);

      // At boundary (last node 9), ArrowDown clamps at 9
      expect(handleKeyboardCommitStep(9, totalNodes, 'ArrowDown')).toBe(9);

      // Step up: 9 -> 8 -> 7
      expect(handleKeyboardCommitStep(9, totalNodes, 'ArrowUp')).toBe(8);
      expect(handleKeyboardCommitStep(8, totalNodes, 'ArrowUp')).toBe(7);

      // At top boundary (0), ArrowUp clamps at 0
      expect(handleKeyboardCommitStep(0, totalNodes, 'ArrowUp')).toBe(0);

      // No initial selection: ArrowUp selects last commit (9)
      expect(handleKeyboardCommitStep(-1, totalNodes, 'ArrowUp')).toBe(9);
    });

    it('jumps to start with Home and end with End', () => {
      const totalNodes = 25;
      expect(handleKeyboardCommitStep(14, totalNodes, 'Home')).toBe(0);
      expect(handleKeyboardCommitStep(14, totalNodes, 'End')).toBe(24);
    });

    it('auto-scrolls target commit into view when navigating outside visible bounds', () => {
      const currentTransform: Transform = { x: 60, y: 60, k: 1.0 };
      const viewportHeight = 500;

      // Node near bottom or offscreen (y = 600)
      const offscreenNode: LayoutCommit = {
        commit: createMockCommit('offscreen'),
        x: 60,
        y: 600,
        lane: 0,
      };

      const adjustedTransform = computeCommitScrollIntoView(
        currentTransform,
        offscreenNode,
        viewportHeight,
        80
      );

      // Must have scrolled up (negative y adjustment) to bring node into view
      expect(adjustedTransform.y).toBeLessThan(currentTransform.y);
      const newScreenY = adjustedTransform.y + offscreenNode.y * adjustedTransform.k;
      expect(newScreenY).toBeLessThanOrEqual(viewportHeight - 80);
      expect(newScreenY).toBeGreaterThanOrEqual(80);
    });
  });
});
