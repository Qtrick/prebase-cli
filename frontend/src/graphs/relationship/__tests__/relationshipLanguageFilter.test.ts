import { describe, it, expect } from 'vitest';
import { matchesLanguageFilter, partitionNodesByLanguage, getLanguageFilterOpacity, LanguageFilterType } from '../../../utils/languageFilter';
import { FileNode, GraphSnapshot, DependencyEdge } from '../../../types/graph';
import { deriveRelationshipGraph } from '../deriveRelationshipGraph';

function makeEdge(source: string, target: string, id = `${source}->${target}`): DependencyEdge {
  return {
    id,
    source_file_id: source,
    target_file_id: target,
    relationship_kind: 'Import',
    resolution_status: 'ResolvedInternal',
    evidence: [],
  };
}

function makeSnapshot(nodes: FileNode[], edges: DependencyEdge[]): GraphSnapshot {
  return {
    schema_version: '1.0.0',
    repository_id: 'test-repo',
    revision: 1,
    nodes,
    edges,
    coverage: {
      total_discovered: nodes.length,
      total_analyzed: nodes.length,
      total_excluded: 0,
      total_issues: 0,
      is_complete: true,
    },
    issues: [],
  };
}

function makeNode(
  id: string,
  relativePath: string,
  language = 'typescript'
): FileNode {
  return {
    id,
    relative_path: relativePath,
    filename: relativePath.split('/').pop() || relativePath,
    language,
    size_bytes: 200,
    file_kind: 'Source',
    analysis_status: 'Analyzed',
    direct_dependency_count: 1,
    direct_dependent_count: 1,
  };
}

describe('Language Filter Consistency (3D & 2D Parity Suite)', () => {
  const tsNode = makeNode('n-ts', 'src/components/Button.tsx', 'typescript');
  const jsNode = makeNode('n-js', 'src/utils/math.js', 'javascript');
  const mjsNode = makeNode('n-mjs', 'src/helpers/loader.mjs', 'javascript');
  const rustNode = makeNode('n-rs', 'crates/core/src/lib.rs', 'rust');
  const pyNode = makeNode('n-py', 'scripts/verify.py', 'python');
  const pyiNode = makeNode('n-pyi', 'types/stubs.pyi', 'python');

  const allNodes = [tsNode, jsNode, mjsNode, rustNode, pyNode, pyiNode];

  describe('Rule Consistency Across All Language Categories', () => {
    it("matches all nodes when filter is 'all' or undefined", () => {
      for (const node of allNodes) {
        expect(matchesLanguageFilter(node, 'all')).toBe(true);
        expect(matchesLanguageFilter(node, undefined)).toBe(true);
        expect(getLanguageFilterOpacity(node, 'all')).toBe(1.0);
      }
    });

    it("matches TypeScript & JavaScript files for 'typescript' filter", () => {
      expect(matchesLanguageFilter(tsNode, 'typescript')).toBe(true);
      expect(matchesLanguageFilter(jsNode, 'typescript')).toBe(true);
      expect(matchesLanguageFilter(mjsNode, 'typescript')).toBe(true);

      expect(matchesLanguageFilter(rustNode, 'typescript')).toBe(false);
      expect(matchesLanguageFilter(pyNode, 'typescript')).toBe(false);
      expect(matchesLanguageFilter(pyiNode, 'typescript')).toBe(false);

      expect(getLanguageFilterOpacity(tsNode, 'typescript')).toBe(1.0);
      expect(getLanguageFilterOpacity(rustNode, 'typescript')).toBe(0.2);
    });

    it("matches Rust crates and modules for 'rust' filter", () => {
      expect(matchesLanguageFilter(rustNode, 'rust')).toBe(true);

      expect(matchesLanguageFilter(tsNode, 'rust')).toBe(false);
      expect(matchesLanguageFilter(jsNode, 'rust')).toBe(false);
      expect(matchesLanguageFilter(pyNode, 'rust')).toBe(false);

      expect(getLanguageFilterOpacity(rustNode, 'rust')).toBe(1.0);
      expect(getLanguageFilterOpacity(tsNode, 'rust')).toBe(0.2);
    });

    it("matches Python scripts and stubs for 'python' filter", () => {
      expect(matchesLanguageFilter(pyNode, 'python')).toBe(true);
      expect(matchesLanguageFilter(pyiNode, 'python')).toBe(true);

      expect(matchesLanguageFilter(tsNode, 'python')).toBe(false);
      expect(matchesLanguageFilter(rustNode, 'python')).toBe(false);

      expect(getLanguageFilterOpacity(pyNode, 'python')).toBe(1.0);
      expect(getLanguageFilterOpacity(rustNode, 'python')).toBe(0.2);
    });
  });

  describe('Cross-View 3D and 2D Language Consistency Contract', () => {
    it('produces identical matching partitions in 3D and 2D views', () => {
      const filters: LanguageFilterType[] = ['all', 'typescript', 'rust', 'python'];

      for (const filter of filters) {
        // 1. Partition in 3D overview
        const partition3D = partitionNodesByLanguage(allNodes, filter);
        expect(partition3D.matching.length + partition3D.nonMatching.length).toBe(allNodes.length);

        // 2. Derive 2D relationship graph
        const snapshot = makeSnapshot(allNodes, [
          makeEdge(tsNode.id, rustNode.id, 'e1'),
          makeEdge(pyNode.id, rustNode.id, 'e2'),
        ]);

        const graph2D = deriveRelationshipGraph(snapshot, rustNode.id);

        // Verify that every node in 2D matches the exact same filter evaluation as in 3D
        for (const relNode of graph2D.nodes) {
          const match3D = matchesLanguageFilter(relNode.node, filter);
          const opacity2D = getLanguageFilterOpacity(relNode.node, filter);

          if (match3D) {
            expect(opacity2D).toBe(1.0);
          } else {
            expect(opacity2D).toBe(0.2);
          }
        }
      }
    });

    it('preserves focus node visibility in 2D even when bridging across different languages', () => {
      // In polyglot repo: Rust backend core is bridged to TS frontend
      const snapshot = makeSnapshot([rustNode, tsNode], [
        makeEdge(tsNode.id, rustNode.id, 'e1'),
      ]);

      // Focusing on rustNode with 'typescript' filter active
      const graph2D = deriveRelationshipGraph(snapshot, rustNode.id);
      expect(graph2D.focusNode?.id).toBe(rustNode.id);

      // rustNode has opacity 0.2 (dimmed context), while tsNode has 1.0 (active match)
      expect(getLanguageFilterOpacity(graph2D.focusNode!, 'typescript')).toBe(0.2);
      expect(getLanguageFilterOpacity(tsNode, 'typescript')).toBe(1.0);
    });
  });
});
