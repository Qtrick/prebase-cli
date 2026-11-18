import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PathExplorer } from '../PathExplorer';
import {
  DependencyPathResult,
  FileNode,
  GraphSnapshot,
} from '../../types/graph';
import { api } from '../../transport/api';

vi.mock('../../transport/api', () => ({
  api: {
    getDependencyPath: vi.fn(),
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
  direct_dependency_count: 1,
  direct_dependent_count: 1,
  ...overrides,
});

const makeSnapshot = (nodes?: FileNode[]): GraphSnapshot => ({
  schema_version: '1.0.0',
  repository_id: 'repo-test',
  revision: 1,
  nodes: nodes || [
    makeNode({ id: 'src/app.ts', relative_path: 'src/app.ts', filename: 'app.ts' }),
    makeNode({ id: 'src/router.ts', relative_path: 'src/router.ts', filename: 'router.ts' }),
    makeNode({ id: 'src/utils.ts', relative_path: 'src/utils.ts', filename: 'utils.ts' }),
    makeNode({ id: 'src/types.ts', relative_path: 'src/types.ts', filename: 'types.ts' }),
  ],
  edges: [],
  coverage: {
    total_discovered: 4,
    total_analyzed: 4,
    total_excluded: 0,
    total_issues: 0,
    is_complete: true,
  },
  issues: [],
});

describe('PathExplorer Component Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Header & Action Buttons', () => {
    it('renders title, swap endpoints button, and close button with accessibility attributes', () => {
      const html = renderToStaticMarkup(
        <PathExplorer
          initialSourceNode={null}
          snapshot={makeSnapshot()}
          onSelectNode={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(html).toContain('Dependency Path Explorer');
      expect(html).toContain('aria-label="Swap endpoints"');
      expect(html).toContain('title="Swap source and target endpoints"');
      expect(html).toContain('aria-label="Close"');
      expect(html).toContain('title="Close Path Explorer"');
    });
  });

  describe('Form Inputs and Autocomplete Candidates', () => {
    it('initializes source input with initialSourceNode relative path', () => {
      const sourceNode = makeNode({
        id: 'src/app.ts',
        relative_path: 'src/app.ts',
        filename: 'app.ts',
      });
      const html = renderToStaticMarkup(
        <PathExplorer
          initialSourceNode={sourceNode}
          snapshot={makeSnapshot()}
          onSelectNode={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(html).toContain('id="source-file-input"');
      expect(html).toContain('value="src/app.ts"');
      expect(html).toContain('id="target-file-input"');
      expect(html).toContain('value=""');
    });

    it('initializes target input with initialTargetNode relative path', () => {
      const sourceNode = makeNode({ id: 'src/app.ts', relative_path: 'src/app.ts' });
      const targetNode = makeNode({ id: 'src/router.ts', relative_path: 'src/router.ts' });
      const html = renderToStaticMarkup(
        <PathExplorer
          initialSourceNode={sourceNode}
          initialTargetNode={targetNode}
          snapshot={makeSnapshot()}
          onSelectNode={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(html).toContain('value="src/app.ts"');
      expect(html).toContain('value="src/router.ts"');
    });

    it('renders source autocomplete dropdown when initialShowSourceDropdown is true', () => {
      const snapshot = makeSnapshot();
      const html = renderToStaticMarkup(
        <PathExplorer
          initialSourceNode={makeNode({ id: 'src/app.ts', relative_path: 'src/app.ts' })}
          initialShowSourceDropdown={true}
          snapshot={snapshot}
          onSelectNode={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(html).toContain('path-autocomplete-dropdown');
      expect(html).toContain('path-autocomplete-item');
      expect(html).toContain('app.ts');
    });

    it('renders target autocomplete dropdown when initialShowTargetDropdown is true', () => {
      const snapshot = makeSnapshot();
      const html = renderToStaticMarkup(
        <PathExplorer
          initialSourceNode={null}
          initialTargetNode={makeNode({ id: 'src/router.ts', relative_path: 'src/router.ts' })}
          initialShowTargetDropdown={true}
          snapshot={snapshot}
          onSelectNode={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(html).toContain('path-autocomplete-dropdown');
      expect(html).toContain('router.ts');
    });
  });

  describe('Direction and Filter Toggle Controls', () => {
    it('sets outgoing direction active by default', () => {
      const html = renderToStaticMarkup(
        <PathExplorer
          initialSourceNode={null}
          snapshot={makeSnapshot()}
          onSelectNode={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(html).toContain('class="direction-btn active" title="Find how source depends on destination">Uses (A → B)</button>');
      expect(html).toContain('class="direction-btn " title="Find how destination depends on source">Used by (B → A)</button>');
    });

    it('sets incoming direction active when initialDirection is incoming', () => {
      const html = renderToStaticMarkup(
        <PathExplorer
          initialSourceNode={null}
          initialDirection="incoming"
          snapshot={makeSnapshot()}
          onSelectNode={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(html).toContain('class="direction-btn " title="Find how source depends on destination">Uses (A → B)</button>');
      expect(html).toContain('class="direction-btn active" title="Find how destination depends on source">Used by (B → A)</button>');
    });

    it('renders Include Types checkbox checked by default', () => {
      const html = renderToStaticMarkup(
        <PathExplorer
          initialSourceNode={null}
          snapshot={makeSnapshot()}
          onSelectNode={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(html).toContain('<input type="checkbox" checked=""/><span>Include Types</span>');
    });

    it('renders Include Types checkbox unchecked when initialIncludeTypes is false', () => {
      const html = renderToStaticMarkup(
        <PathExplorer
          initialSourceNode={null}
          initialIncludeTypes={false}
          snapshot={makeSnapshot()}
          onSelectNode={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(html).toContain('<input type="checkbox"/><span>Include Types</span>');
    });
  });

  describe('Loading and Error States', () => {
    it('renders loading state when initialLoading is true', () => {
      const html = renderToStaticMarkup(
        <PathExplorer
          initialSourceNode={null}
          initialLoading={true}
          snapshot={makeSnapshot()}
          onSelectNode={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(html).toContain('path-loading-state');
      expect(html).toContain('Tracing dependency path...');
    });

    it('renders error alert when initialError is provided', () => {
      const html = renderToStaticMarkup(
        <PathExplorer
          initialSourceNode={null}
          initialError="Failed to resolve dependency path due to network timeout"
          snapshot={makeSnapshot()}
          onSelectNode={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(html).toContain('path-error-alert');
      expect(html).toContain('Failed to resolve dependency path due to network timeout');
    });
  });

  describe('Status Result Cards', () => {
    it('renders same_file card when endpoints are identical (0 hops)', () => {
      const result: DependencyPathResult = {
        status: 'same_file',
        file_id: 'src/app.ts',
        hops: 0,
      };
      const html = renderToStaticMarkup(
        <PathExplorer
          initialSourceNode={makeNode({ id: 'src/app.ts', relative_path: 'src/app.ts' })}
          initialResult={result}
          snapshot={makeSnapshot()}
          onSelectNode={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(html).toContain('path-status-card info');
      expect(html).toContain('Source and destination are the same file (0 hops).');
    });

    it('renders not_found warning banner when no dependency path exists', () => {
      const result: DependencyPathResult = {
        status: 'not_found',
        from: 'src/app.ts',
        to: 'src/isolated.ts',
      };
      const html = renderToStaticMarkup(
        <PathExplorer
          initialSourceNode={makeNode({ id: 'src/app.ts', relative_path: 'src/app.ts' })}
          initialResult={result}
          snapshot={makeSnapshot()}
          onSelectNode={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(html).toContain('path-status-card warning');
      expect(html).toContain('No dependency path found between these files in analyzed relationships.');
    });

    it('renders missing_endpoint warning banner when endpoint is not in analyzed graph', () => {
      const result: DependencyPathResult = {
        status: 'missing_endpoint',
        missing_file_id: 'src/external.ts',
      };
      const html = renderToStaticMarkup(
        <PathExplorer
          initialSourceNode={makeNode({ id: 'src/app.ts', relative_path: 'src/app.ts' })}
          initialResult={result}
          snapshot={makeSnapshot()}
          onSelectNode={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(html).toContain('path-status-card warning');
      expect(html).toContain('One or both files are not part of the analyzed graph.');
    });
  });

  describe('Found Dependency Path Rendering', () => {
    const mockRuntimePathResult: DependencyPathResult = {
      status: 'found',
      path: {
        nodes: ['src/app.ts', 'src/router.ts', 'src/utils.ts'],
        edges: [
          {
            id: 'edge-1',
            source_file_id: 'src/app.ts',
            target_file_id: 'src/router.ts',
            relationship_kind: 'Import',
            resolution_status: 'ResolvedInternal',
            evidence: [
              {
                source_file_id: 'src/app.ts',
                import_specifier: './router',
                line: 5,
                column: 15,
                relationship_kind: 'Import',
                is_type_only: false,
              },
            ],
          },
          {
            id: 'edge-2',
            source_file_id: 'src/router.ts',
            target_file_id: 'src/utils.ts',
            relationship_kind: 'Import',
            resolution_status: 'ResolvedInternal',
            evidence: [
              {
                source_file_id: 'src/router.ts',
                import_specifier: './utils',
                line: 12,
                column: 20,
                relationship_kind: 'Import',
                is_type_only: false,
              },
            ],
          },
        ],
        hops: 2,
        is_type_only: false,
      },
    };

    it('renders path summary banner with intermediate count and hop count', () => {
      const html = renderToStaticMarkup(
        <PathExplorer
          initialSourceNode={makeNode({ id: 'src/app.ts', relative_path: 'src/app.ts' })}
          initialResult={mockRuntimePathResult}
          snapshot={makeSnapshot()}
          onSelectNode={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(html).toContain('path-summary-banner');
      expect(html).toContain('<strong>app.ts</strong> connects to <strong>utils.ts</strong>');
      expect(html).toContain('through 1 intermediate file (2 hops).');
      expect(html).not.toContain('Type-Only Path');
    });

    it('renders step sequence with index, filenames, and relationship tags', () => {
      const html = renderToStaticMarkup(
        <PathExplorer
          initialSourceNode={makeNode({ id: 'src/app.ts', relative_path: 'src/app.ts' })}
          initialResult={mockRuntimePathResult}
          snapshot={makeSnapshot()}
          onSelectNode={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(html).toContain('<span class="path-step-index">1</span>');
      expect(html).toContain('<span class="path-step-index">2</span>');
      expect(html).toContain('<span class="path-step-index">3</span>');
      expect(html).toContain('app.ts');
      expect(html).toContain('router.ts');
      expect(html).toContain('utils.ts');
      expect(html).toContain('title="Inspect src/app.ts"');
      expect(html).toContain('title="Inspect src/router.ts"');
      expect(html).toContain('title="Inspect src/utils.ts"');
      expect(html).toContain('rel-kind-tag runtime');
      expect(html).toContain('Clear Path');
    });

    it('renders Type-Only banner and type-only tags for pure type paths', () => {
      const mockTypeOnlyPath: DependencyPathResult = {
        status: 'found',
        path: {
          nodes: ['src/app.ts', 'src/types.ts'],
          edges: [
            {
              id: 'edge-type',
              source_file_id: 'src/app.ts',
              target_file_id: 'src/types.ts',
              relationship_kind: 'TypeOnly',
              resolution_status: 'ResolvedInternal',
              evidence: [
                {
                  source_file_id: 'src/app.ts',
                  import_specifier: './types',
                  line: 2,
                  column: 1,
                  relationship_kind: 'TypeOnly',
                  is_type_only: true,
                },
              ],
            },
          ],
          hops: 1,
          is_type_only: true,
        },
      };

      const html = renderToStaticMarkup(
        <PathExplorer
          initialSourceNode={makeNode({ id: 'src/app.ts', relative_path: 'src/app.ts' })}
          initialResult={mockTypeOnlyPath}
          snapshot={makeSnapshot()}
          onSelectNode={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(html).toContain('Type-Only Path');
      expect(html).toContain('This path consists entirely of type-only relationships.');
      expect(html).toContain('rel-kind-tag type-only');
      expect(html).toContain('TypeOnly');
    });

    it('renders edge evidence panel when initialExpandedEdgeId matches edge', () => {
      const html = renderToStaticMarkup(
        <PathExplorer
          initialSourceNode={makeNode({ id: 'src/app.ts', relative_path: 'src/app.ts' })}
          initialResult={mockRuntimePathResult}
          initialExpandedEdgeId="edge-1"
          snapshot={makeSnapshot()}
          onSelectNode={vi.fn()}
          onClose={vi.fn()}
        />
      );

      expect(html).toContain('edge-evidence-panel');
      expect(html).toContain('./router');
      expect(html).toContain('line 5:15');
      expect(html).toContain('Hide evidence');
    });

    it('renders View in 3D button when onSwitchTo3D is provided', () => {
      const html = renderToStaticMarkup(
        <PathExplorer
          initialSourceNode={makeNode({ id: 'src/app.ts', relative_path: 'src/app.ts' })}
          initialResult={mockRuntimePathResult}
          snapshot={makeSnapshot()}
          onSelectNode={vi.fn()}
          onClose={vi.fn()}
          onSwitchTo3D={vi.fn()}
        />
      );

      expect(html).toContain('View in 3D');
      expect(html).toContain('title="View path highlight in 3D Overview"');
    });

    it('renders Focus in 2D button when onExplore2D is provided', () => {
      const html = renderToStaticMarkup(
        <PathExplorer
          initialSourceNode={makeNode({ id: 'src/app.ts', relative_path: 'src/app.ts' })}
          initialResult={mockRuntimePathResult}
          snapshot={makeSnapshot()}
          onSelectNode={vi.fn()}
          onClose={vi.fn()}
          onExplore2D={vi.fn()}
        />
      );

      expect(html).toContain('explore-2d-btn');
      expect(html).toContain('title="Focus app.ts in 2D Relationships"');
    });
  });

  describe('API getDependencyPath Integration Contract', () => {
    it('verifies getDependencyPath parameters and response resolution', async () => {
      const mockResult: DependencyPathResult = {
        status: 'found',
        path: {
          nodes: ['src/a.ts', 'src/b.ts'],
          edges: [],
          hops: 1,
          is_type_only: false,
        },
      };

      vi.mocked(api.getDependencyPath).mockResolvedValueOnce(mockResult);

      const res = await api.getDependencyPath('src/a.ts', 'src/b.ts', 'outgoing', true);

      expect(api.getDependencyPath).toHaveBeenCalledWith(
        'src/a.ts',
        'src/b.ts',
        'outgoing',
        true
      );
      expect(res).toEqual(mockResult);
      expect(res.status).toBe('found');
    });

    it('handles api.getDependencyPath returning not_found status', async () => {
      const mockNotFound: DependencyPathResult = {
        status: 'not_found',
        from: 'src/source.ts',
        to: 'src/unreachable.ts',
      };

      vi.mocked(api.getDependencyPath).mockResolvedValueOnce(mockNotFound);

      const res = await api.getDependencyPath('src/source.ts', 'src/unreachable.ts', 'incoming', false);

      expect(res.status).toBe('not_found');
      if (res.status === 'not_found') {
        expect(res.from).toBe('src/source.ts');
        expect(res.to).toBe('src/unreachable.ts');
      }
    });
  });
});
