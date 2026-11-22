import { DependencyEdge } from '../../../types/graph';
import { AreaEdge } from '../../../utils/repositoryAreas';

export interface EdgeVisualDescriptor {
  color: string;
  width: number;
  alpha: number;
  dash: number[];
  priority: number;
  showArrow: boolean;
}

export function resolveAreaEdgeVisual(
  areaEdge: AreaEdge,
  isSelected: boolean,
  isHovered: boolean,
  zoom: number,
  theme: 'dark' | 'light' = 'dark'
): EdgeVisualDescriptor {
  const isLight = theme === 'light';
  const baseWeight = Math.min(4.5, Math.max(1.8, 1.2 + 0.7 * Math.log2(1 + areaEdge.edgeCount)));

  if (isSelected) {
    return {
      color: isLight ? '#0284c7' : '#38bdf8',
      width: Math.max(3.0, (baseWeight + 1.5) / zoom),
      alpha: 1.0,
      dash: [],
      priority: 150,
      showArrow: true,
    };
  }

  if (isHovered) {
    return {
      color: isLight ? '#4f46e5' : '#818cf8',
      width: Math.max(2.5, (baseWeight + 1.0) / zoom),
      alpha: 0.95,
      dash: [],
      priority: 120,
      showArrow: true,
    };
  }

  return {
    color: isLight ? 'rgba(79, 70, 229, 0.60)' : 'rgba(129, 140, 248, 0.60)',
    width: Math.max(1.6, baseWeight / Math.max(0.6, zoom)),
    alpha: 0.60,
    dash: [],
    priority: 50,
    showArrow: zoom >= 0.45,
  };
}

export function resolveNetworkEdgeVisual(
  edge: DependencyEdge,
  isConnectedToHighlight: boolean,
  activeHighlightId: string | null | undefined,
  zoom: number,
  entryNodeId?: string | null,
  theme: 'dark' | 'light' = 'dark',
  direction?: 'outgoing' | 'incoming' | 'both'
): EdgeVisualDescriptor | null {
  const isLight = theme === 'light';

  if (isConnectedToHighlight) {
    const isOutgoing = direction === 'outgoing';
    const isIncoming = direction === 'incoming';

    // Outgoing dependencies: Electric Cyan / Teal
    // Incoming dependencies: Soft Violet / Purple
    const highlightColor = isOutgoing
      ? (isLight ? '#0d9488' : '#2dd4bf')
      : isIncoming
        ? (isLight ? '#7c3aed' : '#a78bfa')
        : (isLight ? '#0d9488' : '#2dd4bf');

    return {
      color: highlightColor,
      width: Math.max(2.0, 2.4 / zoom),
      alpha: 1.0,
      dash: edge.relationship_kind === 'DynamicImport' ? [4, 4] : [],
      priority: 100,
      showArrow: zoom >= 0.4,
    };
  }

  if (activeHighlightId) {
    return {
      color: isLight ? 'rgba(100, 116, 139, 0.08)' : 'rgba(148, 163, 184, 0.06)',
      width: 0.6 / zoom,
      alpha: 0.06,
      dash: [],
      priority: 0,
      showArrow: false,
    };
  }

  const isIncidentToEntry = Boolean(
    entryNodeId && (edge.source_file_id === entryNodeId || edge.target_file_id === entryNodeId)
  );

  if (isIncidentToEntry) {
    return {
      color: isLight ? 'rgba(217, 119, 6, 0.85)' : 'rgba(245, 158, 11, 0.85)',
      width: Math.max(1.3, 1.4 / zoom),
      alpha: 0.85,
      dash: [],
      priority: 9,
      showArrow: zoom >= 0.6,
    };
  }

  if (edge.relationship_kind === 'DynamicImport') {
    if (zoom < 0.25) return null;
    return {
      color: isLight ? 'rgba(219, 39, 119, 0.75)' : 'rgba(244, 114, 182, 0.75)',
      width: Math.max(1.1, 1.2 / zoom),
      alpha: 0.75,
      dash: [4, 4],
      priority: 8,
      showArrow: zoom >= 0.6,
    };
  }

  if (edge.relationship_kind === 'TypeOnly') {
    if (zoom < 0.3) return null;
    return {
      color: isLight ? 'rgba(37, 99, 235, 0.50)' : 'rgba(96, 165, 250, 0.50)',
      width: Math.max(0.9, 1.0 / zoom),
      alpha: 0.50,
      dash: [3, 3],
      priority: 2,
      showArrow: false,
    };
  }

  if (zoom < 0.2) return null;
  return {
    color: isLight ? 'rgba(71, 85, 105, 0.45)' : 'rgba(148, 163, 184, 0.48)',
    width: Math.max(1.0, 1.05 / zoom),
    alpha: 0.48,
    dash: [],
    priority: 3,
    showArrow: zoom >= 0.8,
  };
}

