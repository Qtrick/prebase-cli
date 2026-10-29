import { describe, it, expect } from 'vitest';
import {
  computeTemporalLayout,
  getLaneColor,
  LANE_COLORS,
  formatRelativeTime,
} from '../temporalLayout';
import { CommitSummary } from '../../../types/temporal';

describe('Temporal Graph Layout & Time Formatting', () => {
  it('assigns unique coordinates and extracts parent edges', () => {
    const commits: CommitSummary[] = [
      {
        hash: 'commit-2',
        short_hash: 'c2',
        parent_hashes: ['commit-1'],
        author_name: 'Dev',
        author_email: 'dev@prebase.dev',
        author_timestamp: 1700000000,
        summary: 'Second commit',
        lane: 0,
      },
      {
        hash: 'commit-1',
        short_hash: 'c1',
        parent_hashes: [],
        author_name: 'Dev',
        author_email: 'dev@prebase.dev',
        author_timestamp: 1699990000,
        summary: 'Initial commit',
        lane: 0,
      },
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
