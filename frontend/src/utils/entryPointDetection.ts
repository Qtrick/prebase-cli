import { FileNode } from '../types/graph';

export interface EntryPointCandidate {
  nodeId: string;
  relativePath: string;
  filename: string;
  confidence: 'high' | 'medium';
  heuristicReason: string;
}

/**
 * Standard conventional project entry file basenames and patterns.
 * We prioritize standard runtime roots while explicitly documenting them as heuristics.
 */
const HIGH_CONFIDENCE_PATTERNS = [
  // Standard Rust entrypoints
  /^src\/main\.rs$/,
  /^src\/lib\.rs$/,
  // Standard JS/TS client and server roots
  /^src\/index\.(ts|tsx|js|jsx)$/,
  /^src\/main\.(ts|tsx|js|jsx)$/,
  /^src\/App\.(tsx|jsx)$/,
  /^src\/app\.(tsx|jsx)$/,
  /^src\/server\.(ts|js)$/,
  // Root-level entrypoints
  /^index\.(ts|tsx|js|jsx)$/,
  /^main\.(ts|tsx|js|jsx)$/,
  /^server\.(ts|js)$/,
];

const MEDIUM_CONFIDENCE_PATTERNS = [
  // Nested app entrypoints
  /^frontend\/src\/main\.(ts|tsx|js|jsx)$/,
  /^frontend\/src\/index\.(ts|tsx|js|jsx)$/,
  /^frontend\/src\/App\.(tsx|jsx)$/,
  /^client\/src\/index\.(ts|tsx|js|jsx)$/,
  /^client\/src\/main\.(ts|tsx|js|jsx)$/,
  // General root-level scripts
  /^app\.(ts|tsx|js|jsx)$/,
  /^main\.go$/,
];

/**
 * Identifies grounded entrypoint candidates from project convention evidence.
 * NEVER assumes or declares nodes[0] as the entrypoint simply due to scan order.
 * Returns null if no verified candidate can be established.
 */
export function findEntryPointCandidate(nodes: readonly FileNode[]): EntryPointCandidate | null {
  if (!nodes || nodes.length === 0) return null;

  // 1. Check high-confidence standard conventions
  for (const pattern of HIGH_CONFIDENCE_PATTERNS) {
    const match = nodes.find((n) => pattern.test(n.relative_path));
    if (match) {
      return {
        nodeId: match.id,
        relativePath: match.relative_path,
        filename: match.filename,
        confidence: 'high',
        heuristicReason: `Matches standard project convention (${match.relative_path})`,
      };
    }
  }

  // 2. Check medium-confidence conventions (monorepos or nested directories)
  for (const pattern of MEDIUM_CONFIDENCE_PATTERNS) {
    const match = nodes.find((n) => pattern.test(n.relative_path));
    if (match) {
      return {
        nodeId: match.id,
        relativePath: match.relative_path,
        filename: match.filename,
        confidence: 'medium',
        heuristicReason: `Matches nested project convention (${match.relative_path})`,
      };
    }
  }

  // 3. No candidate established — do not guess or fallback to nodes[0]
  return null;
}

