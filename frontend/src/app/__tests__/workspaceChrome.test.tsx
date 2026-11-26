import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Layers, Compass, Filter, ZoomIn, ZoomOut, Maximize2, RotateCcw, Target, SlidersHorizontal, X } from 'lucide-react';
import { FileNode } from '../../types/graph';
import { isEditableElement, rankSearchResults } from '../../search/SearchBox';
import { shouldIgnoreGlobalShortcut } from '../App';

// Helper fixtures
const makeNode = (id: string, relativePath: string, filename?: string): FileNode => ({
  id,
  relative_path: relativePath,
  filename: filename || relativePath.split('/').pop() || id,
  language: 'typescript',
  size_bytes: 1200,
  file_kind: 'Source',
  analysis_status: 'Analyzed',
  direct_dependency_count: 2,
  direct_dependent_count: 3,
});

/**
 * A representative Workspace Chrome renderer mirroring App.tsx's unified in-flow chrome layout.
 */
interface MockWorkspaceChromeProps {
  activeTab: 'network' | 'temporal';
  networkViewMode?: '3d' | '2d';
  selectedAreaId?: string | null;
  selectedNode?: FileNode | null;
  selectedAreaEdge?: { sourceAreaId: string; targetAreaId: string; edgeCount: number } | null;
  keepGraphCentered?: boolean;
  hideGroupLabelsOnMovement?: boolean;
  isFilterMenuOpen?: boolean;
  isViewMenuOpen?: boolean;
  selectedLanguageFilter?: string;
  sourceOnlyFilter?: boolean;
}

function MockWorkspaceChrome({
  activeTab,
  networkViewMode = '3d',
  selectedAreaId = null,
  selectedNode = null,
  selectedAreaEdge = null,
  keepGraphCentered = true,
  hideGroupLabelsOnMovement = false,
  isFilterMenuOpen = false,
  isViewMenuOpen = false,
  selectedLanguageFilter = 'all',
  sourceOnlyFilter = false,
}: MockWorkspaceChromeProps) {
  return (
    <div className="workspace-chrome">
      <header className="workspace-header primary-toolbar" role="toolbar" aria-label="Workspace controls">
        <div className="primary-toolbar-left">
          {activeTab === 'network' ? (
            <div className="search-box-container">
              <div className="search-input-wrap">
                <input
                  type="text"
                  className="search-input"
                  placeholder="Search files..."
                  role="combobox"
                  aria-expanded="false"
                  aria-autocomplete="list"
                  aria-label="Search files"
                />
                <span className="search-kbd-hint">/</span>
              </div>
            </div>
          ) : (
            <div className="temporal-header-info">
              <span>Commit history</span>
            </div>
          )}
        </div>

        {activeTab === 'network' && (
          <div className="workspace-header-actions primary-toolbar-right">
            <div className="network-mode-switcher" role="radiogroup" aria-label="Network View Mode">
              <button
                className={`mode-btn ${networkViewMode === '3d' ? 'active' : ''}`}
                title="3D Repository Overview (Shortcut: V)"
                role="radio"
                aria-checked={networkViewMode === '3d'}
              >
                <Layers size={13} />
                <span className="mode-full-label">3D Overview</span>
                <span className="mode-short-label">3D</span>
              </button>
              <button
                className={`mode-btn ${networkViewMode === '2d' ? 'active' : ''}`}
                title="Contextual 2D Relationship Explorer (Shortcut: V)"
                role="radio"
                aria-checked={networkViewMode === '2d'}
              >
                <Compass size={13} />
                <span className="mode-full-label">2D Relationships</span>
                <span className="mode-short-label">2D</span>
              </button>
            </div>

            <div className="toolbar-menu-anchor">
              <button
                className={`toolbar-btn ${selectedLanguageFilter !== 'all' || sourceOnlyFilter ? 'active' : ''}`}
                title="Filter repository files by scope or language"
                aria-haspopup="menu"
                aria-expanded={isFilterMenuOpen}
              >
                <Filter size={13} />
                <span className="btn-label">Filters</span>
                {(selectedLanguageFilter !== 'all' || sourceOnlyFilter) && <span className="active-filter-dot" />}
              </button>
              {isFilterMenuOpen && (
                <div className="toolbar-dropdown-menu" role="menu" aria-label="Filter graph files">
                  <div className="menu-group-header">File Visibility</div>
                  <button
                    className={`menu-item ${!sourceOnlyFilter ? 'selected' : ''}`}
                    role="menuitemradio"
                    aria-checked={!sourceOnlyFilter}
                  >
                    <span>All Discovered Files</span>
                  </button>
                  <button
                    className={`menu-item ${sourceOnlyFilter ? 'selected' : ''}`}
                    role="menuitemradio"
                    aria-checked={sourceOnlyFilter}
                  >
                    <span>Analyzed Code Only</span>
                  </button>
                </div>
              )}
            </div>

            <div className="action-btn-group view-controls">
              <button id="zoomIn" className="ctrl-btn icon-only btn-secondary" title="Zoom In (Shortcut: +)" aria-label="Zoom in">
                <ZoomIn size={14} />
              </button>
              <button id="zoomOut" className="ctrl-btn icon-only btn-secondary" title="Zoom Out (Shortcut: -)" aria-label="Zoom out">
                <ZoomOut size={14} />
              </button>
              <button id="fitView" className="ctrl-btn icon-only" title="Fit View (Shortcut: F)" aria-label="Fit view">
                <Maximize2 size={14} />
              </button>
              <button id="resetCam" className="ctrl-btn icon-only" title="Reset Camera (Shortcut: R)" aria-label="Reset camera">
                <RotateCcw size={14} />
              </button>
              {networkViewMode === '3d' && (
                <button
                  id="centerLock"
                  className={`ctrl-btn icon-only ${keepGraphCentered ? 'active' : ''}`}
                  title="Keep graph centered"
                  role="checkbox"
                  aria-checked={keepGraphCentered}
                  aria-label="Keep graph centered"
                >
                  <Target size={14} />
                </button>
              )}
              <div className="toolbar-menu-anchor">
                <button
                  className="ctrl-btn icon-only"
                  title="Export & view utilities"
                  aria-haspopup="menu"
                  aria-expanded={isViewMenuOpen}
                  aria-label="More view options"
                >
                  <SlidersHorizontal size={14} />
                </button>
                {isViewMenuOpen && (
                  <div className="toolbar-dropdown-menu right-aligned view-options-menu" role="menu" aria-label="View options">
                    {networkViewMode === '3d' && (
                      <button
                        type="button"
                        className="menu-item menu-item-checkbox"
                        role="menuitemcheckbox"
                        aria-checked={hideGroupLabelsOnMovement}
                      >
                        <span className="menu-item-label">Hide group labels upon graph movement</span>
                      </button>
                    )}
                    <button className="menu-item" role="menuitem">
                      <span>Export PNG</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </header>

      {/* Contextual Navigation Bar in normal DOM flow */}
      {activeTab === 'network' && (
        <nav className="context-nav-bar" role="navigation" aria-label="Graph Level Navigation">
          <div className="network-breadcrumb-bar in-flow">
            <button
              type="button"
              className={`crumb-btn ${!selectedAreaId && !selectedNode && !selectedAreaEdge ? 'active' : ''}`}
              title="Return to Repository Overview"
            >
              <Layers size={12} className="crumb-icon" />
              <span>Overview</span>
            </button>

            {selectedAreaId && (
              <>
                <span className="crumb-sep" aria-hidden="true">/</span>
                <button
                  type="button"
                  className={`crumb-btn ${!selectedNode && !selectedAreaEdge ? 'active' : ''}`}
                  title={`Area: ${selectedAreaId}`}
                >
                  <span className="crumb-label">Area:</span>
                  <span className="crumb-target truncate">{selectedAreaId}</span>
                </button>
              </>
            )}

            {selectedNode && (
              <>
                <span className="crumb-sep" aria-hidden="true">/</span>
                <span className="crumb-current" title={selectedNode.relative_path || selectedNode.filename}>
                  <span className="crumb-text truncate">{selectedNode.filename}</span>
                </span>
                <button
                  type="button"
                  className="crumb-clear-btn"
                  title="Deselect file"
                  aria-label="Deselect file"
                >
                  <X size={12} />
                </button>
              </>
            )}

            {selectedAreaEdge && !selectedNode && (
              <>
                <span className="crumb-sep" aria-hidden="true">/</span>
                <span
                  className="crumb-current relationship-crumb"
                  title={`${selectedAreaEdge.sourceAreaId} → ${selectedAreaEdge.targetAreaId} (${selectedAreaEdge.edgeCount} links)`}
                >
                  <span className="crumb-text truncate">
                    {selectedAreaEdge.sourceAreaId} → {selectedAreaEdge.targetAreaId} ({selectedAreaEdge.edgeCount})
                  </span>
                </span>
                <button
                  type="button"
                  className="crumb-clear-btn"
                  title="Deselect area relationship"
                  aria-label="Deselect area relationship"
                >
                  <X size={12} />
                </button>
              </>
            )}
          </div>
        </nav>
      )}
    </div>
  );
}

describe('Workspace Chrome & Contextual Navigation Suite', () => {
  describe('Semantic Structure & Accessibility Attributes', () => {
    it('renders primary toolbar with role="toolbar" and aria-label="Workspace controls"', () => {
      const html = renderToStaticMarkup(<MockWorkspaceChrome activeTab="network" />);
      expect(html).toContain('role="toolbar"');
      expect(html).toContain('aria-label="Workspace controls"');
      expect(html).toContain('class="workspace-header primary-toolbar"');
    });

    it('renders contextual nav bar with role="navigation" and aria-label="Graph Level Navigation"', () => {
      const html = renderToStaticMarkup(<MockWorkspaceChrome activeTab="network" />);
      expect(html).toContain('role="navigation"');
      expect(html).toContain('aria-label="Graph Level Navigation"');
      expect(html).toContain('class="context-nav-bar"');
    });

    it('renders network-mode-switcher as a proper radio group with aria-checked states', () => {
      // 3D Active
      const html3d = renderToStaticMarkup(<MockWorkspaceChrome activeTab="network" networkViewMode="3d" />);
      expect(html3d).toContain('role="radiogroup"');
      expect(html3d).toContain('aria-label="Network View Mode"');
      expect(html3d).toMatch(/role="radio"[^>]*aria-checked="true"[^>]*>.*3D Overview/);
      expect(html3d).toMatch(/role="radio"[^>]*aria-checked="false"[^>]*>.*2D Relationships/);

      // 2D Active
      const html2d = renderToStaticMarkup(<MockWorkspaceChrome activeTab="network" networkViewMode="2d" />);
      expect(html2d).toMatch(/role="radio"[^>]*aria-checked="false"[^>]*>.*3D Overview/);
      expect(html2d).toMatch(/role="radio"[^>]*aria-checked="true"[^>]*>.*2D Relationships/);
    });

    it('renders center lock toggle button as a semantic checkbox with aria-checked', () => {
      const htmlLocked = renderToStaticMarkup(<MockWorkspaceChrome activeTab="network" keepGraphCentered={true} />);
      expect(htmlLocked).toContain('id="centerLock"');
      expect(htmlLocked).toContain('role="checkbox"');
      expect(htmlLocked).toContain('aria-checked="true"');

      const htmlUnlocked = renderToStaticMarkup(<MockWorkspaceChrome activeTab="network" keepGraphCentered={false} />);
      expect(htmlUnlocked).toContain('aria-checked="false"');
    });

    it('renders accessible labels on all view control buttons', () => {
      const html = renderToStaticMarkup(<MockWorkspaceChrome activeTab="network" />);
      expect(html).toContain('aria-label="Zoom in"');
      expect(html).toContain('aria-label="Zoom out"');
      expect(html).toContain('aria-label="Fit view"');
      expect(html).toContain('aria-label="Reset camera"');
      expect(html).toContain('aria-label="More view options"');
    });
  });

  describe('Contextual Navigation Breadcrumb States', () => {
    it('State A: renders active Overview breadcrumb when in repository overview', () => {
      const html = renderToStaticMarkup(
        <MockWorkspaceChrome
          activeTab="network"
          selectedAreaId={null}
          selectedNode={null}
          selectedAreaEdge={null}
        />
      );

      expect(html).toContain('crumb-btn active');
      expect(html).toContain('Overview');
      expect(html).not.toContain('crumb-sep');
      expect(html).not.toContain('crumb-clear-btn');
    });

    it('State B: renders Area breadcrumb with truncation when area is selected', () => {
      const html = renderToStaticMarkup(
        <MockWorkspaceChrome
          activeTab="network"
          selectedAreaId="frontend/src/graphs/network"
          selectedNode={null}
        />
      );

      expect(html).toContain('Overview');
      expect(html).toContain('crumb-sep');
      expect(html).toContain('Area:');
      expect(html).toContain('frontend/src/graphs/network');
      expect(html).toContain('class="crumb-target truncate"');
      expect(html).toContain('title="Area: frontend/src/graphs/network"');
    });

    it('State C: renders file crumb and interactable clear button when file is selected', () => {
      const node = makeNode('src/components/Header.tsx', 'src/components/Header.tsx', 'Header.tsx');
      const html = renderToStaticMarkup(
        <MockWorkspaceChrome
          activeTab="network"
          selectedAreaId="src/components"
          selectedNode={node}
        />
      );

      expect(html).toContain('Area:');
      expect(html).toContain('src/components');
      expect(html).toContain('Header.tsx');
      expect(html).toContain('class="crumb-text truncate"');
      expect(html).toContain('title="src/components/Header.tsx"');
      expect(html).toContain('class="crumb-clear-btn"');
      expect(html).toContain('aria-label="Deselect file"');
    });

    it('State D: renders area relationship crumb and clear button when area edge is selected', () => {
      const areaEdge = {
        sourceAreaId: 'frontend/src/transport',
        targetAreaId: 'frontend/src/utils',
        edgeCount: 7,
      };

      const html = renderToStaticMarkup(
        <MockWorkspaceChrome
          activeTab="network"
          selectedAreaEdge={areaEdge}
        />
      );

      expect(html).toContain('relationship-crumb');
      expect(html).toContain('frontend/src/transport → frontend/src/utils (7)');
      expect(html).toContain('class="crumb-clear-btn"');
      expect(html).toContain('aria-label="Deselect area relationship"');
      expect(html).toContain('title="frontend/src/transport → frontend/src/utils (7 links)"');
    });

    it('Long Text Handling: truncates excessively long paths while preserving full title attribute', () => {
      const longFilename = 'SupercalifragilisticexpialidociousLongComponentWithMassiveFilenameThatExceedsStandardBounds.tsx';
      const longPath = `src/features/deeply/nested/modules/${longFilename}`;
      const longNode = makeNode('long-node', longPath, longFilename);

      const html = renderToStaticMarkup(
        <MockWorkspaceChrome
          activeTab="network"
          selectedAreaId="src/features/deeply/nested/modules"
          selectedNode={longNode}
        />
      );

      // Must have truncate class
      expect(html).toContain('class="crumb-text truncate"');
      expect(html).toContain('class="crumb-target truncate"');
      // Full title must be retained for tooltip
      expect(html).toContain(`title="${longPath}"`);
      expect(html).toContain(longFilename);
    });
  });

  describe('Dropdown Menus & Popover Accessibility', () => {
    it('renders filter dropdown with role="menu" and role="menuitemradio" items when open', () => {
      const html = renderToStaticMarkup(
        <MockWorkspaceChrome activeTab="network" isFilterMenuOpen={true} />
      );

      expect(html).toContain('aria-expanded="true"');
      expect(html).toContain('class="toolbar-dropdown-menu"');
      expect(html).toContain('role="menu"');
      expect(html).toContain('aria-label="Filter graph files"');
      expect(html).toContain('role="menuitemradio"');
      expect(html).toContain('All Discovered Files');
      expect(html).toContain('Analyzed Code Only');
    });

    it('renders view utilities dropdown with role="menu" and Hide group labels checkbox when open', () => {
      const htmlUnchecked = renderToStaticMarkup(
        <MockWorkspaceChrome
          activeTab="network"
          networkViewMode="3d"
          isViewMenuOpen={true}
          hideGroupLabelsOnMovement={false}
        />
      );

      expect(htmlUnchecked).toContain('class="toolbar-dropdown-menu right-aligned view-options-menu"');
      expect(htmlUnchecked).toContain('role="menu"');
      expect(htmlUnchecked).toContain('aria-label="View options"');
      expect(htmlUnchecked).toContain('role="menuitemcheckbox"');
      expect(htmlUnchecked).toMatch(/role="menuitemcheckbox"[^>]*aria-checked="false"[^>]*>.*Hide group labels upon graph movement/);
      expect(htmlUnchecked).toContain('Export PNG');

      const htmlChecked = renderToStaticMarkup(
        <MockWorkspaceChrome
          activeTab="network"
          networkViewMode="3d"
          isViewMenuOpen={true}
          hideGroupLabelsOnMovement={true}
        />
      );

      expect(htmlChecked).toMatch(/role="menuitemcheckbox"[^>]*aria-checked="true"[^>]*>.*Hide group labels upon graph movement/);
    });
  });

  describe('Keyboard Navigation & Input Safety Guards', () => {
    it('isEditableElement correctly identifies text inputs, textareas, selects, and contenteditable', () => {
      expect(isEditableElement(null)).toBe(false);
      expect(isEditableElement({ tagName: 'DIV' } as any)).toBe(false);
      expect(isEditableElement({ tagName: 'BUTTON' } as any)).toBe(false);

      expect(isEditableElement({ tagName: 'INPUT' } as any)).toBe(true);
      expect(isEditableElement({ tagName: 'TEXTAREA' } as any)).toBe(true);
      expect(isEditableElement({ tagName: 'SELECT' } as any)).toBe(true);
      expect(isEditableElement({ tagName: 'DIV', isContentEditable: true } as any)).toBe(true);
    });

    it('shouldIgnoreGlobalShortcut prevents hotkeys from firing when typing in search input', () => {
      const fakeInputEvent = {
        target: { tagName: 'INPUT' },
      } as unknown as KeyboardEvent;

      expect(shouldIgnoreGlobalShortcut(fakeInputEvent)).toBe(true);

      const fakeBodyEvent = {
        target: { tagName: 'BODY' },
      } as unknown as KeyboardEvent;

      expect(shouldIgnoreGlobalShortcut(fakeBodyEvent)).toBe(false);
    });

    it('rankSearchResults deterministically ranks exact matches, prefixes, and substrings', () => {
      const files: FileNode[] = [
        makeNode('1', 'src/components/Header.tsx', 'Header.tsx'),
        makeNode('2', 'src/components/HeaderModal.tsx', 'HeaderModal.tsx'),
        makeNode('3', 'src/utils/math.ts', 'math.ts'),
        makeNode('4', 'src/types.ts', 'types.ts'),
      ];

      // Exact match gets highest ranking
      const results = rankSearchResults(files, 'Header.tsx');
      expect(results[0].filename).toBe('Header.tsx');

      // Prefix match
      const prefixResults = rankSearchResults(files, 'Header');
      expect(prefixResults.map((r) => r.filename)).toContain('Header.tsx');
      expect(prefixResults.map((r) => r.filename)).toContain('HeaderModal.tsx');

      // Empty query returns top connected hubs
      const emptyResults = rankSearchResults(files, '');
      expect(emptyResults.length).toBeGreaterThan(0);
    });
  });

  describe('Responsive Mode Switching & In-Flow Invariants', () => {
    it('includes both mode-full-label and mode-short-label for responsive CSS container queries', () => {
      const html = renderToStaticMarkup(<MockWorkspaceChrome activeTab="network" />);
      expect(html).toContain('class="mode-full-label"');
      expect(html).toContain('class="mode-short-label"');
      expect(html).toContain('3D Overview');
      expect(html).toContain('3D');
      expect(html).toContain('2D Relationships');
      expect(html).toContain('2D');
    });

    it('uses .in-flow class on breadcrumb bar to prevent absolute positioning collisions', () => {
      const html = renderToStaticMarkup(<MockWorkspaceChrome activeTab="network" />);
      expect(html).toContain('network-breadcrumb-bar in-flow');
    });

    it('switches to temporal header info when activeTab is temporal', () => {
      const html = renderToStaticMarkup(<MockWorkspaceChrome activeTab="temporal" />);
      expect(html).toContain('temporal-header-info');
      expect(html).toContain('Commit history');
      expect(html).not.toContain('network-mode-switcher');
      expect(html).not.toContain('context-nav-bar');
    });
  });
});
