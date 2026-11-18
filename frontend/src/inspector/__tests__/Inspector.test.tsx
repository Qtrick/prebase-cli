import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  Inspector,
  getNodeRelationshipSentence,
  getEdgeRelationshipSentence,
} from '../Inspector';
import {
  FileNode,
  DependencyEdge,
  GraphSnapshot,
  ArchitecturalInsights,
} from '../../types/graph';

// Mock api methods to avoid network requests during component rendering
vi.mock('../../transport/api', () => ({
  api: {
    inspectFile: vi.fn().mockResolvedValue({
      file: {},
      dependencies: [],
      dependents: [],
      outgoing_edges: [],
      incoming_edges: [],
    }),
    getSource: vi.fn().mockResolvedValue({ content: '' }),
    getImpact: vi.fn().mockResolvedValue({
      file_id: '',
      direct_dependents_count: 0,
      transitive_dependents_count: 0,
      total_impact_count: 0,
      is_part_of_cycle: false,
      impacted_files: [],
    }),
  },
}));

const makeNode = (overrides?: Partial<FileNode>): FileNode => ({
  id: 'src/index.ts',
  relative_path: 'src/index.ts',
  filename: 'index.ts',
  language: 'typescript',
  size_bytes: 2048,
  file_kind: 'Source',
  analysis_status: 'Analyzed',
  direct_dependency_count: 0,
  direct_dependent_count: 0,
  ...overrides,
});

const makeEdge = (overrides?: Partial<DependencyEdge>): DependencyEdge => ({
  id: 'src/a.ts->src/b.ts',
  source_file_id: 'src/a.ts',
  target_file_id: 'src/b.ts',
  relationship_kind: 'Import',
  resolution_status: 'ResolvedInternal',
  evidence: [
    {
      source_file_id: 'src/a.ts',
      import_specifier: './b',
      line: 12,
      column: 4,
      relationship_kind: 'Import',
      is_type_only: false,
    },
  ],
  ...overrides,
});

const makeSnapshot = (overrides?: Partial<GraphSnapshot>): GraphSnapshot => ({
  schema_version: '1.0.0',
  repository_id: 'repo-test',
  revision: 1,
  nodes: [
    makeNode({ id: 'src/main.ts', relative_path: 'src/main.ts', filename: 'main.ts' }),
    makeNode({ id: 'src/utils.ts', relative_path: 'src/utils.ts', filename: 'utils.ts' }),
  ],
  edges: [
    makeEdge({ source_file_id: 'src/main.ts', target_file_id: 'src/utils.ts' }),
  ],
  coverage: {
    total_discovered: 2,
    total_analyzed: 2,
    total_excluded: 0,
    total_issues: 0,
    is_complete: true,
  },
  issues: [],
  ...overrides,
});

describe('Inspector Unit & Behavioral Tests', () => {
  // ==========================================================================
  // 1. getNodeRelationshipSentence
  // ==========================================================================
  describe('getNodeRelationshipSentence', () => {
    it('returns empty string for null or undefined input', () => {
      expect(getNodeRelationshipSentence(null)).toBe('');
    });

    it('handles Unsupported file status', () => {
      const sentence = getNodeRelationshipSentence({
        direct_dependency_count: 5,
        direct_dependent_count: 2,
        analysis_status: 'Unsupported',
      });
      expect(sentence).toBe(
        'PreBase discovered this file but does not currently analyze its internal dependencies.'
      );
    });

    it('handles Failed file status', () => {
      const sentence = getNodeRelationshipSentence({
        direct_dependency_count: 3,
        direct_dependent_count: 1,
        analysis_status: 'Failed',
      });
      expect(sentence).toBe(
        "PreBase encountered an error while parsing this file's imports."
      );
    });

    it('handles isolated file with zero dependencies and zero dependents', () => {
      const sentence = getNodeRelationshipSentence({
        direct_dependency_count: 0,
        direct_dependent_count: 0,
        analysis_status: 'Analyzed',
      });
      expect(sentence).toBe(
        'This file has no direct internal dependencies or dependents in this repository.'
      );
    });

    describe('uses internal files, 0 dependents', () => {
      it('formats singular form for 1 dependency', () => {
        const sentence = getNodeRelationshipSentence({
          direct_dependency_count: 1,
          direct_dependent_count: 0,
          analysis_status: 'Analyzed',
        });
        expect(sentence).toBe(
          'This file uses 1 internal file, and is not directly imported by any other indexed files.'
        );
      });

      it('formats plural form for multiple dependencies', () => {
        const sentence = getNodeRelationshipSentence({
          direct_dependency_count: 4,
          direct_dependent_count: 0,
          analysis_status: 'Analyzed',
        });
        expect(sentence).toBe(
          'This file uses 4 internal files, and is not directly imported by any other indexed files.'
        );
      });
    });

    describe('used by internal files, 0 dependencies', () => {
      it('formats singular form for 1 dependent', () => {
        const sentence = getNodeRelationshipSentence({
          direct_dependency_count: 0,
          direct_dependent_count: 1,
          analysis_status: 'Analyzed',
        });
        expect(sentence).toBe(
          'This file is directly used by 1 other file, and imports no other indexed files.'
        );
      });

      it('formats plural form for multiple dependents', () => {
        const sentence = getNodeRelationshipSentence({
          direct_dependency_count: 0,
          direct_dependent_count: 7,
          analysis_status: 'Analyzed',
        });
        expect(sentence).toBe(
          'This file is directly used by 7 other files, and imports no other indexed files.'
        );
      });
    });

    describe('uses internal files AND used by internal files (combinations)', () => {
      it('formats singular dependency and singular dependent (1 and 1)', () => {
        const sentence = getNodeRelationshipSentence({
          direct_dependency_count: 1,
          direct_dependent_count: 1,
          analysis_status: 'Analyzed',
        });
        expect(sentence).toBe(
          'This file uses 1 internal file and is used by 1 other file.'
        );
      });

      it('formats singular dependency and plural dependents (1 and many)', () => {
        const sentence = getNodeRelationshipSentence({
          direct_dependency_count: 1,
          direct_dependent_count: 5,
          analysis_status: 'Analyzed',
        });
        expect(sentence).toBe(
          'This file uses 1 internal file and is used by 5 other files.'
        );
      });

      it('formats plural dependencies and singular dependent (many and 1)', () => {
        const sentence = getNodeRelationshipSentence({
          direct_dependency_count: 6,
          direct_dependent_count: 1,
          analysis_status: 'Analyzed',
        });
        expect(sentence).toBe(
          'This file uses 6 internal files and is used by 1 other file.'
        );
      });

      it('formats plural dependencies and plural dependents (many and many)', () => {
        const sentence = getNodeRelationshipSentence({
          direct_dependency_count: 3,
          direct_dependent_count: 8,
          analysis_status: 'Analyzed',
        });
        expect(sentence).toBe(
          'This file uses 3 internal files and is used by 8 other files.'
        );
      });
    });
  });

  // ==========================================================================
  // 2. getEdgeRelationshipSentence
  // ==========================================================================
  describe('getEdgeRelationshipSentence', () => {
    it('formats Export edge', () => {
      const edge = makeEdge({
        source_file_id: 'src/index.ts',
        target_file_id: 'src/components/Button.tsx',
        relationship_kind: 'Export',
      });
      expect(getEdgeRelationshipSentence(edge)).toBe(
        '"src/index.ts" re-exports from "src/components/Button.tsx".'
      );
    });

    it('formats DynamicImport edge', () => {
      const edge = makeEdge({
        source_file_id: 'src/app.ts',
        target_file_id: 'src/features/chart.ts',
        relationship_kind: 'DynamicImport',
      });
      expect(getEdgeRelationshipSentence(edge)).toBe(
        '"src/app.ts" dynamically imports "src/features/chart.ts".'
      );
    });

    it('formats TypeOnly edge via relationship_kind', () => {
      const edge = makeEdge({
        source_file_id: 'src/service.ts',
        target_file_id: 'src/types.ts',
        relationship_kind: 'TypeOnly',
        evidence: [
          {
            source_file_id: 'src/service.ts',
            import_specifier: './types',
            line: 1,
            column: 1,
            relationship_kind: 'TypeOnly',
            is_type_only: true,
          },
        ],
      });
      expect(getEdgeRelationshipSentence(edge)).toBe(
        '"src/service.ts" imports type definitions from "src/types.ts".'
      );
    });

    it('formats TypeOnly edge via evidence.every(is_type_only) when kind is Import', () => {
      const edge = makeEdge({
        source_file_id: 'src/client.ts',
        target_file_id: 'src/schema.ts',
        relationship_kind: 'Import',
        evidence: [
          {
            source_file_id: 'src/client.ts',
            import_specifier: './schema',
            line: 2,
            column: 1,
            relationship_kind: 'Import',
            is_type_only: true,
          },
          {
            source_file_id: 'src/client.ts',
            import_specifier: './schema',
            line: 10,
            column: 1,
            relationship_kind: 'Import',
            is_type_only: true,
          },
        ],
      });
      expect(getEdgeRelationshipSentence(edge)).toBe(
        '"src/client.ts" imports type definitions from "src/schema.ts".'
      );
    });

    it('formats standard direct Import edge when not all evidence is type-only', () => {
      const edge = makeEdge({
        source_file_id: 'src/main.ts',
        target_file_id: 'src/utils.ts',
        relationship_kind: 'Import',
        evidence: [
          {
            source_file_id: 'src/main.ts',
            import_specifier: './utils',
            line: 1,
            column: 1,
            relationship_kind: 'Import',
            is_type_only: true,
          },
          {
            source_file_id: 'src/main.ts',
            import_specifier: './utils',
            line: 5,
            column: 1,
            relationship_kind: 'Import',
            is_type_only: false,
          },
        ],
      });
      expect(getEdgeRelationshipSentence(edge)).toBe(
        '"src/main.ts" directly imports from "src/utils.ts".'
      );
    });
  });

  // ==========================================================================
  // 3. Inspector Component Rendering Integration (renderToStaticMarkup)
  // ==========================================================================
  describe('Inspector Rendering Integration', () => {
    describe('Repository Overview (Default / Unselected View)', () => {
      it('renders null when snapshot is null', () => {
        const html = renderToStaticMarkup(
          <Inspector
            selectedNode={null}
            selectedEdge={null}
            snapshot={null}
            onSelectNode={vi.fn()}
            onClose={vi.fn()}
          />
        );
        expect(html).toBe('');
      });

      it('renders clean DAG message when zero cycle groups are detected', () => {
        const insights: ArchitecturalInsights = {
          cycle_groups: [],
          total_cycle_files: 0,
          highly_depended_files: [],
          area_couplings: [],
          diagnostics_summary: {
            total_discovered: 10,
            total_analyzed: 8,
            total_partially_analyzed: 0,
            total_unsupported: 2,
            total_failed: 0,
            total_unresolved_imports: 0,
            total_issues: 0,
          },
        };

        const snapshot = makeSnapshot({ insights });
        const html = renderToStaticMarkup(
          <Inspector
            selectedNode={null}
            selectedEdge={null}
            snapshot={snapshot}
            onSelectNode={vi.fn()}
            onClose={vi.fn()}
          />
        );

        expect(html).toContain('Repository Overview');
        expect(html).toContain('Circular Dependencies (0)');
        expect(html).toContain(
          'No circular dependencies detected. Graph is a clean DAG.'
        );
      });

      it('renders cycle groups details, example path, and type-only badge when cycles exist', () => {
        const insights: ArchitecturalInsights = {
          cycle_groups: [
            {
              id: 'cg-alpha',
              files: ['src/a.ts', 'src/b.ts'],
              example_cycle: ['src/a.ts', 'src/b.ts', 'src/a.ts'],
              is_type_only: true,
              edge_count: 2,
            },
          ],
          total_cycle_files: 2,
          highly_depended_files: [],
          area_couplings: [],
          diagnostics_summary: {
            total_discovered: 20,
            total_analyzed: 18,
            total_partially_analyzed: 1,
            total_unsupported: 1,
            total_failed: 0,
            total_unresolved_imports: 0,
            total_issues: 1,
          },
        };

        const snapshot = makeSnapshot({ insights });
        const html = renderToStaticMarkup(
          <Inspector
            selectedNode={null}
            selectedEdge={null}
            snapshot={snapshot}
            onSelectNode={vi.fn()}
            onClose={vi.fn()}
          />
        );

        expect(html).toContain('Circular Dependencies (1)');
        expect(html).toContain('Cycle Group #cg-alpha');
        expect(html).toContain('2 files');
        expect(html).toContain('type-only');
        expect(html).toContain('a.ts');
        expect(html).toContain('b.ts');
        expect(html).toContain('→');
      });

      it('renders Most Depended-On Files with file paths and usage counts', () => {
        const insights: ArchitecturalInsights = {
          cycle_groups: [],
          total_cycle_files: 0,
          highly_depended_files: [
            {
              file_id: 'src/utils/math.ts',
              relative_path: 'src/utils/math.ts',
              dependent_count: 14,
              dependency_count: 2,
            },
            {
              file_id: 'src/core/base.ts',
              relative_path: 'src/core/base.ts',
              dependent_count: 9,
              dependency_count: 0,
            },
          ],
          area_couplings: [],
          diagnostics_summary: {
            total_discovered: 15,
            total_analyzed: 15,
            total_partially_analyzed: 0,
            total_unsupported: 0,
            total_failed: 0,
            total_unresolved_imports: 0,
            total_issues: 0,
          },
        };

        const snapshot = makeSnapshot({ insights });
        const html = renderToStaticMarkup(
          <Inspector
            selectedNode={null}
            selectedEdge={null}
            snapshot={snapshot}
            onSelectNode={vi.fn()}
            onClose={vi.fn()}
          />
        );

        expect(html).toContain('Most Depended-On Files');
        expect(html).toContain('src/utils/math.ts');
        expect(html).toContain('14');
        expect(html).toContain('uses');
        expect(html).toContain('src/core/base.ts');
        expect(html).toContain('9');
      });

      it('renders Diagnostics Summary with all required metrics', () => {
        const insights: ArchitecturalInsights = {
          cycle_groups: [],
          total_cycle_files: 0,
          highly_depended_files: [],
          area_couplings: [],
          diagnostics_summary: {
            total_discovered: 50,
            total_analyzed: 40,
            total_partially_analyzed: 3,
            total_unsupported: 5,
            total_failed: 2,
            total_unresolved_imports: 7,
            total_issues: 12,
          },
        };

        const snapshot = makeSnapshot({ insights });
        const html = renderToStaticMarkup(
          <Inspector
            selectedNode={null}
            selectedEdge={null}
            snapshot={snapshot}
            onSelectNode={vi.fn()}
            onClose={vi.fn()}
          />
        );

        expect(html).toContain('Analysis Diagnostics');
        expect(html).toContain('Discovered');
        expect(html).toContain('50');
        expect(html).toContain('Analyzed');
        expect(html).toContain('40');
        expect(html).toContain('Partially Analyzed');
        expect(html).toContain('3');
        expect(html).toContain('Unsupported');
        expect(html).toContain('5');
        expect(html).toContain('Failed');
        expect(html).toContain('2');
        expect(html).toContain('Unresolved Imports');
        expect(html).toContain('7');
      });
    });

    describe('Selected Node View', () => {
      it('renders node metadata, tags, and relationship summary sentence', () => {
        const node = makeNode({
          id: 'src/components/Header.tsx',
          relative_path: 'src/components/Header.tsx',
          filename: 'Header.tsx',
          language: 'typescript',
          size_bytes: 4096,
          analysis_status: 'Analyzed',
          direct_dependency_count: 3,
          direct_dependent_count: 2,
        });

        const snapshot = makeSnapshot({ nodes: [node] });
        const html = renderToStaticMarkup(
          <Inspector
            selectedNode={node}
            selectedEdge={null}
            snapshot={snapshot}
            onSelectNode={vi.fn()}
            onClose={vi.fn()}
          />
        );

        // Header filename
        expect(html).toContain('Header.tsx');
        // File path
        expect(html).toContain('src/components/Header.tsx');
        // Metadata tags
        expect(html).toContain('typescript');
        expect(html).toContain('4.0 KB');
        expect(html).toContain('Analyzed');
        // Relationship summary sentence
        expect(html).toContain(
          'This file uses 3 internal files and is used by 2 other files.'
        );
        // Stats grid
        expect(html).toContain('Files this file uses');
        expect(html).toContain('Files that use this file');
      });

      it('renders Unsupported node with limitation box and specialized sentence', () => {
        const node = makeNode({
          id: 'docs/architecture.md',
          relative_path: 'docs/architecture.md',
          filename: 'architecture.md',
          language: 'markdown',
          size_bytes: 1024,
          analysis_status: 'Unsupported',
          direct_dependency_count: 0,
          direct_dependent_count: 0,
        });

        const snapshot = makeSnapshot({ nodes: [node] });
        const html = renderToStaticMarkup(
          <Inspector
            selectedNode={node}
            selectedEdge={null}
            snapshot={snapshot}
            onSelectNode={vi.fn()}
            onClose={vi.fn()}
          />
        );

        expect(html).toContain(
          'PreBase discovered this file but does not currently analyze its internal dependencies.'
        );
        expect(html).toContain('Non-analyzed File Format');
        expect(html).toContain('Unsupported');
      });

      it('renders Failed node with error sentence and failed tag', () => {
        const node = makeNode({
          id: 'src/broken.ts',
          relative_path: 'src/broken.ts',
          filename: 'broken.ts',
          language: 'typescript',
          size_bytes: 512,
          analysis_status: 'Failed',
          direct_dependency_count: 0,
          direct_dependent_count: 0,
        });

        const snapshot = makeSnapshot({ nodes: [node] });
        const html = renderToStaticMarkup(
          <Inspector
            selectedNode={node}
            selectedEdge={null}
            snapshot={snapshot}
            onSelectNode={vi.fn()}
            onClose={vi.fn()}
          />
        );

        expect(html).toContain(
          "PreBase encountered an error while parsing this file&#x27;s imports."
        );
        expect(html).toContain('Failed');
      });

      it('supports collapsed state via CSS class', () => {
        const node = makeNode();
        const snapshot = makeSnapshot({ nodes: [node] });
        const html = renderToStaticMarkup(
          <Inspector
            selectedNode={node}
            selectedEdge={null}
            snapshot={snapshot}
            onSelectNode={vi.fn()}
            onClose={vi.fn()}
            isCollapsed={true}
          />
        );

        expect(html).toContain('inspector-panel collapsed');
      });
    });

    describe('Selected Edge View', () => {
      it('renders relationship sentence, endpoints, and evidence specifier/location', () => {
        const edge = makeEdge({
          id: 'src/controllers/user.ts->src/models/user.ts',
          source_file_id: 'src/controllers/user.ts',
          target_file_id: 'src/models/user.ts',
          relationship_kind: 'Import',
          evidence: [
            {
              source_file_id: 'src/controllers/user.ts',
              import_specifier: '../models/user',
              line: 8,
              column: 21,
              relationship_kind: 'Import',
              is_type_only: false,
            },
          ],
        });

        const snapshot = makeSnapshot({
          nodes: [
            makeNode({
              id: 'src/controllers/user.ts',
              relative_path: 'src/controllers/user.ts',
            }),
            makeNode({
              id: 'src/models/user.ts',
              relative_path: 'src/models/user.ts',
            }),
          ],
          edges: [edge],
        });

        const html = renderToStaticMarkup(
          <Inspector
            selectedNode={null}
            selectedEdge={edge}
            snapshot={snapshot}
            onSelectNode={vi.fn()}
            onClose={vi.fn()}
          />
        );

        expect(html).toContain('Dependency Relationship');
        expect(html).toContain(
          '&quot;src/controllers/user.ts&quot; directly imports from &quot;src/models/user.ts&quot;.'
        );
        expect(html).toContain('src/controllers/user.ts');
        expect(html).toContain('src/models/user.ts');
        expect(html).toContain('&quot;../models/user&quot;');
        expect(html).toContain('line 8:21');
        expect(html).toContain('Import Evidence (1)');
      });

      it('renders TypeOnly badge and sentence for type-only edges', () => {
        const edge = makeEdge({
          id: 'src/api.ts->src/types.ts',
          source_file_id: 'src/api.ts',
          target_file_id: 'src/types.ts',
          relationship_kind: 'TypeOnly',
          evidence: [
            {
              source_file_id: 'src/api.ts',
              import_specifier: './types',
              line: 3,
              column: 1,
              relationship_kind: 'TypeOnly',
              is_type_only: true,
            },
          ],
        });

        const snapshot = makeSnapshot({
          nodes: [
            makeNode({ id: 'src/api.ts', relative_path: 'src/api.ts' }),
            makeNode({ id: 'src/types.ts', relative_path: 'src/types.ts' }),
          ],
          edges: [edge],
        });

        const html = renderToStaticMarkup(
          <Inspector
            selectedNode={null}
            selectedEdge={edge}
            snapshot={snapshot}
            onSelectNode={vi.fn()}
            onClose={vi.fn()}
          />
        );

        expect(html).toContain(
          '&quot;src/api.ts&quot; imports type definitions from &quot;src/types.ts&quot;.'
        );
        expect(html).toContain('type-badge');
        expect(html).toContain('type-only');
      });
    });
  });
});
