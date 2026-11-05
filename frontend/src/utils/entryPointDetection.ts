import { FileNode } from '../types/graph';

export type EntryPointKind =
  | 'executable-startup'
  | 'library-crate-root'
  | 'root-component'
  | 'nested-app-root';

export interface EntryPointCandidate {
  nodeId: string;
  relativePath: string;
  filename: string;
  confidence: 'high' | 'medium';
  heuristicReason: string;
  kind: EntryPointKind;
  displayTitle: string;
}

interface PatternRule {
  pattern: RegExp;
  kind: EntryPointKind;
  confidence: 'high' | 'medium';
  displayTitle: string;
  reasonTemplate: (path: string) => string;
}

const CONVENTIONAL_RULES: PatternRule[] = [
  // 1. Standard Rust binary startup
  {
    pattern: /^(?:src\/)?main\.rs$/,
    kind: 'executable-startup',
    confidence: 'high',
    displayTitle: 'Startup Executable Candidate',
    reasonTemplate: (p) => `Possible executable entry point based on Rust convention (${p})`,
  },
  // 2. Standard Rust library root
  {
    pattern: /^(?:(?:crates|packages)\/[^/]+\/src\/|src\/)?lib\.rs$/,
    kind: 'library-crate-root',
    confidence: 'high',
    displayTitle: 'Library Crate Root Candidate',
    reasonTemplate: (p) => `Library crate root based on Rust convention (${p})`,
  },
  // 3. Standard JS/TS client or server startup files
  {
    pattern: /^(?:src\/)?(?:index|main|server)\.(?:ts|tsx|js|jsx)$/,
    kind: 'executable-startup',
    confidence: 'high',
    displayTitle: 'Likely Startup File Candidate',
    reasonTemplate: (p) => `Possible application startup file based on convention (${p})`,
  },
  // 4. Nested app roots (frontend/client/crates)
  {
    pattern: /^(?:frontend|client|apps\/[^/]+|packages\/[^/]+)\/src\/(?:main|index)\.(?:ts|tsx|js|jsx)$/,
    kind: 'nested-app-root',
    confidence: 'medium',
    displayTitle: 'Nested App Startup Candidate',
    reasonTemplate: (p) => `Likely startup file for nested application workspace (${p})`,
  },
  // 5. Framework root components (App.tsx / app.tsx)
  {
    pattern: /^(?:(?:frontend|client|apps\/[^/]+)\/)?src\/[Aa]pp\.(?:tsx|jsx)$/,
    kind: 'root-component',
    confidence: 'medium',
    displayTitle: 'Root Component Candidate',
    reasonTemplate: (p) => `Top-level component candidate based on React convention (${p})`,
  },
  // 6. Go main
  {
    pattern: /^(?:cmd\/[^/]+\/)?main\.go$/,
    kind: 'executable-startup',
    confidence: 'high',
    displayTitle: 'Startup Executable Candidate',
    reasonTemplate: (p) => `Main package entrypoint based on Go convention (${p})`,
  },
];

/**
 * Identifies grounded entrypoint candidates from project convention evidence.
 * Supports multiple candidates across monorepos and workspaces.
 * NEVER assumes or declares nodes[0] as the entrypoint simply due to scan order.
 */
export function findEntryPointCandidates(nodes: readonly FileNode[]): EntryPointCandidate[] {
  if (!nodes || nodes.length === 0) return [];

  const candidates: EntryPointCandidate[] = [];
  const seenIds = new Set<string>();

  for (const rule of CONVENTIONAL_RULES) {
    for (const node of nodes) {
      if (seenIds.has(node.id)) continue;
      if (rule.pattern.test(node.relative_path)) {
        candidates.push({
          nodeId: node.id,
          relativePath: node.relative_path,
          filename: node.filename,
          confidence: rule.confidence,
          heuristicReason: rule.reasonTemplate(node.relative_path),
          kind: rule.kind,
          displayTitle: rule.displayTitle,
        });
        seenIds.add(node.id);
        if (candidates.length >= 6) break;
      }
    }
    if (candidates.length >= 6) break;
  }

  return candidates;
}

/**
 * Returns the primary entrypoint candidate, or null if no conventional candidate exists.
 */
export function findEntryPointCandidate(nodes: readonly FileNode[]): EntryPointCandidate | null {
  const candidates = findEntryPointCandidates(nodes);
  return candidates.length > 0 ? candidates[0] : null;
}
