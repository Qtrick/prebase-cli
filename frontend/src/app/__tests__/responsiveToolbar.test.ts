import { describe, it, expect } from 'vitest';
import {
  STANDARD_VIEWPORTS,
  MIN_SEARCH_INPUT_INTERACTIVE_WIDTH,
  computeAvailableWorkspaceWidth,
  evaluateSearchInputResponsiveness,
} from '../responsiveLayoutMath';

describe('Responsive Toolbar & Search Visibility Suite', () => {
  const targetViewports = [
    { name: '1024x768', dimensions: STANDARD_VIEWPORTS.v1024x768 },
    { name: '1280x800', dimensions: STANDARD_VIEWPORTS.v1280x800 },
    { name: '1440x900', dimensions: STANDARD_VIEWPORTS.v1440x900 },
    { name: '1920x1080', dimensions: STANDARD_VIEWPORTS.v1920x1080 },
  ];

  describe('Workspace Width Allocation with Sidebar and Inspector Open', () => {
    it.each(targetViewports)(
      'allocates positive workspace width in $name with sidebar (250px) and inspector (340px) open',
      ({ dimensions }) => {
        const workspaceWidth = computeAvailableWorkspaceWidth(dimensions.width, {
          sidebarWidth: 250,
          inspectorWidth: 340,
          isSidebarOpen: true,
          isInspectorCollapsed: false,
        });

        const expectedWidth = dimensions.width - 250 - 340;
        expect(workspaceWidth).toBe(expectedWidth);
        expect(workspaceWidth).toBeGreaterThan(0);
      }
    );

    it('accounts for inspector collapse to reclaim 340px for workspace', () => {
      const openWidth = computeAvailableWorkspaceWidth(1024, { isInspectorCollapsed: false });
      const collapsedWidth = computeAvailableWorkspaceWidth(1024, { isInspectorCollapsed: true });

      expect(openWidth).toBe(1024 - 250 - 340); // 434px
      expect(collapsedWidth).toBe(1024 - 250); // 774px
      expect(collapsedWidth - openWidth).toBe(340);
    });
  });

  describe('Search Input Interactive Width (>= 160px) Invariant', () => {
    it.each(targetViewports)(
      'guarantees .search-input remains visible with interactive width >= 160px in $name',
      ({ dimensions }) => {
        const result = evaluateSearchInputResponsiveness(dimensions, {
          sidebarWidth: 250,
          inspectorWidth: 340,
          isSidebarOpen: true,
          isInspectorCollapsed: false,
        });

        // 1. Must be marked interactive
        expect(result.isInteractive).toBe(true);

        // 2. Width must be >= 160px threshold
        expect(result.searchInputWidth).toBeGreaterThanOrEqual(MIN_SEARCH_INPUT_INTERACTIVE_WIDTH);

        // 3. Must not exceed available header width
        expect(result.searchInputWidth).toBeLessThanOrEqual(result.headerWidth);
      }
    );

    it('handles most constrained 1024x768 viewport with full open drawers without clipping search input', () => {
      const result = evaluateSearchInputResponsiveness(STANDARD_VIEWPORTS.v1024x768, {
        sidebarWidth: 250,
        inspectorWidth: 340,
        isSidebarOpen: true,
        isInspectorCollapsed: false,
      });

      expect(result.workspaceWidth).toBe(434);
      expect(result.headerWidth).toBe(394); // 434 - 40px padding
      expect(result.searchInputWidth).toBeGreaterThanOrEqual(160);
      expect(result.searchInputWidth).toBeLessThanOrEqual(394);
    });

    it('expands to ideal 320px in spacious 1920x1080 viewport', () => {
      const result = evaluateSearchInputResponsiveness(STANDARD_VIEWPORTS.v1920x1080, {
        sidebarWidth: 250,
        inspectorWidth: 340,
        isSidebarOpen: true,
        isInspectorCollapsed: false,
      });

      expect(result.searchInputWidth).toBe(320);
      expect(result.isInteractive).toBe(true);
    });
  });

  describe('Toolbar Sibling Priority & Collision Prevention', () => {
    it('ensures search input maintains priority over optional view controls during compaction', () => {
      const result = evaluateSearchInputResponsiveness(STANDARD_VIEWPORTS.v1024x768, {
        sidebarWidth: 250,
        inspectorWidth: 340,
      });

      // Even in the tightest viewport, primary search functionality is protected
      expect(result.searchInputWidth).toBeGreaterThanOrEqual(160);
      expect(result.isInteractive).toBe(true);
    });
  });
});
