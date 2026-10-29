import { DependencyEdge } from '../../../types/graph';

export interface EdgeVisualDescriptor {
  color: string;
  width: number;
  alpha: number;
  dash: number[];
  priority: number;
  showArrow: boolean;
}

export function resolveNetworkEdgeVisual(
  edge: DependencyEdge,
  isConnectedToHighlight: boolean,
  activeHighlightId: string | null | undefined,
  zoom: number,
  entryNodeId?: string | null
): EdgeVisualDescriptor | null {
  if (isConnectedToHighlight) {
    return {
      color: '#2dd4bf',
      width: Math.max(1.8, 2.2 / zoom),
      alpha: 1.0,
      dash: edge.relationship_kind === 'DynamicImport' ? [4, 4] : [],
      priority: 100,
      showArrow: zoom >= 0.5,
    };
  }

  if (activeHighlightId) {
    return {
      color: 'rgba(148, 163, 184, 0.05)',
      width: 0.6 / zoom,
      alpha: 0.05,
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
      color: 'rgba(245, 158, 11, 0.75)',
      width: 1.3 / zoom,
      alpha: 0.75,
      dash: [],
      priority: 9,
      showArrow: zoom >= 0.8,
    };
  }

  if (edge.relationship_kind === 'DynamicImport') {
    if (zoom < 0.4) return null;
    return {
      color: 'rgba(244, 114, 182, 0.65)',
      width: 1.1 / zoom,
      alpha: 0.65,
      dash: [4, 4],
      priority: 8,
      showArrow: zoom >= 0.8,
    };
  }

  if (edge.relationship_kind === 'TypeOnly') {
    if (zoom < 0.5) return null;
    return {
      color: 'rgba(96, 165, 250, 0.35)',
      width: 0.8 / zoom,
      alpha: 0.4,
      dash: [3, 3],
      priority: 2,
      showArrow: false,
    };
  }

  if (zoom < 0.35) return null;
  return {
    color: 'rgba(148, 163, 184, 0.28)',
    width: 0.85 / zoom,
    alpha: 0.35,
    dash: [],
    priority: 3,
    showArrow: zoom >= 1.0,
  };
}

