import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import {
  DependencyEdge,
  FileNode,
  GraphSnapshot,
  NetworkCamera,
  Point3D,
  ViewportInsets,
} from '../../types/graph';
import { processSnapshotRevision } from './layout/snapshotRevision';
import {
  DEFAULT_YAW,
  DEFAULT_PITCH,
  MIN_ZOOM,
  MAX_ZOOM,
  wrapRotationAngle,
  clampPitch,
  computeGraphCentroid,
  computeDepthAlpha,
  projectGraph,
  computeNetworkFitTransform,
  findHitNode,
  computeRevealCamera,
  applyZoomAroundCursor,
  normalizeWheelZoomDelta,
  computeContinuousZoomFactor,
  handleGesturePointerDown,
  handleGesturePointerMove,
  resetGestureState,
  createDefaultCamera,
  ProjectedGraph,
  NetworkGestureState,
} from './render/networkRenderMath';
import { resolveNetworkEdgeVisual } from './render/networkEdgeVisual';
import { getFileTypeColor, ENTRY_NODE_COLOR } from './fileTypeColors';

export interface RevealRequest {
  nodeId: string;
  timestamp: number;
  onlyIfOutside?: boolean;
}

interface NetworkCanvasProps {
  snapshot: GraphSnapshot;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  onSelectNode: (node: FileNode | null) => void;
  onSelectEdge: (edge: DependencyEdge | null) => void;
  revealRequest?: RevealRequest | null;
  fitViewTrigger?: number;
  resetViewTrigger?: number;
  insets?: ViewportInsets;
  onAnnounce?: (message: string) => void;
}

interface CameraAnimation {
  startCamera: NetworkCamera;
  targetCamera: NetworkCamera;
  startTime: number;
  durationMs: number;
}

export const NetworkCanvas: React.FC<NetworkCanvasProps> = ({
  snapshot,
  selectedNodeId,
  selectedEdgeId,
  onSelectNode,
  onSelectEdge,
  revealRequest,
  fitViewTrigger,
  resetViewTrigger,
  insets,
  onAnnounce,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [positions, setPositions] = useState<Map<string, Point3D>>(new Map());
  const positionsRef = useRef<Map<string, Point3D>>(new Map());
  positionsRef.current = positions;

  // Repository initialization tracker (fit ONLY on initial load, preserve on revisions)
  const initializedRepoIdRef = useRef<string | null>(null);

  // Authoritative Camera ref (eliminates React re-render churn during 60fps dragging)
  const cameraRef = useRef<NetworkCamera>(createDefaultCamera());

  // RAF & Dirty flag scheduler
  const isDirtyRef = useRef<boolean>(true);
  const rafIdRef = useRef<number | null>(null);
  const cameraAnimRef = useRef<CameraAnimation | null>(null);
  const renderLoopRef = useRef<(timestamp: number) => void>(() => {});

  // Cache for projection output
  const projectedDataRef = useRef<ProjectedGraph | null>(null);
  const centroidRef = useRef<Point3D>({ x: 0, y: 0, z: 0 });

  // Pointer gesture tracking
  const gestureRef = useRef<NetworkGestureState>(resetGestureState(cameraRef.current));

  const prefersReducedMotion = useMemo(() => {
    return typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);

  const requestRender = useCallback(() => {
    isDirtyRef.current = true;
    if (rafIdRef.current === null) {
      rafIdRef.current = requestAnimationFrame((timestamp) => {
        renderLoopRef.current(timestamp);
      });
    }
  }, []);

  // Compute graph layout positions once per snapshot revision
  useEffect(() => {
    const width = containerRef.current?.clientWidth || 800;
    const height = containerRef.current?.clientHeight || 600;

    const result = processSnapshotRevision(
      {
        repositoryId: initializedRepoIdRef.current,
        positions: positionsRef.current,
        camera: cameraRef.current,
      },
      snapshot,
      { width, height, insets }
    );

    initializedRepoIdRef.current = result.state.repositoryId;
    positionsRef.current = result.state.positions;
    setPositions(result.state.positions);
    centroidRef.current = computeGraphCentroid(result.state.positions.values());
    cameraRef.current = result.state.camera;

    requestRender();
  }, [snapshot, insets]);

  // Handle external Fit View trigger (preserves current yaw and pitch!)
  useEffect(() => {
    if (fitViewTrigger && fitViewTrigger > 0 && containerRef.current && positions.size > 0) {
      const width = containerRef.current.clientWidth || 800;
      const height = containerRef.current.clientHeight || 600;

      // Single authoritative projection at current yaw & pitch
      const currentCam = cameraRef.current;
      const proj = projectGraph(snapshot.nodes, positions, centroidRef.current, currentCam);
      const fit = computeNetworkFitTransform(proj.bounds, width, height, insets);

      if (prefersReducedMotion) {
        cameraRef.current = {
          ...currentCam,
          panX: fit.panX,
          panY: fit.panY,
          zoom: fit.zoom,
        };
        requestRender();
      } else {
        cameraAnimRef.current = {
          startCamera: { ...currentCam },
          targetCamera: {
            ...currentCam,
            panX: fit.panX,
            panY: fit.panY,
            zoom: fit.zoom,
          },
          startTime: performance.now(),
          durationMs: 300,
        };
        requestRender();
      }
      onAnnounce?.('Fitted graph to viewport');
    }
  }, [fitViewTrigger, snapshot, positions, insets, prefersReducedMotion, onAnnounce, requestRender]);

  // Handle external Reset View trigger (restores standard yaw & pitch, and fits to viewport)
  useEffect(() => {
    if (resetViewTrigger && resetViewTrigger > 0 && containerRef.current && positions.size > 0) {
      const width = containerRef.current.clientWidth || 800;
      const height = containerRef.current.clientHeight || 600;

      const resetCam: NetworkCamera = {
        yaw: DEFAULT_YAW,
        pitch: DEFAULT_PITCH,
        panX: width / 2,
        panY: height / 2,
        zoom: 1.0,
      };

      const proj = projectGraph(snapshot.nodes, positions, centroidRef.current, resetCam);
      const fit = computeNetworkFitTransform(proj.bounds, width, height, insets);

      const targetCamera: NetworkCamera = {
        yaw: DEFAULT_YAW,
        pitch: DEFAULT_PITCH,
        panX: fit.panX,
        panY: fit.panY,
        zoom: fit.zoom,
      };

      if (prefersReducedMotion) {
        cameraRef.current = targetCamera;
        requestRender();
      } else {
        cameraAnimRef.current = {
          startCamera: { ...cameraRef.current },
          targetCamera,
          startTime: performance.now(),
          durationMs: 350,
        };
        requestRender();
      }
      onAnnounce?.('Reset camera to default 3D orientation');
    }
  }, [resetViewTrigger, snapshot, positions, insets, prefersReducedMotion, onAnnounce, requestRender]);

  // Handle explicit Reveal / Focus request (visibility-aware; preserves yaw & pitch)
  useEffect(() => {
    if (!revealRequest || !containerRef.current) return;
    const { nodeId, onlyIfOutside } = revealRequest;

    let projData = projectedDataRef.current;
    if (!projData && positionsRef.current.size > 0) {
      projData = projectGraph(
        snapshot.nodes,
        positionsRef.current,
        centroidRef.current,
        cameraRef.current
      );
      projectedDataRef.current = projData;
    }
    if (!projData) return;
    const projectedNode = projData.projectedMap.get(nodeId);
    if (!projectedNode) return;

    const width = containerRef.current.clientWidth || 800;
    const height = containerRef.current.clientHeight || 600;

    const targetCamera = computeRevealCamera(
      projectedNode,
      cameraRef.current,
      width,
      height,
      insets,
      onlyIfOutside
    );

    if (!targetCamera) return;

    if (prefersReducedMotion) {
      cameraRef.current = targetCamera;
      requestRender();
    } else {
      cameraAnimRef.current = {
        startCamera: { ...cameraRef.current },
        targetCamera,
        startTime: performance.now(),
        durationMs: 300,
      };
      requestRender();
    }
  }, [revealRequest, insets, prefersReducedMotion, requestRender]);

  // Neighbor map for incident highlighting
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

  // Container resize observer
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let prevWidth = container.clientWidth;
    let prevHeight = container.clientHeight;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          if (prevWidth === 0 && prevHeight === 0) {
            prevWidth = width;
            prevHeight = height;
            requestRender();
            continue;
          }
          if (width !== prevWidth || height !== prevHeight) {
            // Adjust pan smoothly so graph centroid remains centered
            const dx = (width - prevWidth) / 2;
            const dy = (height - prevHeight) / 2;
            cameraRef.current.panX += dx;
            cameraRef.current.panY += dy;
            prevWidth = width;
            prevHeight = height;
            requestRender();
          }
        }
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [requestRender]);

  // Main RAF Render Loop
  const renderLoop = useCallback(
    (timestamp: number) => {
      rafIdRef.current = null;

      // Handle active camera animation (cubic ease-out)
      if (cameraAnimRef.current) {
        const anim = cameraAnimRef.current;
        const elapsed = timestamp - anim.startTime;
        const progress = Math.min(1.0, elapsed / anim.durationMs);
        const t = 1 - Math.pow(1 - progress, 3); // ease-out cubic

        cameraRef.current = {
          yaw: anim.startCamera.yaw + (anim.targetCamera.yaw - anim.startCamera.yaw) * t,
          pitch: anim.startCamera.pitch + (anim.targetCamera.pitch - anim.startCamera.pitch) * t,
          panX: anim.startCamera.panX + (anim.targetCamera.panX - anim.startCamera.panX) * t,
          panY: anim.startCamera.panY + (anim.targetCamera.panY - anim.startCamera.panY) * t,
          zoom: anim.startCamera.zoom + (anim.targetCamera.zoom - anim.startCamera.zoom) * t,
        };

        isDirtyRef.current = true;
        if (progress >= 1.0) {
          cameraAnimRef.current = null;
        }
      }

      if (!isDirtyRef.current) {
        return;
      }
      isDirtyRef.current = false;

      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      const width = canvas.clientWidth || 800;
      const height = canvas.clientHeight || 600;

      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
      }

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, width, height);

      const camera = cameraRef.current;

      // 1. Authoritative projection pass
      const projData = projectGraph(snapshot.nodes, positions, centroidRef.current, camera, {
        entryNodeId: snapshot.nodes[0]?.id,
        selectedNodeId,
        hoveredNodeId,
      });
      projectedDataRef.current = projData;

      const activeHighlightId = selectedNodeId || hoveredNodeId;
      const connectedNodes = activeHighlightId
        ? new Set([activeHighlightId, ...(neighborMap.get(activeHighlightId) || [])])
        : null;

      // 2. Draw Edges
      const edgesToDraw = [];
      for (let i = 0; i < snapshot.edges.length; i++) {
        const edge = snapshot.edges[i];
        const p1 = projData.projectedMap.get(edge.source_file_id);
        const p2 = projData.projectedMap.get(edge.target_file_id);
        if (!p1 || !p2) continue;

        const isConnected = Boolean(
          activeHighlightId &&
            (edge.source_file_id === activeHighlightId || edge.target_file_id === activeHighlightId)
        );
        const isEdgeSelected = selectedEdgeId === edge.id;
        const desc = resolveNetworkEdgeVisual(
          edge,
          isConnected || isEdgeSelected,
          activeHighlightId,
          camera.zoom
        );
        if (!desc) continue;

        edgesToDraw.push({ p1, p2, desc, isEdgeSelected });
      }

      edgesToDraw.sort((a, b) => a.desc.priority - b.desc.priority);

      for (let i = 0; i < edgesToDraw.length; i++) {
        const { p1, p2, desc, isEdgeSelected } = edgesToDraw[i];
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(p1.screenX, p1.screenY);
        ctx.lineTo(p2.screenX, p2.screenY);
        ctx.strokeStyle = isEdgeSelected ? '#38bdf8' : desc.color;
        ctx.lineWidth = isEdgeSelected ? Math.max(2.5, 3.2 / camera.zoom) : desc.width;
        ctx.globalAlpha = isEdgeSelected ? 1.0 : desc.alpha;
        if (desc.dash.length > 0) ctx.setLineDash(desc.dash);
        ctx.stroke();

        // Directional arrow pointing source -> target
        if (desc.showArrow || isEdgeSelected) {
          const dx = p2.screenX - p1.screenX;
          const dy = p2.screenY - p1.screenY;
          const len = Math.hypot(dx, dy);
          if (len > 24) {
            const midX = p1.screenX + dx * 0.62;
            const midY = p1.screenY + dy * 0.62;
            const angle = Math.atan2(dy, dx);
            const arrowSize = Math.max(4.0, 5.0 * Math.min(1.2, camera.zoom));

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

      // 3. Draw Nodes (sorted back-to-front by projected.z)
      const sortedNodes = projData.projectedList;
      for (let i = 0; i < sortedNodes.length; i++) {
        const pNode = sortedNodes[i];
        const isSelected = selectedNodeId === pNode.id;
        const isHovered = hoveredNodeId === pNode.id;
        const isDimmed = Boolean(connectedNodes && !connectedNodes.has(pNode.id));

        const screenR = pNode.radius * camera.zoom;
        const depthAlpha = computeDepthAlpha(pNode.projected.depthScale);

        ctx.save();
        ctx.globalAlpha = isDimmed ? 0.2 : depthAlpha;

        // Selection / Hover outer ring
        if (isSelected) {
          ctx.beginPath();
          ctx.arc(pNode.screenX, pNode.screenY, screenR + 4.5, 0, Math.PI * 2);
          ctx.strokeStyle = '#2dd4bf';
          ctx.lineWidth = 2.5;
          ctx.stroke();
        } else if (isHovered) {
          ctx.beginPath();
          ctx.arc(pNode.screenX, pNode.screenY, screenR + 3.5, 0, Math.PI * 2);
          ctx.strokeStyle = '#38bdf8';
          ctx.lineWidth = 2.0;
          ctx.stroke();
        }

        // Node glyph body
        ctx.beginPath();
        ctx.arc(pNode.screenX, pNode.screenY, screenR, 0, Math.PI * 2);
        ctx.fillStyle =
          pNode.id === snapshot.nodes[0]?.id
            ? ENTRY_NODE_COLOR
            : getFileTypeColor(pNode.node.relative_path);
        ctx.fill();

        ctx.strokeStyle = isSelected
          ? '#2dd4bf'
          : isHovered
          ? '#38bdf8'
          : 'rgba(15, 23, 42, 0.85)';
        ctx.lineWidth = isSelected || isHovered ? 1.8 : 1.0;
        ctx.stroke();
        ctx.restore();
      }

      // 4. Draw Node Labels
      const fontSize = Math.max(10, Math.min(14, 11 * Math.sqrt(camera.zoom)));
      ctx.save();
      ctx.font = `500 ${fontSize}px "JetBrains Mono", monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.lineWidth = 3.5;

      for (let i = 0; i < sortedNodes.length; i++) {
        const pNode = sortedNodes[i];
        const isSelected = selectedNodeId === pNode.id;
        const isHovered = hoveredNodeId === pNode.id;
        const isHub =
          pNode.node.direct_dependency_count + pNode.node.direct_dependent_count >= 4;
        const shouldDrawLabel = isSelected || isHovered || camera.zoom > 0.85 || isHub;

        if (!shouldDrawLabel) continue;

        const screenR = pNode.radius * camera.zoom;
        const labelY = pNode.screenY + screenR + 4;
        const text = pNode.node.filename;

        // Halo text background for legibility
        ctx.strokeStyle = 'rgba(10, 14, 23, 0.9)';
        ctx.strokeText(text, pNode.screenX, labelY);

        ctx.fillStyle = isSelected ? '#2dd4bf' : isHovered ? '#38bdf8' : '#e2e8f0';
        ctx.fillText(text, pNode.screenX, labelY);
      }
      ctx.restore();

      ctx.restore();

      // If animation is still running, schedule next frame
      if (cameraAnimRef.current) {
        rafIdRef.current = requestAnimationFrame((t) => {
          renderLoopRef.current(t);
        });
      }
    },
    [snapshot, positions, selectedNodeId, selectedEdgeId, hoveredNodeId, neighborMap]
  );

  renderLoopRef.current = renderLoop;

  // Trigger RAF whenever external dependencies change
  useEffect(() => {
    requestRender();
  }, [snapshot, selectedNodeId, selectedEdgeId, hoveredNodeId, requestRender]);

  // Clean up RAF on unmount
  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, []);

  // Hit testing helpers using authoritative projection
  const findNodeAtPoint = useCallback(
    (clientX: number, clientY: number): FileNode | null => {
      const canvas = canvasRef.current;
      const projData = projectedDataRef.current;
      if (!canvas || !projData) return null;

      const rect = canvas.getBoundingClientRect();
      const screenX = clientX - rect.left;
      const screenY = clientY - rect.top;
      const camera = cameraRef.current;

      return findHitNode(projData.projectedList, screenX, screenY, camera.zoom);
    },
    []
  );

  const findEdgeAtPoint = useCallback(
    (clientX: number, clientY: number): DependencyEdge | null => {
      const canvas = canvasRef.current;
      const projData = projectedDataRef.current;
      if (!canvas || !projData) return null;

      const rect = canvas.getBoundingClientRect();
      const screenX = clientX - rect.left;
      const screenY = clientY - rect.top;

      const hitTolerance = 6;
      let bestEdge: DependencyEdge | null = null;
      let bestDist = Infinity;

      for (let i = 0; i < snapshot.edges.length; i++) {
        const edge = snapshot.edges[i];
        const p1 = projData.projectedMap.get(edge.source_file_id);
        const p2 = projData.projectedMap.get(edge.target_file_id);
        if (!p1 || !p2) continue;

        const dist = pointToSegmentDistance(
          { x: screenX, y: screenY },
          { x: p1.screenX, y: p1.screenY },
          { x: p2.screenX, y: p2.screenY }
        );

        if (dist <= hitTolerance && dist < bestDist) {
          bestDist = dist;
          bestEdge = edge;
        }
      }
      return bestEdge;
    },
    [snapshot.edges]
  );

  function pointToSegmentDistance(
    p: { x: number; y: number },
    a: { x: number; y: number },
    b: { x: number; y: number }
  ): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);

    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
    const projX = a.x + t * dx;
    const projY = a.y + t * dy;
    return Math.hypot(p.x - projX, p.y - projY);
  }

  // Pointer event handlers
  const handlePointerDown = (e: React.PointerEvent) => {
    // Focus canvas on click for keyboard interaction
    canvasRef.current?.focus();

    gestureRef.current = handleGesturePointerDown({
      clientX: e.clientX,
      clientY: e.clientY,
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      shiftKey: e.shiftKey,
      button: e.button,
      currentCamera: cameraRef.current,
    });

    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // ignored
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const gesture = gestureRef.current;
    if (gesture.active && gesture.pointerId === e.pointerId) {
      const { gesture: nextGesture, camera: nextCamera } = handleGesturePointerMove(
        gesture,
        e.clientX,
        e.clientY,
        cameraRef.current
      );
      gestureRef.current = nextGesture;

      if (nextGesture.exceededThreshold) {
        cameraAnimRef.current = null;
        cameraRef.current = nextCamera;
        requestRender();
      }
      return;
    }

    // Hover hit test
    const hitNode = findNodeAtPoint(e.clientX, e.clientY);
    const newHoverId = hitNode?.id || null;
    if (newHoverId !== hoveredNodeId) {
      setHoveredNodeId(newHoverId);
      requestRender();
    }
  };

  const cleanUpPointerGesture = useCallback(
    (e?: React.PointerEvent) => {
      const gesture = gestureRef.current;
      if (e && gesture.pointerId === e.pointerId) {
        try {
          (e.target as HTMLElement).releasePointerCapture(e.pointerId);
        } catch {
          // ignored
        }
      }
      gestureRef.current = resetGestureState(cameraRef.current);
    },
    []
  );

  const handlePointerUp = (e: React.PointerEvent) => {
    const gesture = gestureRef.current;
    const wasDragging = gesture.exceededThreshold;

    cleanUpPointerGesture(e);

    // If click below threshold: perform selection WITHOUT moving the camera
    if (!wasDragging) {
      const hitNode = findNodeAtPoint(e.clientX, e.clientY);
      if (hitNode) {
        onSelectNode(hitNode);
        onSelectEdge(null);
        onAnnounce?.(`Selected file ${hitNode.filename}`);
      } else {
        const hitEdge = findEdgeAtPoint(e.clientX, e.clientY);
        if (hitEdge) {
          onSelectEdge(hitEdge);
          onSelectNode(null);
          onAnnounce?.(`Selected relationship ${hitEdge.relationship_kind}`);
        } else {
          // Click empty background clears selection
          onSelectNode(null);
          onSelectEdge(null);
        }
      }
    }
  };

  const handlePointerCancel = (e: React.PointerEvent) => {
    cleanUpPointerGesture(e);
  };

  const handleLostPointerCapture = () => {
    gestureRef.current = resetGestureState(cameraRef.current);
  };

  // Window blur / visibility change cleanup
  useEffect(() => {
    const handleBlur = () => {
      gestureRef.current = resetGestureState(cameraRef.current);
    };
    window.addEventListener('blur', handleBlur);
    return () => window.removeEventListener('blur', handleBlur);
  }, []);

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const cursorX = e.clientX - rect.left;
    const cursorY = e.clientY - rect.top;

    const normDelta = normalizeWheelZoomDelta({
      deltaY: e.deltaY,
      deltaMode: e.deltaMode,
      ctrlKey: e.ctrlKey,
    });
    const factor = computeContinuousZoomFactor(normDelta);

    cameraAnimRef.current = null;
    cameraRef.current = applyZoomAroundCursor(
      cameraRef.current,
      factor,
      cursorX,
      cursorY,
      MIN_ZOOM,
      MAX_ZOOM
    );
    requestRender();
  };

  // Keyboard accessibility
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onSelectNode(null);
      onSelectEdge(null);
      return;
    }

    const cur = cameraRef.current;
    const shift = e.shiftKey;

    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (shift) cur.panX -= 30;
      else cur.yaw = wrapRotationAngle(cur.yaw + 0.05);
      requestRender();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (shift) cur.panX += 30;
      else cur.yaw = wrapRotationAngle(cur.yaw - 0.05);
      requestRender();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (shift) cur.panY -= 30;
      else cur.pitch = clampPitch(cur.pitch - 0.05);
      requestRender();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (shift) cur.panY += 30;
      else cur.pitch = clampPitch(cur.pitch + 0.05);
      requestRender();
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      const rect = canvasRef.current?.getBoundingClientRect();
      const cx = (rect?.width || 800) / 2;
      const cy = (rect?.height || 600) / 2;
      cameraRef.current = applyZoomAroundCursor(cur, 1.15, cx, cy);
      requestRender();
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      const rect = canvasRef.current?.getBoundingClientRect();
      const cx = (rect?.width || 800) / 2;
      const cy = (rect?.height || 600) / 2;
      cameraRef.current = applyZoomAroundCursor(cur, 1 / 1.15, cx, cy);
      requestRender();
    }
  };

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        cursor: gestureRef.current.active
          ? gestureRef.current.mode === 'panning'
            ? 'move'
            : 'grabbing'
          : hoveredNodeId
          ? 'pointer'
          : 'grab',
      }}
    >
      <canvas
        ref={canvasRef}
        tabIndex={0}
        role="application"
        className="network-canvas"
        aria-label="3D Network Graph dependency orb"
        aria-description="Use arrow keys to rotate, Shift+arrow keys to pan, plus/minus keys to zoom, Escape to clear selection."
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
          touchAction: 'none',
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={handleLostPointerCapture}
        onWheel={handleWheel}
        onKeyDown={handleKeyDown}
      />
    </div>
  );
};
