import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CycleGroupInspector } from '../CycleGroupInspector';
import { CycleGroup, FileNode, GraphSnapshot } from '../../types/graph';

const makeNode = (overrides?: Partial<FileNode>): FileNode => ({
  id: 'src/a.ts',
  relative_path: 'src/a.ts',
  filename: 'a.ts',
  language: 'typescript',
  size_bytes: 1024,
  file_kind: 'Source',
  analysis_status: 'Analyzed',
  direct_dependency_count: 1,
  direct_dependent_count: 1,
  ...overrides,
});

const makeCycleGroup = (overrides?: Partial<CycleGroup>): CycleGroup => ({
  id: 'cg-101',
  files: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
  example_cycle: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/a.ts'],
  is_type_only: false,
  edge_count: 3,
  classification: 'RuntimeRelevant',
  ...overrides,
});

const makeSnapshot = (overrides?: Partial<GraphSnapshot>): GraphSnapshot => ({
  schema_version: '1.0.0',
  repository_id: 'repo-test',
  revision: 1,
  nodes: [
    makeNode({ id: 'src/a.ts', relative_path: 'src/a.ts', filename: 'a.ts' }),
    makeNode({ id: 'src/b.ts', relative_path: 'src/b.ts', filename: 'b.ts' }),
    makeNode({ id: 'src/c.ts', relative_path: 'src/c.ts', filename: 'c.ts' }),
  ],
  edges: [],
  coverage: {
    total_discovered: 3,
    total_analyzed: 3,
    total_excluded: 0,
    total_issues: 0,
    is_complete: true,
  },
  issues: [],
  ...overrides,
});

describe('CycleGroupInspector Component Tests', () => {
  describe('Header and Metadata Rendering', () => {
    it('renders cycle group title with ID and accessibility label', () => {
      const cg = makeCycleGroup({ id: 'group-42' });
      const html = renderToStaticMarkup(
        <CycleGroupInspector
          cycleGroup={cg}
          snapshot={makeSnapshot()}
          onSelectNode={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(html).toContain('aria-label="Cycle Group group-42"');
      expect(html).toContain('Circular Dependency Group #group-42');
    });

    it('renders Close button with aria-label and title', () => {
      const html = renderToStaticMarkup(
        <CycleGroupInspector
          cycleGroup={makeCycleGroup()}
          snapshot={makeSnapshot()}
          onSelectNode={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(html).toContain('aria-label="Close"');
      expect(html).toContain('title="Close cycle inspector"');
    });

    it('renders Clear Focus button when onClearFocus prop is provided', () => {
      const html = renderToStaticMarkup(
        <CycleGroupInspector
          cycleGroup={makeCycleGroup()}
          snapshot={makeSnapshot()}
          onSelectNode={vi.fn()}
          onClose={vi.fn()}
          onClearFocus={vi.fn()}
        />
      );

      expect(html).toContain('Clear Focus');
      expect(html).toContain('title="Clear group focus in graph"');
    });

    it('omits Clear Focus button when onClearFocus prop is not provided', () => {
      const html = renderToStaticMarkup(
        <CycleGroupInspector
          cycleGroup={makeCycleGroup()}
          snapshot={makeSnapshot()}
          onSelectNode={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(html).not.toContain('Clear Focus');
      expect(html).not.toContain('title="Clear group focus in graph"');
    });
  });

  describe('Classification Badges and Explanations', () => {
    it('renders Runtime-Relevant cycle classification badge and explanation', () => {
      const cg = makeCycleGroup({
        classification: 'RuntimeRelevant',
        edge_count: 4,
      });
      const html = renderToStaticMarkup(
        <CycleGroupInspector
          cycleGroup={cg}
          snapshot={makeSnapshot()}
          onSelectNode={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(html).toContain('Runtime-Relevant Cycle');
      expect(html).toContain('color:#ef4444');
      expect(html).toContain('initialization deadlocks or undefined imports');
      expect(html).toContain('4 internal edges');
    });

    it('renders Mixed Structural cycle classification badge and explanation', () => {
      const cg = makeCycleGroup({
        classification: 'MixedStructural',
        edge_count: 5,
      });
      const html = renderToStaticMarkup(
        <CycleGroupInspector
          cycleGroup={cg}
          snapshot={makeSnapshot()}
          onSelectNode={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(html).toContain('Mixed Structural Cycle');
      expect(html).toContain('color:#f59e0b');
      expect(html).toContain('combination of runtime and type-only dependencies');
      expect(html).toContain('tight architectural coupling remains');
      expect(html).toContain('5 internal edges');
    });

    it('renders Type-Only cycle classification badge and explanation', () => {
      const cg = makeCycleGroup({
        classification: 'TypeOnly',
        is_type_only: true,
        edge_count: 2,
      });
      const html = renderToStaticMarkup(
        <CycleGroupInspector
          cycleGroup={cg}
          snapshot={makeSnapshot()}
          onSelectNode={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(html).toContain('Type-Only Cycle');
      expect(html).toContain('color:#38bdf8');
      expect(html).toContain('TypeScript type-only imports');
      expect(html).toContain('erased during compilation');
      expect(html).toContain('2 internal edges');
    });

    it('falls back to is_type_only = true when classification field is undefined', () => {
      const cg = makeCycleGroup({
        classification: undefined,
        is_type_only: true,
        edge_count: 1,
      });
      const html = renderToStaticMarkup(
        <CycleGroupInspector
          cycleGroup={cg}
          snapshot={makeSnapshot()}
          onSelectNode={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(html).toContain('Type-Only Cycle');
      expect(html).toContain('1 internal edge');
      expect(html).not.toContain('1 internal edges');
    });

    it('falls back to RuntimeRelevant when classification is undefined and is_type_only = false', () => {
      const cg = makeCycleGroup({
        classification: undefined,
        is_type_only: false,
        edge_count: 1,
      });
      const html = renderToStaticMarkup(
        <CycleGroupInspector
          cycleGroup={cg}
          snapshot={makeSnapshot()}
          onSelectNode={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(html).toContain('Runtime-Relevant Cycle');
      expect(html).toContain('1 internal edge');
    });
  });

  describe('Metrics Grid and Architectural Areas', () => {
    it('renders participating file count, internal edges, and areas involved', () => {
      const cg = makeCycleGroup({
        files: [
          'frontend/src/api.ts',
          'frontend/src/inspector/Inspector.tsx',
          'crates/prebase-core/src/lib.rs',
        ],
        edge_count: 3,
      });
      const html = renderToStaticMarkup(
        <CycleGroupInspector
          cycleGroup={cg}
          snapshot={makeSnapshot()}
          onSelectNode={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(html).toContain('<span class="metric-val font-semibold">3</span><span class="metric-label text-xs text-muted">Participating Files</span>');
      expect(html).toContain('<span class="metric-val font-semibold">3</span><span class="metric-label text-xs text-muted">Internal Edges</span>');
      expect(html).toContain('Areas Involved');
      expect(html).toContain('Architectural Areas');
    });

    it('omits Architectural Areas section if areas involved is empty', () => {
      const cg = makeCycleGroup({
        files: [],
        edge_count: 0,
      });
      const html = renderToStaticMarkup(
        <CycleGroupInspector
          cycleGroup={cg}
          snapshot={makeSnapshot()}
          onSelectNode={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(html).not.toContain('Architectural Areas');
    });
  });

  describe('Concrete Example Cycle Sequence', () => {
    it('renders step-by-step cycle sequence with filenames and hop count', () => {
      const cg = makeCycleGroup({
        example_cycle: ['src/services/auth.ts', 'src/api/client.ts', 'src/services/auth.ts'],
      });
      const html = renderToStaticMarkup(
        <CycleGroupInspector
          cycleGroup={cg}
          snapshot={makeSnapshot({
            nodes: [
              makeNode({ id: 'src/services/auth.ts', relative_path: 'src/services/auth.ts', filename: 'auth.ts' }),
              makeNode({ id: 'src/api/client.ts', relative_path: 'src/api/client.ts', filename: 'client.ts' }),
            ],
          })}
          onSelectNode={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(html).toContain('Verified Example Path (2 hops)');
      expect(html).toContain('title="Inspect src/services/auth.ts"');
      expect(html).toContain('title="Inspect src/api/client.ts"');
      expect(html).toContain('cycle-step-node clickable');
      expect(html).toContain('auth.ts');
      expect(html).toContain('client.ts');
      expect(html).toContain('cycle-step-arrow');
    });

    it('omits Verified Example Path section when example_cycle is empty', () => {
      const cg = makeCycleGroup({ example_cycle: [] });
      const html = renderToStaticMarkup(
        <CycleGroupInspector
          cycleGroup={cg}
          snapshot={makeSnapshot()}
          onSelectNode={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(html).not.toContain('Verified Example Path');
    });
  });

  describe('Participating Files List & Filtering', () => {
    it('omits filter input when file count is 8 or fewer', () => {
      const cg = makeCycleGroup({
        files: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      });
      const html = renderToStaticMarkup(
        <CycleGroupInspector
          cycleGroup={cg}
          snapshot={makeSnapshot()}
          onSelectNode={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(html).toContain('Participating Files (3)');
      expect(html).not.toContain('member-filter-input');
      expect(html).not.toContain('placeholder="Filter files..."');
    });

    it('renders filter input when file count exceeds 8', () => {
      const files = Array.from({ length: 10 }, (_, i) => `src/file_${i}.ts`);
      const cg = makeCycleGroup({ files });
      const html = renderToStaticMarkup(
        <CycleGroupInspector
          cycleGroup={cg}
          snapshot={makeSnapshot()}
          onSelectNode={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(html).toContain('Participating Files (10)');
      expect(html).toContain('member-filter-input');
      expect(html).toContain('placeholder="Filter files..."');
    });

    it('filters member list when initialMemberFilter is provided', () => {
      const files = [
        'src/services/userService.ts',
        'src/services/authService.ts',
        'src/utils/math.ts',
        'src/utils/format.ts',
        'src/components/Button.tsx',
        'src/components/Input.tsx',
        'src/hooks/useUser.ts',
        'src/hooks/useAuth.ts',
        'src/types/index.ts',
      ];
      const cg = makeCycleGroup({ files });
      const html = renderToStaticMarkup(
        <CycleGroupInspector
          cycleGroup={cg}
          snapshot={makeSnapshot()}
          onSelectNode={vi.fn()}
          onClose={vi.fn()}
          initialMemberFilter="service"
        />
      );

      expect(html).toContain('userService.ts');
      expect(html).toContain('authService.ts');
      expect(html).not.toContain('math.ts');
      expect(html).not.toContain('format.ts');
      expect(html).not.toContain('Button.tsx');
    });

    it('limits initial display to 15 files and renders Show all button when count exceeds 15', () => {
      const files = Array.from({ length: 20 }, (_, i) => `src/file_${i.toString().padStart(2, '0')}.ts`);
      const cg = makeCycleGroup({ files });
      const html = renderToStaticMarkup(
        <CycleGroupInspector
          cycleGroup={cg}
          snapshot={makeSnapshot()}
          onSelectNode={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(html).toContain('file_00.ts');
      expect(html).toContain('file_14.ts');
      expect(html).not.toContain('file_15.ts');
      expect(html).toContain('Show all 20 files');
      expect(html).toContain('show-more-members-btn');
    });

    it('renders all members and Show less button when initialShowAllMembers is true', () => {
      const files = Array.from({ length: 20 }, (_, i) => `src/file_${i.toString().padStart(2, '0')}.ts`);
      const cg = makeCycleGroup({ files });
      const html = renderToStaticMarkup(
        <CycleGroupInspector
          cycleGroup={cg}
          snapshot={makeSnapshot()}
          onSelectNode={vi.fn()}
          onClose={vi.fn()}
          initialShowAllMembers={true}
        />
      );

      expect(html).toContain('file_00.ts');
      expect(html).toContain('file_14.ts');
      expect(html).toContain('file_15.ts');
      expect(html).toContain('file_19.ts');
      expect(html).toContain('Show less');
    });

    it('gracefully tolerates null snapshot', () => {
      const cg = makeCycleGroup();
      const html = renderToStaticMarkup(
        <CycleGroupInspector
          cycleGroup={cg}
          snapshot={null}
          onSelectNode={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(html).toContain('Circular Dependency Group #cg-101');
      expect(html).toContain('Participating Files (3)');
      expect(html).toContain('a.ts');
      expect(html).toContain('b.ts');
      expect(html).toContain('c.ts');
    });
  });
});
