import { describe, it, expect } from 'vitest';
import { computeRelationshipLayout } from '../relationshipLayout';
import { deriveRelationshipGraph } from '../deriveRelationshipGraph';
import { fitTextEnd, fitTextPrefix, fitTextMiddle } from '../../../utils/textFitting';
import { DependencyEdge, FileNode, GraphSnapshot } from '../../../types/graph';

describe('2D Relationship Universal Text Containment', () => {
  const measureSans = (s: string) => s.length * 7;
  const measureMono = (s: string) => s.length * 6.5;

  const makeNode = (id: string, relPath: string): FileNode => {
    const filename = relPath.split('/').pop() || relPath;
    return {
      id,
      relative_path: relPath,
      filename,
      language: 'rust',
      size_bytes: 1024,
      file_kind: 'Source',
      analysis_status: 'Analyzed',
      direct_dependency_count: 2,
      direct_dependent_count: 4,
    };
  };

  const makeEdge = (source: string, target: string): DependencyEdge => ({
    id: `${source}->${target}`,
    source_file_id: source,
    target_file_id: target,
    relationship_kind: 'Import',
    resolution_status: 'ResolvedInternal',
    evidence: [],
  });

  const makeSnapshot = (nodes: FileNode[], edges: DependencyEdge[]): GraphSnapshot => ({
    schema_version: '1.0.0',
    repository_id: 'test-layout',
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
  });

  const nodes: FileNode[] = [
    makeNode('focus', 'crates/prebase-parser/src/tsconfig.rs'),
    makeNode('dep1', 'crates/prebase-parser/src/analyzer.rs'),
    makeNode('dep2', 'crates/prebase-parser/src/lib.rs'),
    makeNode('dep3', 'crates/prebase-parser/src/resolver.rs'),
    makeNode('dep4', 'crates/prebase-parser/tests/dependency_intelligence_tests.rs'),
    makeNode('uses1', 'crates/prebase-core/src/model.rs'),
  ];

  const edges: DependencyEdge[] = [
    makeEdge('dep1', 'focus'),
    makeEdge('dep2', 'focus'),
    makeEdge('dep3', 'focus'),
    makeEdge('dep4', 'focus'),
    makeEdge('focus', 'uses1'),
  ];

  const snapshot = makeSnapshot(nodes, edges);
  const graphData = deriveRelationshipGraph(snapshot, 'focus');

  it('computes authoritative header dimensions and bounds containment', () => {
    const layout = computeRelationshipLayout(graphData, { width: 1200, height: 800 });

    expect(layout.headers.length).toBe(3);
    for (const h of layout.headers) {
      if (h.role === 'focus') {
        expect(h.width).toBe(250);
      } else {
        expect(h.width).toBe(220);
      }
      expect(h.height).toBeGreaterThanOrEqual(40);

      // Verify bounds encompass full header area (top edge with 8px margin)
      expect(layout.bounds.minY).toBeLessThanOrEqual(h.y - h.height / 2);
    }
  });

  it('guarantees column header titles and subtitles fit inside header width', () => {
    const layout = computeRelationshipLayout(graphData, { width: 1200, height: 800 });

    for (const h of layout.headers) {
      const maxInnerW = h.width - 20;

      // 1. Column Title
      const fittedTitle = fitTextEnd(h.title.toUpperCase(), maxInnerW, measureSans);
      expect(measureSans(fittedTitle)).toBeLessThanOrEqual(maxInnerW);

      // 2. Subtitle
      if (h.role === 'focus') {
        const fittedSub = fitTextPrefix(h.subtitle, maxInnerW, measureMono);
        expect(measureMono(fittedSub)).toBeLessThanOrEqual(maxInnerW);
      } else {
        const fittedSub = fitTextEnd(h.subtitle, maxInnerW, measureSans);
        expect(measureSans(fittedSub)).toBeLessThanOrEqual(maxInnerW);
      }
    }
  });

  it('guarantees focus card text never collides with right-aligned statistics', () => {
    const layout = computeRelationshipLayout(graphData, { width: 1200, height: 800 });
    const focusNode = layout.nodes.find((n) => n.isFocus)!;

    expect(focusNode).toBeDefined();
    expect(focusNode.width).toBe(250);

    // Compute reserved right statistics region
    const statsUsedBy = `Used by: ${focusNode.node.direct_dependent_count}`;
    const statsUses = `Uses: ${focusNode.node.direct_dependency_count}`;
    const maxStatsW = Math.max(measureSans(statsUsedBy), measureSans(statsUses));
    const reservedRightW = Math.max(76, Math.ceil(maxStatsW) + 26);

    const left = focusNode.x - focusNode.width / 2;
    const dotX = left + 14;
    const textX = dotX + 12;
    const maxTextW = Math.max(30, focusNode.width - (textX - left) - reservedRightW);

    // Filename fitting
    const displayFilename = fitTextMiddle(focusNode.node.filename, maxTextW, measureSans);
    const filenameWidth = measureSans(displayFilename);
    expect(filenameWidth).toBeLessThanOrEqual(maxTextW);

    // Path fitting
    const displayPath = fitTextPrefix(focusNode.node.relative_path, maxTextW, measureMono);
    const pathWidth = measureMono(displayPath);
    expect(pathWidth).toBeLessThanOrEqual(maxTextW);

    // Assert that rendered text right edge is strictly to the left of the stats zone
    const textRightEdge = textX + Math.max(filenameWidth, pathWidth);
    const statsLeftEdge = left + focusNode.width - reservedRightW;
    expect(textRightEdge).toBeLessThanOrEqual(statsLeftEdge);
  });
});
