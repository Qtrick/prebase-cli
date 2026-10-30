import { CommitSummary } from '../../types/temporal';

export interface LayoutCommit {
  commit: CommitSummary;
  x: number;
  y: number;
  lane: number;
}

export interface CommitEdge {
  fromHash: string;
  toHash: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  lane: number;
  isStub?: boolean;
  isDashed?: boolean;
}

export interface TemporalGraphLayout {
  nodes: LayoutCommit[];
  edges: CommitEdge[];
  bounds: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    width: number;
    height: number;
  };
}

export const LANE_COLORS = [
  '#2dd4bf', // cyan / teal (main trunk)
  '#818cf8', // indigo
  '#fbbf24', // amber
  '#f43f5e', // rose
  '#34d399', // emerald
  '#a78bfa', // violet
  '#38bdf8', // sky
  '#fb923c', // orange
];

export function getLaneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length];
}

export const LANE_WIDTH = 36;
export const ROW_HEIGHT = 56;
export const MARGIN_LEFT = 60;
export const MARGIN_TOP = 60;

/**
 * Dynamically computes topologically consistent branch lanes across the entire
 * sequence of loaded commits, preventing lane discontinuities across paginated fetches.
 */
export function assignLanesToCommits(commits: CommitSummary[]): number[] {
  const lanes: number[] = new Array(commits.length);
  const activeLanes: (string | null)[] = [];
  const commitLanes = new Map<string, number>();

  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    let lane: number;
    if (commitLanes.has(c.hash)) {
      lane = commitLanes.get(c.hash)!;
    } else {
      const freeIdx = activeLanes.findIndex((s) => s === null);
      if (freeIdx !== -1) {
        activeLanes[freeIdx] = c.hash;
        lane = freeIdx;
      } else {
        lane = activeLanes.length;
        activeLanes.push(c.hash);
      }
    }
    lanes[i] = lane;

    if (lane < activeLanes.length && activeLanes[lane] === c.hash) {
      activeLanes[lane] = null;
    }

    for (let pIdx = 0; pIdx < c.parent_hashes.length; pIdx++) {
      const pHash = c.parent_hashes[pIdx];
      if (commitLanes.has(pHash)) {
        const existingLane = commitLanes.get(pHash)!;
        if (pIdx === 0 && lane < existingLane) {
          commitLanes.set(pHash, lane);
          if (existingLane < activeLanes.length && activeLanes[existingLane] === pHash) {
            activeLanes[existingLane] = null;
          }
          if (lane < activeLanes.length && activeLanes[lane] === null) {
            activeLanes[lane] = pHash;
          }
        }
      } else if (pIdx === 0 && lane < activeLanes.length && activeLanes[lane] === null) {
        activeLanes[lane] = pHash;
        commitLanes.set(pHash, lane);
      } else {
        const nextFree = activeLanes.findIndex((s) => s === null);
        let pLane: number;
        if (nextFree !== -1) {
          activeLanes[nextFree] = pHash;
          pLane = nextFree;
        } else {
          pLane = activeLanes.length;
          activeLanes.push(pHash);
        }
        commitLanes.set(pHash, pLane);
      }
    }

    while (activeLanes.length > 0 && activeLanes[activeLanes.length - 1] === null) {
      activeLanes.pop();
    }
  }

  return lanes;
}

export function computeTemporalLayout(
  commits: CommitSummary[],
  isFiltered = false
): TemporalGraphLayout {
  if (commits.length === 0) {
    return {
      nodes: [],
      edges: [],
      bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0, width: 0, height: 0 },
    };
  }

  const commitMap = new Map<string, LayoutCommit>();
  const nodes: LayoutCommit[] = [];

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  const dynamicLanes = assignLanesToCommits(commits);

  // 1. Position nodes
  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    const lane = dynamicLanes[i];
    const x = MARGIN_LEFT + lane * LANE_WIDTH;
    const y = MARGIN_TOP + i * ROW_HEIGHT;

    const layoutNode: LayoutCommit = {
      commit: { ...c, lane },
      x,
      y,
      lane,
    };

    nodes.push(layoutNode);
    commitMap.set(c.hash, layoutNode);

    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  // Allow extra space on the right for commit messages and meta
  maxX += 520;

  // 2. Compute edges connecting child to parents
  const edges: CommitEdge[] = [];
  for (const node of nodes) {
    for (const parentHash of node.commit.parent_hashes) {
      const parentNode = commitMap.get(parentHash);
      if (parentNode) {
        edges.push({
          fromHash: node.commit.hash,
          toHash: parentHash,
          fromX: node.x,
          fromY: node.y,
          toX: parentNode.x,
          toY: parentNode.y,
          lane: node.lane,
          isStub: false,
          isDashed: isFiltered,
        });
      } else {
        // Parent is outside the loaded page!
        edges.push({
          fromHash: node.commit.hash,
          toHash: parentHash,
          fromX: node.x,
          fromY: node.y,
          toX: node.x,
          toY: node.y + ROW_HEIGHT * 0.75,
          lane: node.lane,
          isStub: true,
          isDashed: true,
        });
      }
    }
  }

  const width = Math.max(100, maxX - minX);
  const height = Math.max(100, maxY - minY);

  return {
    nodes,
    edges,
    bounds: {
      minX,
      maxX,
      minY,
      maxY,
      width,
      height,
    },
  };
}

export function formatRelativeTime(timestampSec: number): string {
  if (!timestampSec) return '';
  const now = Math.floor(Date.now() / 1000);
  const diffSec = Math.max(0, now - timestampSec);

  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 2592000) return `${Math.floor(diffSec / 86400)}d ago`;

  const date = new Date(timestampSec * 1000);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

