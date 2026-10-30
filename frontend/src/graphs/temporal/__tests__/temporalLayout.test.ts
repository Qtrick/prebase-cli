import { describe, it, expect } from 'vitest';
import {
  computeTemporalLayout,
  assignLanesToCommits,
  getLaneColor,
  LANE_COLORS,
  formatRelativeTime,
  MARGIN_LEFT,
  LANE_WIDTH,
} from '../temporalLayout';
import { CommitSummary } from '../../../types/temporal';

function createMockCommit(
  hash: string,
  parent_hashes: string[],
  summary = '',
  timestamp = 1700000000
): CommitSummary {
  return {
    hash,
    short_hash: hash.slice(0, 7),
    parent_hashes,
    author_name: 'Developer',
    author_email: 'dev@prebase.dev',
    author_timestamp: timestamp,
    summary: summary || `Commit ${hash}`,
    lane: 0,
  };
}

describe('Temporal Graph Layout & Time Formatting', () => {
  it('assigns unique coordinates and extracts parent edges', () => {
    const commits: CommitSummary[] = [
      createMockCommit('commit-2', ['commit-1'], 'Second commit', 1700000000),
      createMockCommit('commit-1', [], 'Initial commit', 1699990000),
    ];

    const layout = computeTemporalLayout(commits);
    expect(layout.nodes).toHaveLength(2);
    expect(layout.edges).toHaveLength(1);

    expect(layout.edges[0].fromHash).toBe('commit-2');
    expect(layout.edges[0].toHash).toBe('commit-1');
    expect(layout.nodes[0].y).toBeLessThan(layout.nodes[1].y);
    expect(layout.bounds.width).toBeGreaterThan(0);
    expect(layout.bounds.height).toBeGreaterThan(0);
  });

  it('cycles through distinct lane colors', () => {
    expect(getLaneColor(0)).toBe(LANE_COLORS[0]);
    expect(getLaneColor(1)).toBe(LANE_COLORS[1]);
    expect(getLaneColor(LANE_COLORS.length)).toBe(LANE_COLORS[0]);
  });

  it('formats relative timestamps correctly', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(formatRelativeTime(now - 10)).toBe('just now');
    expect(formatRelativeTime(now - 120)).toBe('2m ago');
    expect(formatRelativeTime(now - 7200)).toBe('2h ago');
    expect(formatRelativeTime(now - 172800)).toBe('2d ago');
  });
});

describe('assignLanesToCommits & Paginated Continuity', () => {
  it('maintains globally continuous lanes when combining commits from multiple paginated pages without resets', () => {
    // Page 1 contains recent commits:
    // trunk-3 -> trunk-2
    // feat-2  -> feat-1
    // trunk-2 -> trunk-1
    // The page boundary is cut between feat-2 (page 1) and its parent feat-1 (page 2)
    const page1: CommitSummary[] = [
      createMockCommit('trunk-3', ['trunk-2']),
      createMockCommit('feat-2', ['feat-1']),
      createMockCommit('trunk-2', ['trunk-1']),
    ];

    // Page 2 contains continuation commits:
    // feat-1  -> trunk-1 (feature branch roots at trunk-1)
    // trunk-1 -> trunk-0
    // trunk-0 -> [] (root commit)
    const page2: CommitSummary[] = [
      createMockCommit('feat-1', ['trunk-1']),
      createMockCommit('trunk-1', ['trunk-0']),
      createMockCommit('trunk-0', []),
    ];

    // If evaluated in isolation without global context, page 2 resets feat-1 to lane 0:
    const isolatedPage2Lanes = assignLanesToCommits(page2);
    expect(isolatedPage2Lanes[0]).toBe(0); // Erroneous reset if not combined!

    // Combining pages across the pagination boundary:
    const combined = [...page1, ...page2];
    const lanes = assignLanesToCommits(combined);

    expect(lanes).toHaveLength(6);
    // Index 0: trunk-3 -> lane 0
    // Index 1: feat-2   -> lane 1
    // Index 2: trunk-2 -> lane 0
    // Index 3: feat-1   -> lane 1 (must preserve lane 1 from feat-2 across the page boundary!)
    // Index 4: trunk-1 -> lane 0
    // Index 5: trunk-0 -> lane 0
    expect(lanes[0]).toBe(0); // trunk-3
    expect(lanes[1]).toBe(1); // feat-2
    expect(lanes[2]).toBe(0); // trunk-2
    expect(lanes[3]).toBe(1); // feat-1 CONTINUES on lane 1 without reset
    expect(lanes[4]).toBe(0); // trunk-1 continues trunk on lane 0
    expect(lanes[5]).toBe(0); // trunk-0 root on lane 0

    // Verify end-to-end computeTemporalLayout reflects continuous X coordinates across page boundary
    const layout = computeTemporalLayout(combined);
    const nodeFeat2 = layout.nodes.find((n) => n.commit.hash === 'feat-2')!;
    const nodeFeat1 = layout.nodes.find((n) => n.commit.hash === 'feat-1')!;
    const nodeTrunk2 = layout.nodes.find((n) => n.commit.hash === 'trunk-2')!;

    expect(nodeFeat2.lane).toBe(1);
    expect(nodeFeat1.lane).toBe(1);
    expect(nodeFeat2.x).toBe(MARGIN_LEFT + 1 * LANE_WIDTH);
    expect(nodeFeat1.x).toBe(MARGIN_LEFT + 1 * LANE_WIDTH);
    expect(nodeTrunk2.lane).toBe(0);
    expect(nodeTrunk2.x).toBe(MARGIN_LEFT);

    // Cross-page edge must connect feat-2 to feat-1 as an internal continuous edge (not a stub)
    const crossPageEdge = layout.edges.find(
      (e) => e.fromHash === 'feat-2' && e.toHash === 'feat-1'
    );
    expect(crossPageEdge).toBeDefined();
    expect(crossPageEdge?.isStub).toBe(false);
    expect(crossPageEdge?.fromX).toBe(crossPageEdge?.toX);
    expect(crossPageEdge?.lane).toBe(1);
  });

  it('maintains distinct parallel lanes for multiple concurrent branches spanning page slices', () => {
    // Two parallel feature branches (Branch A and Branch B) active at the same time:
    // Page 1:
    // trunk-4    -> trunk-3
    // branchB-2  -> branchB-1
    // branchA-2  -> branchA-1
    // trunk-3    -> trunk-2
    const page1: CommitSummary[] = [
      createMockCommit('trunk-4', ['trunk-3']),
      createMockCommit('branchB-2', ['branchB-1']),
      createMockCommit('branchA-2', ['branchA-1']),
      createMockCommit('trunk-3', ['trunk-2']),
    ];

    // Page 2:
    // branchB-1  -> trunk-2
    // branchA-1  -> trunk-2
    // trunk-2    -> trunk-1
    // trunk-1    -> []
    const page2: CommitSummary[] = [
      createMockCommit('branchB-1', ['trunk-2']),
      createMockCommit('branchA-1', ['trunk-2']),
      createMockCommit('trunk-2', ['trunk-1']),
      createMockCommit('trunk-1', []),
    ];

    const combined = [...page1, ...page2];
    const lanes = assignLanesToCommits(combined);

    // Indices:
    // 0: trunk-4   (lane 0)
    // 1: branchB-2 (lane 1)
    // 2: branchA-2 (lane 2)
    // 3: trunk-3   (lane 0)
    // 4: branchB-1 (lane 1 - preserved across page cut!)
    // 5: branchA-1 (lane 2 - preserved across page cut!)
    // 6: trunk-2   (lane 0)
    // 7: trunk-1   (lane 0)
    expect(lanes[0]).toBe(0);
    expect(lanes[1]).toBe(1);
    expect(lanes[2]).toBe(2);
    expect(lanes[3]).toBe(0);
    expect(lanes[4]).toBe(1);
    expect(lanes[5]).toBe(2);
    expect(lanes[6]).toBe(0);
    expect(lanes[7]).toBe(0);

    // Verify no collision: branchA and branchB maintain mutually exclusive lanes
    expect(lanes[1]).not.toBe(lanes[2]);
    expect(lanes[4]).not.toBe(lanes[5]);
    expect(lanes[4]).toBe(lanes[1]);
    expect(lanes[5]).toBe(lanes[2]);
  });

  it('recycles freed lane indices after branches terminate or merge', () => {
    // Sequence where branch-1 opens and closes, then branch-2 opens later:
    // 0: trunk-4 -> trunk-3
    // 1: branch1-2 -> branch1-1 (opens lane 1)
    // 2: branch1-1 -> trunk-2   (lane 1 frees after this)
    // 3: trunk-3 -> trunk-2     (lane 0)
    // 4: trunk-2 -> trunk-1     (lane 0)
    // 5: branch2-1 -> trunk-1   (should recycle freed lane 1, NOT allocate lane 2)
    // 6: trunk-1 -> []
    const commits: CommitSummary[] = [
      createMockCommit('trunk-4', ['trunk-3']),
      createMockCommit('branch1-2', ['branch1-1']),
      createMockCommit('branch1-1', ['trunk-2']),
      createMockCommit('trunk-3', ['trunk-2']),
      createMockCommit('trunk-2', ['trunk-1']),
      createMockCommit('branch2-1', ['trunk-1']),
      createMockCommit('trunk-1', []),
    ];

    const lanes = assignLanesToCommits(commits);
    expect(lanes[0]).toBe(0); // trunk-4
    expect(lanes[1]).toBe(1); // branch1-2
    expect(lanes[2]).toBe(1); // branch1-1
    expect(lanes[3]).toBe(0); // trunk-3
    expect(lanes[4]).toBe(0); // trunk-2
    expect(lanes[5]).toBe(1); // branch2-1 reuses freed lane 1
    expect(lanes[6]).toBe(0); // trunk-1
  });

  it('handles edge cases: empty list, single commit, and merge commits', () => {
    expect(assignLanesToCommits([])).toEqual([]);

    const single = [createMockCommit('root', [])];
    expect(assignLanesToCommits(single)).toEqual([0]);

    // Merge commit with two parents:
    // merge-1 has parents [trunk-1, branch-1]
    const mergeCommits: CommitSummary[] = [
      createMockCommit('merge-1', ['trunk-1', 'branch-1']),
      createMockCommit('branch-1', ['trunk-0']),
      createMockCommit('trunk-1', ['trunk-0']),
      createMockCommit('trunk-0', []),
    ];

    const mergeLanes = assignLanesToCommits(mergeCommits);
    expect(mergeLanes[0]).toBe(0); // merge-1 stays on main trunk lane
    expect(mergeLanes[1]).toBe(1); // branch-1 allocated secondary lane
    expect(mergeLanes[2]).toBe(0); // trunk-1 stays on main lane
    expect(mergeLanes[3]).toBe(0); // trunk-0 on main lane
  });
});


