import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { DependencyEdge, FileNode, GraphSnapshot, Point2D, Point3D, Transform } from '../../types/graph';
import { layoutOrganic } from './layout/organicLayout';
import { projectPoint3D, computeNetworkVisualRadius, computeDepthAlpha } from './render/networkRenderMath';
import { resolveNetworkEdgeVisual } from './render/networkEdgeVisual';
import { getFileTypeColor, ENTRY_NODE_COLOR } from './fileTypeColors';

interface NetworkCanvasProps {
  snapshot: GraphSnapshot;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  onSelectNode: (node: FileNode | null) => void;
  onSelectEdge: (edge: DependencyEdge | null) => void;
  focusedNodeId: string | null;
  fitViewTrigger?: number;
  resetViewTrigger?: number;
}

export const NetworkCanvas: React.FC<NetworkCanvasProps> = ({
  snapshot,
  selectedNodeId,
  selectedEdgeId,
  onSelectNode,
  onSelectEdge,
  focusedNodeId,
  fitViewTrigger,
  resetViewTrigger,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, k: 1 });
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [positions, setPositions] = useState<Map<string, Point3D>>(new Map());

  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<Point2D>({ x: 0, y: 0 });
  const initialTransformRef = useRef<Transform>({ x: 0, y: 0, k: 1 });
  const didDragRef = useRef(false);

  // Compute layout positions once per snapshot
  useEffect(() => {
    if (!snapshot || snapshot.nodes.length === 0) {
      setPositions(new Map());
      return;
    }

    const layoutNodes = snapshot.nodes.map((n, idx) => ({
      id: n.id,
      val: (n.direct_dependency_count || 0) + (n.direct_dependent_count || 0) + 1,
      isEntry: idx === 0 || n.filename === 'index.ts' || n.filename === 'main.ts',
    }));

    const layoutLinks = snapshot.edges.map((e) => ({
      source: e.source_file_id,
      target: e.target_file_id,
    }));

    const isFirstRun = positions.size === 0;
    const computed = layoutOrganic(layoutNodes, layoutLinks);
    setPositions(computed);

    // Initial fit view ONLY on first load (preserve viewport on live updates!)
    if (isFirstRun && containerRef.current) {
      const width = containerRef.current.clientWidth || 800;
      const height = containerRef.current.clientHeight || 600;
      fitViewToPoints(computed, width, height);
    }
  }, [snapshot]);

  // Handle external fit view trigger
  useEffect(() => {
    if (fitViewTrigger && fitViewTrigger > 0 && containerRef.current && positions.size > 0) {
      const width = containerRef.current.clientWidth || 800;
      const height = containerRef.current.clientHeight || 600;
      fitViewToPoints(positions, width, height);
    }
  }, [fitViewTrigger, positions]);

  // Handle external reset view trigger
  useEffect(() => {
    if (resetViewTrigger && resetViewTrigger > 0 && containerRef.current) {
      const width = containerRef.current.clientWidth || 800;
      const height = containerRef.current.clientHeight || 600;
      setTransform({ x: width / 2, y: height / 2, k: 1 });
    }
  }, [resetViewTrigger]);

  // Neighbor map for highlighting
  const neighborMap = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const edge of snapshot.edges) {
      if (!map.has(edge.source_file_id)) map.set(edge.source_file_id, new Set());
      if (!map.has(edge.target_file_id)) map.set(edge.target_file_id, new Set());
      map.get(edge.source_file_id)!.add(edge.target_file_id);
      map.get(edge.target_file_id)!.add(edge.source_file_id);
    }
    return map;
  }, [snapshot.edges]);

  const fitViewToPoints = (pts: Map<string, Point3D>, width: number, height: number) => {
    if (pts.size === 0) {
      setTransform({ x: width / 2, y: height / 2, k: 1 });
      return;
    }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pts.values()) {
      const proj = projectPoint3D(p.x, p.y, p.z);
      if (proj.x < minX) minX = proj.x;
      if (proj.x > maxX) maxX = proj.x;
      if (proj.y < minY) minY = proj.y;
      if (proj.y > maxY) maxY = proj.y;
    }

    const graphWidth = Math.max(50, maxX - minX);
    const graphHeight = Math.max(50, maxY - minY);
    const pad = 120;
    const scaleX = (width - pad * 2) / graphWidth;
    const scaleY = (height - pad * 2) / graphHeight;
    const k = Math.min(2.5, Math.max(0.2, Math.min(scaleX, scaleY)));

    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;

    setTransform({
      x: width / 2 - midX * k,
      y: height / 2 - midY * k,
      k,
    });
  };

  // Focus node helper
  const focusNode = useCallback((nodeId: string) => {
    const p = positions.get(nodeId);
    if (!p || !containerRef.current) return;

    const width = containerRef.current.clientWidth || 800;
    const height = containerRef.current.clientHeight || 600;
    const proj = projectPoint3D(p.x, p.y, p.z);
    const targetK = Math.max(transform.k, 1.2);

    setTransform({
      x: width / 2 - proj.x * targetK,
      y: height / 2 - proj.y * targetK,
      k: targetK,
    });
  }, [positions, transform.k]);

  useEffect(() => {
    if (focusedNodeId) {
      focusNode(focusedNodeId);
    }
  }, [focusedNodeId, focusNode]);

  // Main Canvas Render Loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 800;
    const height = canvas.clientHeight || 600;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, width, height);

    ctx.save();
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.k, transform.k);

    const activeHighlightId = selectedNodeId || hoveredNodeId;
    const connectedNodes = activeHighlightId
      ? new Set([activeHighlightId, ...(neighborMap.get(activeHighlightId) || [])])
      : null;

    // 1. Draw Edges
    const edgesToDraw = [];
    for (const edge of snapshot.edges) {
      const p1Raw = positions.get(edge.source_file_id);
      const p2Raw = positions.get(edge.target_file_id);
      if (!p1Raw || !p2Raw) continue;

      const p1 = projectPoint3D(p1Raw.x, p1Raw.y, p1Raw.z);
      const p2 = projectPoint3D(p2Raw.x, p2Raw.y, p2Raw.z);

      const isConnected = Boolean(
        activeHighlightId &&
          (edge.source_file_id === activeHighlightId || edge.target_file_id === activeHighlightId)
      );

      const isEdgeSelected = selectedEdgeId === edge.id;
      const desc = resolveNetworkEdgeVisual(edge, isConnected || isEdgeSelected, activeHighlightId, transform.k);
      if (!desc) continue;

      edgesToDraw.push({ p1, p2, desc, isEdgeSelected });
    }

    edgesToDraw.sort((a, b) => a.desc.priority - b.desc.priority);

    for (const { p1, p2, desc, isEdgeSelected } of edgesToDraw) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.strokeStyle = isEdgeSelected ? '#38bdf8' : desc.color;
      ctx.lineWidth = isEdgeSelected ? Math.max(2.5, 3.2 / transform.k) : desc.width;
      ctx.globalAlpha = isEdgeSelected ? 1.0 : desc.alpha;
      if (desc.dash.length > 0) ctx.setLineDash(desc.dash);
      ctx.stroke();

      // Arrow geometry pointing from source to target
      if (desc.showArrow || isEdgeSelected) {
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const len = Math.hypot(dx, dy);
        if (len > 20) {
          const midX = p1.x + dx * 0.62;
          const midY = p1.y + dy * 0.62;
          const angle = Math.atan2(dy, dx);
          const arrowSize = Math.max(3.5, 4.5 / transform.k);

          ctx.fillStyle = isEdgeSelected ? '#38bdf8' : desc.color;
          ctx.beginPath();
          ctx.moveTo(midX, midY);
          ctx.lineTo(
            midX - arrowSize * Math.cos(angle - Math.PI / 6),
            midY - arrowSize * Math.sin(angle - Math.PI / 6)
          );
          ctx.lineTo(
            midX - arrowSize * Math.cos(angle + Math.PI / 6),
            midY - arrowSize * Math.sin(angle + Math.PI / 6)
          );
          ctx.closePath();
          ctx.fill();
        }
      }
      ctx.restore();
    }

    // 2. Draw Nodes sorted by depth (z)
    const sortedNodes = [];
    for (const node of snapshot.nodes) {
      const pRaw = positions.get(node.id);
      if (!pRaw) continue;
      const p = projectPoint3D(pRaw.x, pRaw.y, pRaw.z);
      sortedNodes.push({ node, p });
    }
    sortedNodes.sort((a, b) => a.p.z - b.p.z);

    for (const { node, p } of sortedNodes) {
      const isSelected = selectedNodeId === node.id;
      const isHovered = hoveredNodeId === node.id;
      const isDimmed = Boolean(connectedNodes && !connectedNodes.has(node.id));

      const r = computeNetworkVisualRadius(node, p.depthScale, {
        isSelected,
        isHovered,
        zoom: transform.k,
      });

      const depthAlpha = computeDepthAlpha(p.depthScale);

      ctx.save();
      ctx.globalAlpha = isDimmed ? 0.2 : depthAlpha;

      // Selection outer ring
      if (isSelected) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 4, 0, Math.PI * 2);
        ctx.strokeStyle = '#2dd4bf';
        ctx.lineWidth = 2.5;
        ctx.stroke();
      } else if (isHovered) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 3, 0, Math.PI * 2);
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2.0;
        ctx.stroke();
      }

      // Node Body
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = node.id === snapshot.nodes[0]?.id ? ENTRY_NODE_COLOR : getFileTypeColor(node.relative_path);
      ctx.fill();

      ctx.strokeStyle = isSelected ? '#2dd4bf' : (isHovered ? '#38bdf8' : 'rgba(15, 23, 42, 0.85)');
      ctx.lineWidth = isSelected || isHovered ? 1.8 : 1.0;
      ctx.stroke();
      ctx.restore();
    }

    // 3. Draw Node Labels
    for (const { node, p } of sortedNodes) {
      const isSelected = selectedNodeId === node.id;
      const isHovered = hoveredNodeId === node.id;
      const shouldDrawLabel = isSelected || isHovered || transform.k > 0.85 || node.direct_dependent_count > 2;

      if (!shouldDrawLabel) continue;

      const r = computeNetworkVisualRadius(node, p.depthScale, {
        isSelected,
        isHovered,
        zoom: transform.k,
      });

      const fontSize = Math.max(10, Math.min(14, 12 / transform.k));
      ctx.save();
      ctx.font = `500 ${fontSize}px "JetBrains Mono", monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';

      const labelY = p.y + r + 3;
      const text = node.filename;

      // Subtle label halo for readability over intersecting edges
      ctx.strokeStyle = 'rgba(10, 14, 23, 0.9)';
      ctx.lineWidth = 3.5;
      ctx.strokeText(text, p.x, labelY);

      ctx.fillStyle = isSelected ? '#2dd4bf' : (isHovered ? '#38bdf8' : '#e2e8f0');
      ctx.fillText(text, p.x, labelY);
      ctx.restore();
    }

    ctx.restore();
  }, [snapshot, positions, transform, selectedNodeId, selectedEdgeId, hoveredNodeId, neighborMap]);

  // Pointer event handlers
  const handlePointerDown = (e: React.PointerEvent) => {
    isDraggingRef.current = true;
    didDragRef.current = false;
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    initialTransformRef.current = { ...transform };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (isDraggingRef.current) {
      const dx = e.clientX - dragStartRef.current.x;
      const dy = e.clientY - dragStartRef.current.y;
      if (Math.hypot(dx, dy) > 4) {
        didDragRef.current = true;
      }
      setTransform({
        x: initialTransformRef.current.x + dx,
        y: initialTransformRef.current.y + dy,
        k: initialTransformRef.current.k,
      });
      return;
    }

    // Hit test on hover
    const hitNode = findNodeAtPoint(e.clientX, e.clientY);
    setHoveredNodeId(hitNode?.id || null);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    isDraggingRef.current = false;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignored
    }

    if (!didDragRef.current) {
      // Click interaction
      const hitNode = findNodeAtPoint(e.clientX, e.clientY);
      if (hitNode) {
        onSelectNode(hitNode);
        onSelectEdge(null);
      } else {
        const hitEdge = findEdgeAtPoint(e.clientX, e.clientY);
        if (hitEdge) {
          onSelectEdge(hitEdge);
          onSelectNode(null);
        } else {
          onSelectNode(null);
          onSelectEdge(null);
        }
      }
    }
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const zoomFactor = Math.pow(1.0015, -e.deltaY);
    const newK = Math.max(0.15, Math.min(4.0, transform.k * zoomFactor));

    // Zoom centered at cursor
    const newX = mouseX - (mouseX - transform.x) * (newK / transform.k);
    const newY = mouseY - (mouseY - transform.y) * (newK / transform.k);

    setTransform({ x: newX, y: newY, k: newK });
  };

  const findNodeAtPoint = (clientX: number, clientY: number): FileNode | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;

    const rect = canvas.getBoundingClientRect();
    const worldX = (clientX - rect.left - transform.x) / transform.k;
    const worldY = (clientY - rect.top - transform.y) / transform.k;

    let bestHit: FileNode | null = null;
    let bestDist = Infinity;

    for (const node of snapshot.nodes) {
      const pRaw = positions.get(node.id);
      if (!pRaw) continue;
      const p = projectPoint3D(pRaw.x, pRaw.y, pRaw.z);
      const r = computeNetworkVisualRadius(node, p.depthScale, { zoom: transform.k });
      const dist = Math.hypot(p.x - worldX, p.y - worldY);

      if (dist <= r + 6 && dist < bestDist) {
        bestDist = dist;
        bestHit = node;
      }
    }

    return bestHit;
  };

  const findEdgeAtPoint = (clientX: number, clientY: number): DependencyEdge | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;

    const rect = canvas.getBoundingClientRect();
    const worldX = (clientX - rect.left - transform.x) / transform.k;
    const worldY = (clientY - rect.top - transform.y) / transform.k;

    const hitTolerance = 6 / transform.k;
    let bestEdge: DependencyEdge | null = null;
    let bestDist = Infinity;

    for (const edge of snapshot.edges) {
      const p1Raw = positions.get(edge.source_file_id);
      const p2Raw = positions.get(edge.target_file_id);
      if (!p1Raw || !p2Raw) continue;

      const p1 = projectPoint3D(p1Raw.x, p1Raw.y, p1Raw.z);
      const p2 = projectPoint3D(p2Raw.x, p2Raw.y, p2Raw.z);

      const dist = pointToSegmentDistance({ x: worldX, y: worldY }, p1, p2);
      if (dist < hitTolerance && dist < bestDist) {
        bestDist = dist;
        bestEdge = edge;
      }
    }

    return bestEdge;
  };

  function pointToSegmentDistance(p: Point2D, a: Point2D, b: Point2D): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);

    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
    const projX = a.x + t * dx;
    const projY = a.y + t * dy;
    return Math.hypot(p.x - projX, p.y - projY);
  }

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        cursor: isDraggingRef.current ? 'grabbing' : (hoveredNodeId ? 'pointer' : 'default'),
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
          touchAction: 'none',
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onWheel={handleWheel}
      />
    </div>
  );
};

