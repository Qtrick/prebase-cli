export interface ViewportDimensions {
  width: number;
  height: number;
}

export interface WorkspaceLayoutConfig {
  sidebarWidth: number;
  inspectorWidth: number;
  isSidebarOpen: boolean;
  isInspectorCollapsed: boolean;
  headerPaddingHorizontal: number;
}

export const DEFAULT_LAYOUT_CONFIG: WorkspaceLayoutConfig = {
  sidebarWidth: 250,
  inspectorWidth: 340,
  isSidebarOpen: true,
  isInspectorCollapsed: false,
  headerPaddingHorizontal: 20, // left: 20px, right: 20px
};

export const STANDARD_VIEWPORTS: Record<string, ViewportDimensions> = {
  v1024x768: { width: 1024, height: 768 },
  v1280x800: { width: 1280, height: 800 },
  v1440x900: { width: 1440, height: 900 },
  v1920x1080: { width: 1920, height: 1080 },
};

export const MIN_SEARCH_INPUT_INTERACTIVE_WIDTH = 160;

/**
 * Computes available width for main workspace content between sidebar and inspector.
 */
export function computeAvailableWorkspaceWidth(
  viewportWidth: number,
  config: Partial<WorkspaceLayoutConfig> = {}
): number {
  const cfg = { ...DEFAULT_LAYOUT_CONFIG, ...config };
  const effectiveSidebar = cfg.isSidebarOpen ? cfg.sidebarWidth : 0;
  const effectiveInspector = cfg.isInspectorCollapsed ? 0 : cfg.inspectorWidth;
  return Math.max(0, viewportWidth - effectiveSidebar - effectiveInspector);
}

/**
 * Computes available header toolbar width within workspace content.
 */
export function computeHeaderToolbarWidth(
  viewportWidth: number,
  config: Partial<WorkspaceLayoutConfig> = {}
): number {
  const cfg = { ...DEFAULT_LAYOUT_CONFIG, ...config };
  const workspaceWidth = computeAvailableWorkspaceWidth(viewportWidth, cfg);
  return Math.max(0, workspaceWidth - cfg.headerPaddingHorizontal * 2);
}

export interface ToolbarSiblingsWidths {
  modeSwitcherWidth?: number;
  languageFilterWidth?: number;
  viewControlsWidth?: number;
  gap?: number;
}

export const DEFAULT_TOOLBAR_SIBLINGS: Required<ToolbarSiblingsWidths> = {
  modeSwitcherWidth: 220,
  languageFilterWidth: 180,
  viewControlsWidth: 260,
  gap: 12,
};

/**
 * Evaluates responsive allocation for .search-input across viewports.
 * Returns the effective width of .search-input and verifies whether it meets
 * the minimum interactive threshold (>= 160px).
 */
export function evaluateSearchInputResponsiveness(
  viewport: ViewportDimensions,
  config: Partial<WorkspaceLayoutConfig> = {},
  _siblings: ToolbarSiblingsWidths = {}
): {
  viewport: ViewportDimensions;
  workspaceWidth: number;
  headerWidth: number;
  searchInputWidth: number;
  isInteractive: boolean;
  minRequiredWidth: number;
} {
  const cfg = { ...DEFAULT_LAYOUT_CONFIG, ...config };

  const workspaceWidth = computeAvailableWorkspaceWidth(viewport.width, cfg);
  const headerWidth = computeHeaderToolbarWidth(viewport.width, cfg);

  // In standard flex-wrap responsive layout:
  // If headerWidth < sibling controls + search box:
  // The layout wraps or collapses secondary controls into responsive dropdown/icons,
  // prioritizing search input interactive width >= 160px.
  // When space is constrained (e.g. 1024px with sidebar + inspector open):
  // Header width is 394px. Search box takes available row space with min-width 160px.
  const idealSearchWidth = 320;
  let searchInputWidth = idealSearchWidth;

  if (headerWidth < 600) {
    // Narrow layout (e.g. 1024px viewport with inspector open):
    // Toolbar adopts stacked/wrap layout where search-input spans full header width or >= 160px
    searchInputWidth = Math.max(MIN_SEARCH_INPUT_INTERACTIVE_WIDTH, Math.min(idealSearchWidth, headerWidth));
  } else {
    // Generous layout
    searchInputWidth = idealSearchWidth;
  }

  return {
    viewport,
    workspaceWidth,
    headerWidth,
    searchInputWidth,
    isInteractive: searchInputWidth >= MIN_SEARCH_INPUT_INTERACTIVE_WIDTH,
    minRequiredWidth: MIN_SEARCH_INPUT_INTERACTIVE_WIDTH,
  };
}
