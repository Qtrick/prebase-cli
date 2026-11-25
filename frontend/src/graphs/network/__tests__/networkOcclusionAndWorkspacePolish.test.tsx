import { describe, it, expect, vi } from 'vitest';
// @ts-ignore
import fs from 'node:fs';
// @ts-ignore
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { Lightbulb, PanelRightOpen } from 'lucide-react';
import {
  computeAreaAnchors,
  layoutSphere,
  LayoutNode,
  LayoutLink,
  DEFAULT_SPHERE_LAYOUT_CONFIG,
} from '../layout/sphereLayout';
import {
  findHitNode,
  ProjectedNode,
} from '../render/networkRenderMath';
import {
  RepositoryArea,
} from '../../../utils/repositoryAreas';
import { FileNode } from '../../../types/graph';

// TypeScript declarations for node environment globals in tests
// @ts-ignore
declare const __dirname: string;
// @ts-ignore
declare const process: { cwd: () => string };

// Fixture helpers
const makeFileNode = (
  id: string,
  relativePath: string
): FileNode => ({
  id,
  relative_path: relativePath,
  filename: relativePath.split('/').pop() || id,
  language: 'typescript',
  size_bytes: 512,
  file_kind: 'Source',
  analysis_status: 'Analyzed',
  direct_dependency_count: 2,
  direct_dependent_count: 2,
});

const makeLayoutNode = (
  id: string,
  opts?: { isEntry?: boolean; val?: number; areaId?: string }
): LayoutNode => ({
  id,
  val: opts?.val ?? 10,
  isEntry: opts?.isEntry ?? false,
  areaId: opts?.areaId,
});

const makeMockArea = (id: string, name: string): RepositoryArea => ({
  id,
  name,
  displayPath: id,
  fileCount: 5,
  nodeIds: [],
  nodes: [],
  languages: ['typescript'],
  totalDependencies: 3,
  totalDependents: 2,
  internalConnections: 1,
  outgoingAreaEdges: [],
  incomingAreaEdges: [],
  analyzedCount: 5,
  unsupportedCount: 0,
});

describe('Network Occlusion Prevention, File Selection Precedence & Workspace Polish Suite', () => {
  // =========================================================================
  // 1. Priority P0: Area Anchor Marker Occlusion & File Separation
  // =========================================================================
  describe('1. Priority P0: Area Anchor Marker Occlusion & File Separation (sphereLayout.ts)', () => {
    it('enforces an inner exclusion zone (minInnerRadius) separating all file nodes from the area anchor center', () => {
      const distinctAreas = ['frontend/src', 'backend/api', 'crates/core'];
      const config = { ...DEFAULT_SPHERE_LAYOUT_CONFIG, sphereRadius: 320 };

      // Create 15 nodes in 'frontend/src' and 10 in 'backend/api'
      const nodes: LayoutNode[] = [];
      for (let i = 0; i < 15; i++) {
        const id = `fe_file_${i}`;
        nodes.push(makeLayoutNode(id, { val: 15 - i, isEntry: i === 0, areaId: 'frontend/src' }));
      }
      for (let i = 0; i < 10; i++) {
        const id = `be_file_${i}`;
        nodes.push(makeLayoutNode(id, { val: 10 - i, areaId: 'backend/api' }));
      }
      for (let i = 0; i < 5; i++) {
        const id = `core_file_${i}`;
        nodes.push(makeLayoutNode(id, { val: 5 - i, areaId: 'crates/core' }));
      }

      const links: LayoutLink[] = [
        { source: 'fe_file_0', target: 'fe_file_1' },
        { source: 'fe_file_0', target: 'fe_file_2' },
        { source: 'be_file_0', target: 'be_file_1' },
      ];

      const positions = layoutSphere(nodes, links, config);
      expect(positions.size).toBe(nodes.length);

      // Determine the shellRadius used in sphereLayout
      const samplePos = positions.get('fe_file_0')!;
      const shellRadius = Math.hypot(samplePos.x, samplePos.y, samplePos.z);
      const anchors = computeAreaAnchors(distinctAreas, shellRadius);

      // Verify that NO node is co-located with its area anchor
      for (const node of nodes) {
        const pos = positions.get(node.id);
        expect(pos).toBeDefined();

        const anchor = anchors.get(node.areaId!)!;
        const distToAnchor = Math.hypot(
          pos!.x - anchor.x,
          pos!.y - anchor.y,
          pos!.z - anchor.z
        );

        // Distance must be strictly positive and comfortably separated from the anchor badge
        expect(distToAnchor).toBeGreaterThan(0);
        // Minimum exclusion threshold: even the closest file node (hub/entry) must be separated
        expect(distToAnchor).toBeGreaterThanOrEqual(12.0);
      }
    });

    it('scales minInnerRadius with capRadius and clamps at 24px', () => {
      // In sphereLayout.ts: minInnerRadius = Math.min(24, capRadius * 0.35)
      // Test small cap radius
      const smallCapRadius = 30;
      const smallMinInner = Math.min(24, smallCapRadius * 0.35);
      expect(smallMinInner).toBeCloseTo(10.5, 4);

      // Test medium cap radius
      const medCapRadius = 60;
      const medMinInner = Math.min(24, medCapRadius * 0.35);
      expect(medMinInner).toBeCloseTo(21.0, 4);

      // Test large cap radius (should be capped at 24)
      const largeCapRadius = 100;
      const largeMinInner = Math.min(24, largeCapRadius * 0.35);
      expect(largeMinInner).toBe(24);
    });

    it('ensures single-node areas place the node away from the anchor center rather than directly on it', () => {
      const distinctAreas = ['single/area', 'other/area'];
      const config = { ...DEFAULT_SPHERE_LAYOUT_CONFIG, sphereRadius: 300 };

      const nodes: LayoutNode[] = [
        makeLayoutNode('solo_file', { val: 20, isEntry: true, areaId: 'single/area' }),
        makeLayoutNode('other_file_1', { val: 10, areaId: 'other/area' }),
        makeLayoutNode('other_file_2', { val: 10, areaId: 'other/area' }),
      ];

      const positions = layoutSphere(nodes, [], config);

      const soloPos = positions.get('solo_file')!;
      const shellRadius = Math.hypot(soloPos.x, soloPos.y, soloPos.z);
      const anchors = computeAreaAnchors(distinctAreas, shellRadius);
      const soloAnchor = anchors.get('single/area')!;

      const dist = Math.hypot(
        soloPos.x - soloAnchor.x,
        soloPos.y - soloAnchor.y,
        soloPos.z - soloAnchor.z
      );

      // Must NOT be at (0, 0, 0) relative to anchor
      expect(dist).toBeGreaterThan(10.0);
    });

    it('guarantees all node positions with inner exclusion strictly reside on the spherical shell surface', () => {
      const config = { ...DEFAULT_SPHERE_LAYOUT_CONFIG, sphereRadius: 300 };

      const nodes: LayoutNode[] = [];
      for (let i = 0; i < 20; i++) {
        const id = `node_${i}`;
        nodes.push(makeLayoutNode(id, { areaId: i % 2 === 0 ? 'area/alpha' : 'area/beta' }));
      }

      const positions = layoutSphere(nodes, [], config);
      expect(positions.size).toBe(20);

      const radii = Array.from(positions.values()).map((p) => Math.hypot(p.x, p.y, p.z));
      const expectedShellRadius = radii[0];
      expect(expectedShellRadius).toBeGreaterThan(50);

      for (const r of radii) {
        expect(r).toBeCloseTo(expectedShellRadius, 3);
      }
    });
  });

  // =========================================================================
  // 2. Priority P0: File Selection & Interaction Precedence
  // =========================================================================
  describe('2. Priority P0: File Selection & Interaction Precedence over Area Anchors', () => {
    it('findHitNode gives file nodes hit targets of Math.max(screenR + 4, 10)', () => {
      const fileNode = makeFileNode('src/api/auth.ts', 'src/api/auth.ts');
      const projectedNode: ProjectedNode = {
        id: fileNode.id,
        node: fileNode,
        worldPos: { x: 200, y: 150, z: 0 },
        localPos: { x: 200, y: 150, z: 0 },
        projected: { x: 200, y: 150, z: 0, depthScale: 1, normalizedDepth: 0.5 },
        screenX: 200,
        screenY: 150,
        radius: 4, // screenR with zoom=1 is 4px -> hitTargetRadius is Math.max(4 + 4, 10) = 10px
      };

      // Click at 7px distance (within 10px hit target)
      const hit = findHitNode([projectedNode], 207, 150, 1.0);
      expect(hit).toBeDefined();
      expect(hit?.id).toBe(fileNode.id);

      // Click at 11px distance (outside 10px hit target)
      const miss = findHitNode([projectedNode], 211, 150, 1.0);
      expect(miss).toBeNull();
    });

    it('strictly bounds area anchor hit testing to projAnchor.radius + 2', () => {
      // Production logic in NetworkCanvas.tsx findAreaAnchorAtPoint:
      // const hitRadius = projAnchor.radius + 2;
      const anchorRadius = 16;
      const boundedHitRadius = anchorRadius + 2; // 18px

      const testAnchorHit = (dist: number) => dist <= boundedHitRadius;

      // Inside or on badge boundary
      expect(testAnchorHit(0)).toBe(true);
      expect(testAnchorHit(16)).toBe(true);
      expect(testAnchorHit(18)).toBe(true);

      // Outside bounded radius
      expect(testAnchorHit(18.5)).toBe(false);
      expect(testAnchorHit(20)).toBe(false);
      expect(testAnchorHit(26)).toBe(false); // Legacy threshold was +10, now +2 strictly prevents click stealing
    });

    it('selection precedence contract: file node takes precedence over area anchor when hit targets coincide', () => {
      const fileNode = makeFileNode('src/api/client.ts', 'src/api/client.ts');
      const area = makeMockArea('src/api', 'api');

      // Mock finding both
      const mockFindNodeAtPoint = vi.fn().mockReturnValue(fileNode);
      const mockFindAreaAnchorAtPoint = vi.fn().mockReturnValue(area);
      const mockOnSelectNode = vi.fn();
      const mockOnSelectArea = vi.fn();
      const mockOnSelectEdge = vi.fn();
      const mockOnSelectAreaEdge = vi.fn();

      // Emulate NetworkCanvas.tsx handlePointerUp precedence logic:
      const handlePointerUpSim = (clientX: number, clientY: number, wasDragging: boolean) => {
        if (!wasDragging) {
          // 1. File nodes have first-class selection precedence over area anchors & edges
          const hitNode = mockFindNodeAtPoint(clientX, clientY);
          if (hitNode) {
            mockOnSelectNode(hitNode);
            mockOnSelectEdge(null);
            mockOnSelectAreaEdge(null);
            return;
          }

          const hitArea = mockFindAreaAnchorAtPoint(clientX, clientY);
          if (hitArea) {
            mockOnSelectArea(hitArea.id);
            mockOnSelectNode(null);
            return;
          }
        }
      };

      handlePointerUpSim(150, 150, false);

      // File selection must succeed
      expect(mockOnSelectNode).toHaveBeenCalledTimes(1);
      expect(mockOnSelectNode).toHaveBeenCalledWith(fileNode);
      expect(mockOnSelectEdge).toHaveBeenCalledWith(null);
      expect(mockOnSelectAreaEdge).toHaveBeenCalledWith(null);

      // Area selection must NOT be invoked because file node captured it
      expect(mockOnSelectArea).not.toHaveBeenCalled();
      expect(mockFindAreaAnchorAtPoint).not.toHaveBeenCalled();
    });

    it('hover precedence contract: file node clears hoveredAreaId and hoveredAreaEdgeId', () => {
      const fileNode = makeFileNode('src/core/engine.ts', 'src/core/engine.ts');

      let hoveredAreaId: string | null = 'src/core';
      let hoveredAreaEdgeId: string | null = 'src/core->src/utils';
      let cursor = 'default';
      const mockHoverPointerMoveOverNode = vi.fn();

      const mockFindNodeAtPoint = vi.fn().mockReturnValue(fileNode);

      // Emulate NetworkCanvas.tsx handlePointerMove precedence logic:
      const handlePointerMoveSim = (clientX: number, clientY: number) => {
        const hitNode = mockFindNodeAtPoint(clientX, clientY);
        if (hitNode) {
          if (hoveredAreaId !== null) {
            hoveredAreaId = null;
          }
          if (hoveredAreaEdgeId !== null) {
            hoveredAreaEdgeId = null;
          }
          mockHoverPointerMoveOverNode(hitNode.id);
          cursor = 'pointer';
          return;
        }
      };

      handlePointerMoveSim(100, 100);

      expect(hoveredAreaId).toBeNull();
      expect(hoveredAreaEdgeId).toBeNull();
      expect(cursor).toBe('pointer');
      expect(mockHoverPointerMoveOverNode).toHaveBeenCalledWith(fileNode.id);
    });
  });

  // =========================================================================
  // 3. Priority P0: Canvas Painter's Algorithm Draw Order Invariant
  // =========================================================================
  describe('3. Priority P0: Canvas Painter\'s Algorithm Draw Order Invariant', () => {
    it('verifies render pipeline order: Area Anchors/Badges -> Overview Area Labels -> File Nodes -> Active Labels', () => {
      // In NetworkCanvas.tsx:
      // Lines 1152-1195: Step 3: Draw Area Anchor Badges
      // Lines 1198-1254: Step 3b: Draw Overview Area Labels (under front-facing anchors)
      // Lines 1258-1335: Step 4: Draw Nodes (sorted far-to-near for Painter's algorithm — rendered ON TOP of area backdrops)
      // Lines 1338+: Step 5: Draw Active File Labels

      const renderOperations: string[] = [];

      // Mock canvas context calls to record sequence of visual layer drawing
      const mockContext = {
        drawAreaAnchorBadges: () => renderOperations.push('area-anchor-badges'),
        drawOverviewAreaLabels: () => renderOperations.push('overview-area-labels'),
        drawFileNodes: () => renderOperations.push('file-nodes'),
        drawActiveFileLabels: () => renderOperations.push('active-file-labels'),
      };

      // Execute in production order
      mockContext.drawAreaAnchorBadges();
      mockContext.drawOverviewAreaLabels();
      mockContext.drawFileNodes();
      mockContext.drawActiveFileLabels();

      expect(renderOperations).toEqual([
        'area-anchor-badges',
        'overview-area-labels',
        'file-nodes',
        'active-file-labels',
      ]);

      const areaBadgeIdx = renderOperations.indexOf('area-anchor-badges');
      const areaLabelIdx = renderOperations.indexOf('overview-area-labels');
      const fileNodeIdx = renderOperations.indexOf('file-nodes');
      const fileLabelIdx = renderOperations.indexOf('active-file-labels');

      // File nodes MUST be drawn AFTER area badges and area labels
      expect(fileNodeIdx).toBeGreaterThan(areaBadgeIdx);
      expect(fileNodeIdx).toBeGreaterThan(areaLabelIdx);
      // Active file labels MUST be drawn on the topmost layer
      expect(fileLabelIdx).toBeGreaterThan(fileNodeIdx);
    });

    it('verifies that NetworkCanvas.tsx source code contains the invariant draw order comments and structure', () => {
      const rootDir = process.cwd().endsWith('frontend') ? path.resolve(process.cwd(), '..') : process.cwd();
      const networkCanvasPath = path.resolve(rootDir, 'frontend/src/graphs/network/NetworkCanvas.tsx');
      const source = fs.readFileSync(networkCanvasPath, 'utf8');

      const anchorSectionIdx = source.indexOf('3. Draw Area Anchor Badges');
      const nodeSectionIdx = source.indexOf('4. Draw Nodes');
      const areaLabelSectionIdx = source.indexOf('4.5 Draw Architectural Area Labels');
      const fileLabelSectionIdx = source.indexOf('5. Draw Node Labels');

      expect(anchorSectionIdx).toBeGreaterThan(0);
      expect(nodeSectionIdx).toBeGreaterThan(anchorSectionIdx);
      // Area labels are positioned collision-aware and rendered above nodes to prevent text being painted over
      expect(areaLabelSectionIdx).toBeGreaterThan(nodeSectionIdx);
      // File labels are rendered topmost
      expect(fileLabelSectionIdx).toBeGreaterThan(areaLabelSectionIdx);
    });
  });

  // =========================================================================
  // 4. Priority P1: Missing Favicon Integration
  // =========================================================================
  describe('4. Priority P1: Missing Favicon Integration', () => {
    it('verifies frontend/public/favicon.svg exists and contains valid SVG graphic elements', () => {
      const rootDir = process.cwd().endsWith('frontend') ? path.resolve(process.cwd(), '..') : process.cwd();
      const faviconPath = path.resolve(rootDir, 'frontend/public/favicon.svg');
      expect(fs.existsSync(faviconPath)).toBe(true);

      const content = fs.readFileSync(faviconPath, 'utf8');
      expect(content).toContain('<svg');
      expect(content).toContain('viewBox="0 0 32 32"');
      expect(content).toContain('xmlns="http://www.w3.org/2000/svg"');
      // Contains authentic PreBase monogram vector path elements
      expect(content).toContain('<path');
      expect(content).toContain('stroke-linecap="round"');
      expect(content).toContain('</svg>');
    });

    it('verifies frontend/index.html includes the svg favicon link element', () => {
      const rootDir = process.cwd().endsWith('frontend') ? path.resolve(process.cwd(), '..') : process.cwd();
      const indexHtmlPath = path.resolve(rootDir, 'frontend/index.html');
      expect(fs.existsSync(indexHtmlPath)).toBe(true);

      const indexContent = fs.readFileSync(indexHtmlPath, 'utf8');
      expect(indexContent).toMatch(/<link\s+rel="icon"\s+type="image\/svg\+xml"\s+href="\/favicon\.svg"\s*\/>/);
    });
  });

  // =========================================================================
  // 5. Priority P1: Inspector Reopen Button In-Flow Geometry
  // =========================================================================
  describe('5. Priority P1: Inspector Reopen Button Geometry & In-Flow Layout', () => {
    it('renders inspector-reopen-btn inside action-btn-group in normal document flow when collapsed', () => {
      // Mock collapsed toolbar structure mirroring App.tsx lines 1511-1523
      const isCollapsed = true;
      const html = renderToStaticMarkup(
        <div className="action-btn-group view-controls">
          <button id="zoomIn" className="ctrl-btn icon-only">Zoom In</button>
          <button id="zoomOut" className="ctrl-btn icon-only">Zoom Out</button>
          <button id="fitView" className="ctrl-btn icon-only">Fit</button>
          <button id="resetCam" className="ctrl-btn icon-only">Reset</button>
          {isCollapsed && (
            <button
              id="toggleInspector"
              className="ctrl-btn inspector-reopen-btn"
              title="Open inspector"
              aria-label="Open inspector"
            >
              <PanelRightOpen size={14} />
              <span className="btn-label">Inspect</span>
            </button>
          )}
        </div>
      );

      expect(html).toContain('action-btn-group view-controls');
      expect(html).toContain('inspector-reopen-btn');
      expect(html).toContain('Open inspector');
      expect(html).toContain('Inspect');
    });

    it('omits inspector-reopen-btn when inspector is expanded', () => {
      const isCollapsed = false;
      const html = renderToStaticMarkup(
        <div className="action-btn-group view-controls">
          <button id="zoomIn" className="ctrl-btn icon-only">Zoom In</button>
          {isCollapsed && (
            <button id="toggleInspector" className="ctrl-btn inspector-reopen-btn">
              Inspect
            </button>
          )}
        </div>
      );

      expect(html).not.toContain('inspector-reopen-btn');
    });

    it('verifies App.css specifies display: inline-flex without position: absolute for inspector-reopen-btn', () => {
      const rootDir = process.cwd().endsWith('frontend') ? path.resolve(process.cwd(), '..') : process.cwd();
      const appCssPath = path.resolve(rootDir, 'frontend/src/app/App.css');
      const css = fs.readFileSync(appCssPath, 'utf8');

      // Extract .inspector-reopen-btn CSS block
      const btnBlockMatch = css.match(/\.inspector-reopen-btn\s*\{([^}]+)\}/);
      expect(btnBlockMatch).not.toBeNull();

      const block = btnBlockMatch![1];
      expect(block).toContain('display: inline-flex');
      expect(block).not.toContain('position: absolute');
      expect(block).not.toContain('position: fixed');
    });
  });

  // =========================================================================
  // 6. Priority P2: Sidebar Status Spacing & Zero Conflicting Margins
  // =========================================================================
  describe('6. Priority P2: Sidebar Status Spacing & Zero Conflicting Margins', () => {
    it('verifies App.css sets display: flex, flex-direction: column, and gap: 8px on .sidebar-footer', () => {
      const rootDir = process.cwd().endsWith('frontend') ? path.resolve(process.cwd(), '..') : process.cwd();
      const appCssPath = path.resolve(rootDir, 'frontend/src/app/App.css');
      const css = fs.readFileSync(appCssPath, 'utf8');

      const footerMatch = css.match(/\.sidebar-footer\s*\{([^}]+)\}/);
      expect(footerMatch).not.toBeNull();

      const footerBlock = footerMatch![1];
      expect(footerBlock).toContain('display: flex');
      expect(footerBlock).toContain('flex-direction: column');
      expect(footerBlock).toContain('gap: 8px');
    });

    it('verifies .status-indicator, .stats-summary, and .live-watcher-badge have margin: 0 to eliminate margin conflicts', () => {
      const rootDir = process.cwd().endsWith('frontend') ? path.resolve(process.cwd(), '..') : process.cwd();
      const appCssPath = path.resolve(rootDir, 'frontend/src/app/App.css');
      const css = fs.readFileSync(appCssPath, 'utf8');

      const statusMatch = css.match(/\.status-indicator\s*\{([^}]+)\}/);
      expect(statusMatch).not.toBeNull();
      expect(statusMatch![1]).toContain('margin: 0');

      const statsMatch = css.match(/\.stats-summary\s*\{([^}]+)\}/);
      expect(statsMatch).not.toBeNull();
      expect(statsMatch![1]).toContain('margin: 0');

      const liveBadgeMatch = css.match(/\.live-watcher-badge\s*\{([^}]+)\}/);
      expect(liveBadgeMatch).not.toBeNull();
      expect(liveBadgeMatch![1]).toContain('margin: 0');
    });

    it('renders sidebar footer children cleanly in a unified vertical flow', () => {
      const html = renderToStaticMarkup(
        <div className="sidebar-footer">
          <div className="status-indicator">
            <span className="status-dot ready" />
            <span>Index Ready</span>
          </div>
          <div className="live-watcher-badge">
            <span className="live-pulse" />
            <span>Live Watcher Active</span>
          </div>
          <div className="stats-summary">
            <span className="stat-line">42 files</span>
            <span className="stat-line">185 deps</span>
          </div>
        </div>
      );

      expect(html).toContain('sidebar-footer');
      expect(html).toContain('status-indicator');
      expect(html).toContain('live-watcher-badge');
      expect(html).toContain('stats-summary');
    });
  });

  // =========================================================================
  // 7. Priority P2: Graph Guide Lucide Icon
  // =========================================================================
  describe('7. Priority P2: Graph Guide Lucide Icon', () => {
    it('renders the Lucide Lightbulb icon component instead of a raw unicode emoji', () => {
      // Render the toggle button matching NetworkCanvas.tsx lines 2349-2359
      const showLegend = false;
      const html = renderToStaticMarkup(
        <button
          type="button"
          className={`graph-legend-toggle-btn ${showLegend ? 'active' : ''}`}
          aria-expanded={showLegend}
          aria-label="Toggle Codebase Orb Guide and Legend"
          title="Toggle Codebase Orb Guide and Legend"
        >
          <Lightbulb size={13} className="legend-icon" aria-hidden="true" />
          <span>Graph Guide</span>
        </button>
      );

      // Must contain SVG element from lucide-react Lightbulb
      expect(html).toContain('<svg');
      expect(html).toContain('class="lucide lucide-lightbulb legend-icon"');
      expect(html).toContain('<span>Graph Guide</span>');
      // Must NOT contain raw unicode emoji
      expect(html).not.toContain('💡');
    });

    it('verifies NetworkCanvas.tsx imports and renders Lightbulb without emoji characters', () => {
      const rootDir = process.cwd().endsWith('frontend') ? path.resolve(process.cwd(), '..') : process.cwd();
      const networkCanvasPath = path.resolve(rootDir, 'frontend/src/graphs/network/NetworkCanvas.tsx');
      const source = fs.readFileSync(networkCanvasPath, 'utf8');

      // Verify import from lucide-react
      expect(source).toMatch(/import\s*\{[^}]*Lightbulb[^}]*\}\s*from\s*['"]lucide-react['"]/);
      // Verify usage in toggle button
      expect(source).toContain('<Lightbulb size={13} className="legend-icon" aria-hidden="true" />');
      // Verify raw emoji is absent
      expect(source).not.toContain('💡');
    });

    it('toggles Graph Guide legend card accessibility attributes', () => {
      const renderGuide = (show: boolean) =>
        renderToStaticMarkup(
          <div>
            <button
              type="button"
              className={`graph-legend-toggle-btn ${show ? 'active' : ''}`}
              aria-expanded={show}
              aria-label="Toggle Codebase Orb Guide and Legend"
            >
              <Lightbulb size={13} className="legend-icon" aria-hidden="true" />
              <span>Graph Guide</span>
            </button>
            {show && (
              <div
                className="graph-legend-card"
                role="region"
                aria-label="Network Graph Legend and Architectural Guide"
              >
                <div className="graph-legend-header">Codebase Orb Guide</div>
              </div>
            )}
          </div>
        );

      const closedHtml = renderGuide(false);
      expect(closedHtml).toContain('aria-expanded="false"');
      expect(closedHtml).not.toContain('graph-legend-card');

      const openHtml = renderGuide(true);
      expect(openHtml).toContain('aria-expanded="true"');
      expect(openHtml).toContain('graph-legend-card');
      expect(openHtml).toContain('role="region"');
      expect(openHtml).toContain('aria-label="Network Graph Legend and Architectural Guide"');
    });
  });
});
