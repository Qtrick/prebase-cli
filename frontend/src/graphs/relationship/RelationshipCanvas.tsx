import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DependencyEdge, FileNode, GraphSnapshot } from '../../types/graph';
import { getFileTypeInfo } from '../network/fileTypeColors';
import { deriveRelationshipGraph } from './deriveRelationshipGraph';
import {
  computeRelationshipLayout,
  LayoutBounds,
  LayoutEdge,
  LayoutNode,
  RelationshipLayoutResult,
} from './relationshipLayout';
import {
  RelationshipDepth,
  RelationshipDirection,
  RelationshipGraphData,
} from './relationshipTypes';
import {
  ArrowLeft,
  Search,
  AlertCircle,
  FileCode,
  Layers,
  Maximize2,
  RotateCcw,
} from 'lucide-react';
import './RelationshipCanvas.css';

export interface Viewport2D {
  panX: number;
  panY: number;
  zoom: number;
}

interface RelationshipCanvasProps {
  snapshot: GraphSnapshot | null;
  focusNodeId: string | null;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  onSelectNode: (node: FileNode | null) => void;
  onSelectEdge: (edge: DependencyEdge | null) => void;
  onRefocusNode: (nodeId: string) => void;
  onBackFocus?: () => void;
  canGoBack?: boolean;
  backTargetName?: string | null;
  fitViewTrigger?: number;
  resetViewTrigger?: number;
  initialViewport?: Viewport2D;
  onViewportChange?: (viewport: Viewport2D) => void;
  missingFocusPath?: string | null;
  theme?: 'dark' | 'light';
  onAnnounce?: (message: string) => void;
}

// Truncation cache to prevent calling measureText in while loops on every frame
const textTruncateCache = new Map<string, string>();

function getTruncatedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  font: string,
  prefixEllipsis = false
): string {
  const cacheKey = `${text}:${Math.floor(maxWidth)}:${font}:${prefixEllipsis}`;
  const cached = textTruncateCache.get(cacheKey);
  if (cached !== undefined) return cached;

  if (textTruncateCache.size > 1500) {
    textTruncateCache.clear();
  }

  ctx.font = font;
  if (ctx.measureText(text).width <= maxWidth) {
    textTruncateCache.set(cacheKey, text);
    return text;
  }

  let result = text;
  if (!prefixEllipsis) {
    while (result.length > 3 && ctx.measureText(result + '…').width > maxWidth) {
      result = result.slice(0, -1);
    }
    result += '…';
  } else {
    while (result.length > 5 && ctx.measureText('…' + result).width > maxWidth) {
      result = result.slice(2);
    }
    result = '…' + result;
  }

  textTruncateCache.set(cacheKey, result);
  return result;
}

export const RelationshipCanvas: React.FC<RelationshipCanvasProps> = ({
  snapshot,
  focusNodeId,
  selectedNodeId,
  selectedEdgeId,
  onSelectNode,
  onSelectEdge,
  onRefocusNode,
  onBackFocus,
  canGoBack = false,
  backTargetName = null,
  fitViewTrigger = 0,
  resetViewTrigger = 0,
  initialViewport,
  onViewportChange,
  missingFocusPath = null,
  theme = 'dark',
  onAnnounce,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Layout & Traversal Configuration
  const [depth, setDepth] = useState<RelationshipDepth>(1);
  const [direction, setDirection] = useState<RelationshipDirection>('both');
  const [searchFilter, setSearchFilter] = useState('');

  // 2D Viewport Camera State
  const [viewport, setViewport] = useState<Viewport2D>(() => {
    return initialViewport || { panX: 0, panY: 0, zoom: 1.0 };
  });

  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  // Track dragging state & active pointer
  const isDraggingRef = useRef(false);
  const activePointerIdRef = useRef<number | null>(null);
  const dragStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const hasDraggedRef = useRef(false);

  // Hover state
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const hoveredNodeIdRef = useRef<string | null>(null);
  hoveredNodeIdRef.current = hoveredNodeId;
  const hoveredEdgeIdRef = useRef<string | null>(null);
  hoveredEdgeIdRef.current = hoveredEdgeId;

  // Keyboard navigation focus state
  const [keyboardNodeId, setKeyboardNodeId] = useState<string | null>(null);

  // 1. Derive Relationship Graph
  const graphData: RelationshipGraphData = useMemo(() => {
    return deriveRelationshipGraph(snapshot, focusNodeId, {
      depth,
      direction,
      maxNodes: 120,
      maxEdges: 240,
    });
  }, [snapshot, focusNodeId, depth, direction]);

  // Dimensions
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setDimensions({ width, height });
        }
      }
    });

    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 2. Compute Layout
  const layout: RelationshipLayoutResult = useMemo(() => {
    return computeRelationshipLayout(graphData, dimensions);
  }, [graphData, dimensions]);

  // Keep layout in ref for event handlers & RAF loop
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // Fit view helper
  const fitToGraph = useCallback(
    (bounds: LayoutBounds, width: number, height: number) => {
      if (bounds.width <= 0 || bounds.height <= 0 || width <= 0 || height <= 0) {
        const next = { panX: width / 2, panY: height / 2, zoom: 1.0 };
        setViewport(next);
        onViewportChange?.(next);
        return;
      }

      const padding = 80;
      const availableW = Math.max(100, width - padding * 2);
      const availableH = Math.max(100, height - padding * 2);

      const zoomX = availableW / bounds.width;
      const zoomY = availableH / bounds.height;
      const nextZoom = Math.min(1.2, Math.max(0.2, Math.min(zoomX, zoomY)));

      const nextPanX = width / 2 - bounds.centerX * nextZoom;
      const nextPanY = height / 2 - bounds.centerY * nextZoom;

      const next = { panX: nextPanX, panY: nextPanY, zoom: nextZoom };
      setViewport(next);
      onViewportChange?.(next);
    },
    [onViewportChange]
  );

  // Reset view helper
  const resetToCenter = useCallback(
    (width: number, height: number) => {
      const next = { panX: width / 2, panY: height / 2, zoom: 1.0 };
      setViewport(next);
      onViewportChange?.(next);
    },
    [onViewportChange]
  );

  // Auto-fit when focusNodeId changes or on initial mount
  const lastFittedFocusRef = useRef<string | null>(null);
  useEffect(() => {
    if (focusNodeId && focusNodeId !== lastFittedFocusRef.current && layout.nodes.length > 0) {
      lastFittedFocusRef.current = focusNodeId;
      fitToGraph(layout.bounds, dimensions.width, dimensions.height);
    }
  }, [focusNodeId, layout, dimensions, fitToGraph]);

  // Handle external fit view trigger
  const lastFitTriggerRef = useRef(fitViewTrigger);
  useEffect(() => {
    if (fitViewTrigger > 0 && fitViewTrigger !== lastFitTriggerRef.current) {
      lastFitTriggerRef.current = fitViewTrigger;
      fitToGraph(layout.bounds, dimensions.width, dimensions.height);
    }
  }, [fitViewTrigger, layout.bounds, dimensions, fitToGraph]);

  // Handle external reset view trigger
  const lastResetTriggerRef = useRef(resetViewTrigger);
  useEffect(() => {
    if (resetViewTrigger > 0 && resetViewTrigger !== lastResetTriggerRef.current) {
      lastResetTriggerRef.current = resetViewTrigger;
      resetToCenter(dimensions.width, dimensions.height);
    }
  }, [resetViewTrigger, dimensions, resetToCenter]);

  // Palette tokens for dark and light themes
  const isLight = theme === 'light';
  const palette = useMemo(() => {
    if (isLight) {
      return {
        headerTitle: '#475569',
        headerSubtitle: '#64748b',
        headerOmitted: '#d97706',
        cardBgFocus: '#ffffff',
        cardBgSelected: '#f0f9ff',
        cardBgHover: '#f8fafc',
        cardBgNormal: '#ffffff',
        cardBorderFocus: '#0d9488',
        cardBorderSelected: '#0284c7',
        cardBorderHover: '#94a3b8',
        cardBorderNormal: '#cbd5e1',
        cardShadowFocus: 'rgba(13, 148, 136, 0.2)',
        cardShadowSelected: 'rgba(2, 132, 199, 0.2)',
        cardShadowHover: 'rgba(0, 0, 0, 0.08)',
        textFocus: '#0f172a',
        textSelected: '#0284c7',
        textNormal: '#1e293b',
        textMuted: '#64748b',
        edgeSelected: '#0d9488',
        edgeHovered: '#0284c7',
        edgeConnectedSelected: '#6366f1',
        edgeExport: '#8b5cf6',
        edgeDefault: 'rgba(100, 116, 139, 0.45)',
      };
    }
    return {
      headerTitle: '#94a3b8',
      headerSubtitle: '#64748b',
      headerOmitted: '#f59e0b',
      cardBgFocus: '#111827',
      cardBgSelected: '#1e293b',
      cardBgHover: '#1e293b',
      cardBgNormal: '#0f172a',
      cardBorderFocus: '#2dd4bf',
      cardBorderSelected: '#38bdf8',
      cardBorderHover: '#94a3b8',
      cardBorderNormal: '#334155',
      cardShadowFocus: 'rgba(45, 212, 191, 0.25)',
      cardShadowSelected: 'rgba(56, 189, 248, 0.3)',
      cardShadowHover: 'rgba(255, 255, 255, 0.12)',
      textFocus: '#f8fafc',
      textSelected: '#38bdf8',
      textNormal: '#e2e8f0',
      textMuted: '#64748b',
      edgeSelected: '#2dd4bf',
      edgeHovered: '#38bdf8',
      edgeConnectedSelected: '#818cf8',
      edgeExport: '#a78bfa',
      edgeDefault: 'rgba(100, 116, 139, 0.55)',
    };
  }, [isLight]);

  // ---------------------------------------------------------------------------
  // CANVAS RENDERING (ON-DEMAND RAF SCHEDULER)
  // ---------------------------------------------------------------------------
  const rafIdRef = useRef<number | null>(null);

  const renderFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const { width, height } = dimensions;

    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    // Apply viewport camera transform
    const { panX, panY, zoom } = viewportRef.current;
    ctx.translate(panX, panY);
    ctx.scale(zoom, zoom);

    const curLayout = layoutRef.current;
    const curSelectedNode = selectedNodeId;
    const curSelectedEdge = selectedEdgeId;
    const curHoveredNode = hoveredNodeIdRef.current;
    const curHoveredEdge = hoveredEdgeIdRef.current;
    const curKeyNode = keyboardNodeId;

    // 1. Draw Column Headers
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const header of curLayout.headers) {
      ctx.font = '600 13px system-ui, -apple-system, sans-serif';
      ctx.fillStyle = palette.headerTitle;
      ctx.fillText(header.title.toUpperCase(), header.x, header.y);

      ctx.font = '400 11px system-ui, -apple-system, sans-serif';
      ctx.fillStyle = palette.headerSubtitle;
      ctx.fillText(header.subtitle, header.x, header.y + 16);

      if (header.omittedCount > 0) {
        ctx.font = '500 10px monospace';
        ctx.fillStyle = palette.headerOmitted;
        ctx.fillText(`+${header.omittedCount} omitted`, header.x, header.y + 32);
      }
    }

    // 2. Draw Edges
    for (const edge of curLayout.edges) {
      const isSelected = edge.id === curSelectedEdge;
      const isHovered = edge.id === curHoveredEdge;
      const isConnectedToHoveredNode =
        curHoveredNode && (edge.sourceId === curHoveredNode || edge.targetId === curHoveredNode);
      const isConnectedToSelectedNode =
        curSelectedNode && (edge.sourceId === curSelectedNode || edge.targetId === curSelectedNode);

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(edge.startX, edge.startY);
      ctx.bezierCurveTo(edge.cp1X, edge.cp1Y, edge.cp2X, edge.cp2Y, edge.endX, edge.endY);

      // Line stroke style based on relationship kind
      if (edge.relationshipKind === 'TypeOnly') {
        ctx.setLineDash([5, 4]);
      } else if (edge.relationshipKind === 'DynamicImport') {
        ctx.setLineDash([2, 3]);
      } else {
        ctx.setLineDash([]);
      }

      // Colors
      if (isSelected) {
        ctx.strokeStyle = palette.edgeSelected;
        ctx.lineWidth = 2.8;
        ctx.shadowColor = isLight ? 'rgba(13, 148, 136, 0.35)' : 'rgba(45, 212, 191, 0.4)';
        ctx.shadowBlur = 8;
      } else if (isHovered || isConnectedToHoveredNode) {
        ctx.strokeStyle = palette.edgeHovered;
        ctx.lineWidth = 2.2;
        ctx.shadowColor = isLight ? 'rgba(2, 132, 199, 0.3)' : 'rgba(56, 189, 248, 0.3)';
        ctx.shadowBlur = 6;
      } else if (isConnectedToSelectedNode) {
        ctx.strokeStyle = palette.edgeConnectedSelected;
        ctx.lineWidth = 1.8;
      } else {
        ctx.strokeStyle =
          edge.relationshipKind === 'Export' ? palette.edgeExport : palette.edgeDefault;
        ctx.lineWidth = 1.4;
      }

      ctx.stroke();

      // Arrowhead at target
      const arrowLen = isSelected ? 9 : 7;
      const arrowAngle = edge.arrowAngle;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.moveTo(edge.endX, edge.endY);
      ctx.lineTo(
        edge.endX - arrowLen * Math.cos(arrowAngle - Math.PI / 6),
        edge.endY - arrowLen * Math.sin(arrowAngle - Math.PI / 6)
      );
      ctx.lineTo(
        edge.endX - arrowLen * Math.cos(arrowAngle + Math.PI / 6),
        edge.endY - arrowLen * Math.sin(arrowAngle + Math.PI / 6)
      );
      ctx.closePath();
      ctx.fill();

      ctx.restore();
    }

    // 3. Draw Nodes
    for (const node of curLayout.nodes) {
      const isFocus = node.isFocus;
      const isSelected = node.id === curSelectedNode;
      const isHovered = node.id === curHoveredNode;
      const isKeyFocused = node.id === curKeyNode;

      const left = node.x - node.width / 2;
      const top = node.y - node.height / 2;
      const radius = 6;

      ctx.save();

      // Outer Glow & Shadow
      if (isFocus) {
        ctx.shadowColor = palette.cardShadowFocus;
        ctx.shadowBlur = 14;
      } else if (isSelected) {
        ctx.shadowColor = palette.cardShadowSelected;
        ctx.shadowBlur = 10;
      } else if (isHovered) {
        ctx.shadowColor = palette.cardShadowHover;
        ctx.shadowBlur = 6;
      }

      // Card Background
      ctx.beginPath();
      ctx.roundRect(left, top, node.width, node.height, radius);
      ctx.fillStyle = isFocus
        ? palette.cardBgFocus
        : isSelected
        ? palette.cardBgSelected
        : isHovered
        ? palette.cardBgHover
        : palette.cardBgNormal;
      ctx.fill();

      // Card Border
      ctx.lineWidth = isFocus ? 2 : isSelected ? 2 : 1;
      ctx.strokeStyle = isFocus
        ? palette.cardBorderFocus
        : isSelected
        ? palette.cardBorderSelected
        : isHovered
        ? palette.cardBorderHover
        : palette.cardBorderNormal;
      ctx.stroke();

      // Keyboard navigation focus ring
      if (isKeyFocused && !isSelected) {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = isLight ? '#d97706' : '#f59e0b';
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.roundRect(left - 3, top - 3, node.width + 6, node.height + 6, radius + 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.restore();

      // Card Content (Color Dot, Filename, Path)
      const typeInfo = getFileTypeInfo(node.node.relative_path);
      const dotX = left + 14;
      const dotY = top + node.height / 2;

      // Dot
      ctx.fillStyle = typeInfo.color;
      ctx.beginPath();
      ctx.arc(dotX, dotY, isFocus ? 5 : 4, 0, Math.PI * 2);
      ctx.fill();

      // Filename
      const filenameFont = isFocus
        ? '600 13px system-ui, -apple-system, sans-serif'
        : '500 12px system-ui, -apple-system, sans-serif';
      ctx.font = filenameFont;
      ctx.fillStyle = isFocus
        ? palette.textFocus
        : isSelected
        ? palette.textSelected
        : palette.textNormal;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';

      const textX = dotX + (isFocus ? 12 : 10);
      const nameY = top + (isFocus ? 22 : 18);
      const maxTextW = node.width - (textX - left) - (isFocus ? 45 : 12);

      const displayFilename = getTruncatedText(ctx, node.node.filename, maxTextW, filenameFont, false);
      ctx.fillText(displayFilename, textX, nameY);

      // Relative Path
      const pathFont = '400 10px monospace';
      ctx.font = pathFont;
      ctx.fillStyle = palette.textMuted;
      const pathY = top + (isFocus ? 38 : 32);

      const displayPath = getTruncatedText(ctx, node.node.relative_path, maxTextW, pathFont, true);
      ctx.fillText(displayPath, textX, pathY);

      // Badges for Focus Node (dependencies and dependents counts)
      if (isFocus) {
        ctx.font = '600 9px monospace';
        ctx.textAlign = 'right';
        ctx.fillStyle = isLight ? '#0284c7' : '#38bdf8';
        ctx.fillText(`IN: ${node.node.direct_dependent_count}`, left + node.width - 10, top + 20);
        ctx.fillStyle = isLight ? '#0d9488' : '#2dd4bf';
        ctx.fillText(`OUT: ${node.node.direct_dependency_count}`, left + node.width - 10, top + 36);
      }
    }

    ctx.restore();
  }, [dimensions, selectedNodeId, selectedEdgeId, keyboardNodeId, palette, isLight]);

  const requestRender = useCallback(() => {
    if (rafIdRef.current !== null) return;
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      renderFrame();
    });
  }, [renderFrame]);

  useEffect(() => {
    requestRender();
  }, [
    requestRender,
    viewport,
    layout,
    selectedNodeId,
    selectedEdgeId,
    hoveredNodeId,
    hoveredEdgeId,
    keyboardNodeId,
    palette,
  ]);

  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, []);

  // ---------------------------------------------------------------------------
  // INTERACTION HANDLERS (PAN, ZOOM, SELECTION, REFOCUS WITH POINTER CAPTURE)
  // ---------------------------------------------------------------------------
  const screenToWorld = useCallback((screenX: number, screenY: number) => {
    const { panX, panY, zoom } = viewportRef.current;
    return {
      x: (screenX - panX) / zoom,
      y: (screenY - panY) / zoom,
    };
  }, []);

  const findNodeAt = useCallback(
    (worldX: number, worldY: number): LayoutNode | null => {
      for (const node of layoutRef.current.nodes) {
        const left = node.x - node.width / 2;
        const right = node.x + node.width / 2;
        const top = node.y - node.height / 2;
        const bottom = node.y + node.height / 2;

        if (worldX >= left && worldX <= right && worldY >= top && worldY <= bottom) {
          return node;
        }
      }
      return null;
    },
    []
  );

  const findEdgeAt = useCallback(
    (worldX: number, worldY: number): LayoutEdge | null => {
      const HIT_THRESHOLD = 6;
      for (const edge of layoutRef.current.edges) {
        // Approximate distance to cubic bezier curve by sampling 10 points
        for (let t = 0; t <= 1; t += 0.1) {
          const invT = 1 - t;
          const px =
            invT * invT * invT * edge.startX +
            3 * invT * invT * t * edge.cp1X +
            3 * invT * t * t * edge.cp2X +
            t * t * t * edge.endX;
          const py =
            invT * invT * invT * edge.startY +
            3 * invT * invT * t * edge.cp1Y +
            3 * invT * t * t * edge.cp2Y +
            t * t * t * edge.endY;

          const distSq = (worldX - px) * (worldX - px) + (worldY - py) * (worldY - py);
          if (distSq <= HIT_THRESHOLD * HIT_THRESHOLD) {
            return edge;
          }
        }
      }
      return null;
    },
    []
  );

  const cleanUpPointerGesture = useCallback((e?: React.PointerEvent<HTMLCanvasElement>) => {
    if (e && activePointerIdRef.current === e.pointerId) {
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // ignored
      }
    }
    isDraggingRef.current = false;
    activePointerIdRef.current = null;
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 && e.button !== 1) return; // Only primary or middle drag
    containerRef.current?.focus();

    isDraggingRef.current = true;
    hasDraggedRef.current = false;
    activePointerIdRef.current = e.pointerId;
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      panX: viewportRef.current.panX,
      panY: viewportRef.current.panY,
    };

    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // ignored
    }
  }, []);

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;

      if (isDraggingRef.current && activePointerIdRef.current === e.pointerId) {
        const dx = e.clientX - dragStartRef.current.x;
        const dy = e.clientY - dragStartRef.current.y;
        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
          hasDraggedRef.current = true;
        }
        const next = {
          ...viewportRef.current,
          panX: dragStartRef.current.panX + dx,
          panY: dragStartRef.current.panY + dy,
        };
        setViewport(next);
        onViewportChange?.(next);
        requestRender();
        return;
      }

      // Hit test hover
      const world = screenToWorld(screenX, screenY);
      const hitNode = findNodeAt(world.x, world.y);
      if (hitNode) {
        if (hoveredNodeIdRef.current !== hitNode.id) {
          setHoveredNodeId(hitNode.id);
          requestRender();
        }
        if (hoveredEdgeIdRef.current !== null) {
          setHoveredEdgeId(null);
          requestRender();
        }
        return;
      }

      if (hoveredNodeIdRef.current !== null) {
        setHoveredNodeId(null);
        requestRender();
      }

      const hitEdge = findEdgeAt(world.x, world.y);
      if (hitEdge) {
        if (hoveredEdgeIdRef.current !== hitEdge.id) {
          setHoveredEdgeId(hitEdge.id);
          requestRender();
        }
      } else if (hoveredEdgeIdRef.current !== null) {
        setHoveredEdgeId(null);
        requestRender();
      }
    },
    [screenToWorld, findNodeAt, findEdgeAt, onViewportChange, requestRender]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!isDraggingRef.current) return;
      const wasDragging = hasDraggedRef.current;
      cleanUpPointerGesture(e);

      if (!wasDragging) {
        // Single Click -> Selection
        const rect = e.currentTarget.getBoundingClientRect();
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;
        const world = screenToWorld(screenX, screenY);

        const hitNode = findNodeAt(world.x, world.y);
        if (hitNode) {
          onSelectNode(hitNode.node);
          onSelectEdge(null);
          setKeyboardNodeId(hitNode.id);
          onAnnounce?.(`Selected file ${hitNode.node.filename}`);
          return;
        }

        const hitEdge = findEdgeAt(world.x, world.y);
        if (hitEdge) {
          onSelectEdge(hitEdge.edge);
          onSelectNode(null);
          onAnnounce?.(`Selected relationship ${hitEdge.relationshipKind}`);
          return;
        }

        // Clicked background -> clear selections
        onSelectNode(null);
        onSelectEdge(null);
      }
    },
    [cleanUpPointerGesture, screenToWorld, findNodeAt, findEdgeAt, onSelectNode, onSelectEdge, onAnnounce]
  );

  const handlePointerCancel = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      cleanUpPointerGesture(e);
    },
    [cleanUpPointerGesture]
  );

  // Window blur / visibility cleanup
  useEffect(() => {
    const handleBlur = () => {
      isDraggingRef.current = false;
      activePointerIdRef.current = null;
    };
    window.addEventListener('blur', handleBlur);
    return () => window.removeEventListener('blur', handleBlur);
  }, []);

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;
      const world = screenToWorld(screenX, screenY);

      const hitNode = findNodeAt(world.x, world.y);
      if (hitNode && !hitNode.isFocus) {
        // Explicit intent: Double-click refocuses 2D neighborhood!
        onRefocusNode(hitNode.id);
        onAnnounce?.(`Refocused 2D relationship neighborhood on ${hitNode.node.filename}`);
      }
    },
    [screenToWorld, findNodeAt, onRefocusNode, onAnnounce]
  );

  const handleWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const zoomFactor = Math.exp(-e.deltaY * 0.0018);
      const cur = viewportRef.current;
      const nextZoom = Math.min(2.5, Math.max(0.15, cur.zoom * zoomFactor));

      const nextPanX = mouseX - (mouseX - cur.panX) * (nextZoom / cur.zoom);
      const nextPanY = mouseY - (mouseY - cur.panY) * (nextZoom / cur.zoom);

      const next = { panX: nextPanX, panY: nextPanY, zoom: nextZoom };
      setViewport(next);
      onViewportChange?.(next);
      requestRender();
    },
    [onViewportChange, requestRender]
  );

  // Keyboard navigation & accessibility (strictly avoids WCAG 2.1.2 Tab traps)
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const targetTag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (targetTag === 'input' || targetTag === 'textarea') return;

      if (e.key === 'Escape') {
        if (selectedEdgeId) {
          onSelectEdge(null);
        } else if (selectedNodeId) {
          onSelectNode(null);
        }
        return;
      }

      if (e.key === 'Enter') {
        const activeId = keyboardNodeId || selectedNodeId;
        if (activeId && activeId !== focusNodeId) {
          onRefocusNode(activeId);
          const n = layoutRef.current.nodes.find((item) => item.id === activeId);
          if (n) {
            onAnnounce?.(`Refocused 2D relationship neighborhood on ${n.node.filename}`);
          }
        }
        return;
      }

      // Keyboard Zoom
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        const cur = viewportRef.current;
        const nextZoom = Math.min(2.5, cur.zoom * 1.2);
        const next = { ...cur, zoom: nextZoom };
        setViewport(next);
        onViewportChange?.(next);
        requestRender();
        return;
      }

      if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        const cur = viewportRef.current;
        const nextZoom = Math.max(0.15, cur.zoom / 1.2);
        const next = { ...cur, zoom: nextZoom };
        setViewport(next);
        onViewportChange?.(next);
        requestRender();
        return;
      }

      if (e.key === '0') {
        e.preventDefault();
        const cur = viewportRef.current;
        const next = { ...cur, zoom: 1.0 };
        setViewport(next);
        onViewportChange?.(next);
        requestRender();
        return;
      }

      const allNodes = layoutRef.current.nodes;
      if (allNodes.length === 0) return;

      const curIdx = allNodes.findIndex((n) => n.id === (keyboardNodeId || selectedNodeId));

      // Note: Tab is intentionally not intercepted to allow normal keyboard flow out of container
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        const nextIdx = (curIdx + 1) % allNodes.length;
        const nextNode = allNodes[nextIdx];
        setKeyboardNodeId(nextNode.id);
        onSelectNode(nextNode.node);
        onAnnounce?.(`Focused file ${nextNode.node.filename}`);
        requestRender();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        const prevIdx = (curIdx - 1 + allNodes.length) % allNodes.length;
        const prevNode = allNodes[prevIdx];
        setKeyboardNodeId(prevNode.id);
        onSelectNode(prevNode.node);
        onAnnounce?.(`Focused file ${prevNode.node.filename}`);
        requestRender();
      } else if (e.key === 'Home') {
        e.preventDefault();
        const firstNode = allNodes[0];
        setKeyboardNodeId(firstNode.id);
        onSelectNode(firstNode.node);
        onAnnounce?.(`Focused file ${firstNode.node.filename}`);
        requestRender();
      } else if (e.key === 'End') {
        e.preventDefault();
        const lastNode = allNodes[allNodes.length - 1];
        setKeyboardNodeId(lastNode.id);
        onSelectNode(lastNode.node);
        onAnnounce?.(`Focused file ${lastNode.node.filename}`);
        requestRender();
      }
    },
    [
      selectedEdgeId,
      selectedNodeId,
      keyboardNodeId,
      focusNodeId,
      onSelectEdge,
      onSelectNode,
      onRefocusNode,
      onViewportChange,
      requestRender,
      onAnnounce,
    ]
  );

  // Top connected candidate files for purposeful empty state
  const topCandidates = useMemo(() => {
    if (!snapshot) return [];
    return [...snapshot.nodes]
      .sort((a, b) => b.direct_dependent_count + b.direct_dependency_count - (a.direct_dependent_count + a.direct_dependency_count))
      .slice(0, 8);
  }, [snapshot]);

  const filteredCandidates = useMemo(() => {
    if (!searchFilter.trim() || !snapshot) return topCandidates;
    const q = searchFilter.toLowerCase();
    return snapshot.nodes.filter((n) => n.relative_path.toLowerCase().includes(q)).slice(0, 8);
  }, [snapshot, searchFilter, topCandidates]);

  // ---------------------------------------------------------------------------
  // PURPOSEFUL EMPTY & MISSING STATES
  // ---------------------------------------------------------------------------
  if (!focusNodeId || !graphData.focusNode) {
    return (
      <div className="relationship-empty-state" tabIndex={0} onKeyDown={handleKeyDown}>
        <div className="empty-card">
          {missingFocusPath ? (
            <>
              <AlertCircle size={36} color="#f59e0b" className="empty-icon" />
              <h3>File Not Found</h3>
              <p className="empty-desc">
                Could not locate file <code className="mono">{missingFocusPath}</code> in the indexed repository graph.
              </p>
            </>
          ) : (
            <>
              <Layers size={36} color={isLight ? '#0284c7' : '#38bdf8'} className="empty-icon" />
              <h3>Contextual 2D Relationship Explorer</h3>
              <p className="empty-desc">
                Select a file to examine its directed dependencies and dependents in a clean 2D layout.
              </p>
            </>
          )}

          <div className="empty-search-box">
            <Search size={15} color={isLight ? '#64748b' : '#94a3b8'} />
            <input
              type="text"
              placeholder="Search files to explore in 2D..."
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              autoFocus
              aria-label="Search files to explore in 2D"
            />
          </div>

          <div className="empty-candidate-list">
            <span className="candidate-title">Suggested files with high connections:</span>
            <div className="candidate-grid">
              {filteredCandidates.map((cand) => (
                <button
                  key={cand.id}
                  className="candidate-item"
                  onClick={() => {
                    onRefocusNode(cand.id);
                    onAnnounce?.(`Focused file ${cand.filename}`);
                  }}
                  title={`Focus on ${cand.relative_path}`}
                >
                  <FileCode size={13} color={isLight ? '#0d9488' : '#2dd4bf'} />
                  <span className="mono cand-path">{cand.relative_path}</span>
                  <span className="cand-badge">{cand.direct_dependent_count + cand.direct_dependency_count} conn</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // ACTIVE 2D RELATIONSHIP CANVAS VIEW
  // ---------------------------------------------------------------------------
  return (
    <div
      ref={containerRef}
      className="relationship-container"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      role="region"
      aria-label="2D Relationship Explorer"
    >
      {/* HUD Controls Overlay */}
      <div className="relationship-hud">
        {/* Left Toolbar: Back button & Navigation Depth */}
        <div className="hud-left-group">
          {canGoBack && onBackFocus && (
            <button
              className="hud-btn back-btn"
              onClick={() => {
                onBackFocus();
                onAnnounce?.(`Navigated back to ${backTargetName || 'previous file'}`);
              }}
              title={`Back to ${backTargetName || 'previous file'}`}
            >
              <ArrowLeft size={14} />
              <span>Back</span>
            </button>
          )}

          <div className="hud-segmented-group" title="Traversal Depth" role="radiogroup" aria-label="Traversal Depth">
            <button
              className={`hud-segment ${depth === 1 ? 'active' : ''}`}
              onClick={() => setDepth(1)}
              role="radio"
              aria-checked={depth === 1}
            >
              1 Hop
            </button>
            <button
              className={`hud-segment ${depth === 2 ? 'active' : ''}`}
              onClick={() => setDepth(2)}
              role="radio"
              aria-checked={depth === 2}
            >
              2 Hops
            </button>
          </div>

          <div className="hud-segmented-group" title="Direction Filter" role="radiogroup" aria-label="Direction Filter">
            <button
              className={`hud-segment ${direction === 'both' ? 'active' : ''}`}
              onClick={() => setDirection('both')}
              role="radio"
              aria-checked={direction === 'both'}
            >
              All
            </button>
            <button
              className={`hud-segment ${direction === 'dependents' ? 'active' : ''}`}
              onClick={() => setDirection('dependents')}
              role="radio"
              aria-checked={direction === 'dependents'}
            >
              Dependents
            </button>
            <button
              className={`hud-segment ${direction === 'dependencies' ? 'active' : ''}`}
              onClick={() => setDirection('dependencies')}
              role="radio"
              aria-checked={direction === 'dependencies'}
            >
              Dependencies
            </button>
          </div>
        </div>

        {/* Right Toolbar: Omission badge & Local View fit */}
        <div className="hud-right-group">
          {graphData.omission.isCapped && (
            <div
              className="hud-omission-badge"
              title={`Showing ${layout.nodes.length} files (${
                graphData.omission.omittedDirectDependents +
                graphData.omission.omittedDirectDependencies +
                graphData.omission.omittedSecondHopDependents +
                graphData.omission.omittedSecondHopDependencies
              } omitted). Showing ${layout.edges.length} edges (${graphData.omission.omittedEdges} omitted).`}
            >
              <AlertCircle size={13} color="#f59e0b" />
              <span>
                {layout.nodes.length} files visible (+
                {graphData.omission.omittedDirectDependents +
                  graphData.omission.omittedDirectDependencies +
                  graphData.omission.omittedSecondHopDependents +
                  graphData.omission.omittedSecondHopDependencies}{' '}
                omitted)
              </span>
            </div>
          )}

          <button
            className="hud-icon-btn"
            onClick={() => {
              fitToGraph(layout.bounds, dimensions.width, dimensions.height);
              onAnnounce?.('Fitted 2D relationship view to all visible nodes');
            }}
            title="Fit 2D Relationship View"
            aria-label="Fit 2D Relationship View"
          >
            <Maximize2 size={14} />
          </button>
          <button
            className="hud-icon-btn"
            onClick={() => {
              resetToCenter(dimensions.width, dimensions.height);
              onAnnounce?.('Reset 2D relationship camera to center');
            }}
            title="Reset 2D Camera"
            aria-label="Reset 2D Camera"
          >
            <RotateCcw size={14} />
          </button>
        </div>
      </div>

      {/* Main Canvas Element */}
      <canvas
        ref={canvasRef}
        className="relationship-canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={cleanUpPointerGesture}
        onDoubleClick={handleDoubleClick}
        onWheel={handleWheel}
      />
    </div>
  );
};
