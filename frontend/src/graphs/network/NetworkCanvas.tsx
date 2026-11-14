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
  DEFAULT_ZOOM,
  ROTATION_SENSITIVITY,
  PAN_SENSITIVITY,
  GESTURE_THRESHOLD_MOUSE,
  GESTURE_THRESHOLD_PEN,
  GESTURE_THRESHOLD_TOUCH,
  wrapRotationAngle,
  clampPitch,
  computeGraphCentroid,
  computeDepthAlpha,
  projectGraph,
  computeNetworkFitTransform,
  isNodeVisibleInViewport,
  applyZoomAroundCursor,
  applyZoomAroundCenter,
  normalizeWheelZoomDelta,
  computeContinuousZoomFactor,
  computeCenterLockedTransform,
  isCenterDeadZone,
  ProjectedGraph,
  ProjectedNode,
  shouldDrawNodeLabel,
  calculateReleaseSpeed,
  shouldInitiateInertia,
  clampLaunchVelocity,
  stepRotationalInertia,
  LabelCollisionGrid,
  computeLabelPriorityScore,
  ScreenRect,
} from './render/networkRenderMath';
import { resolveNetworkEdgeVisual } from './render/networkEdgeVisual';
import { getFileTypeColor, ENTRY_NODE_COLOR } from './fileTypeColors';
import { findEntryPointCandidate } from '../../utils/entryPointDetection';
import { getAreaIdForPath } from '../../utils/repositoryAreas';
import { computeDisambiguatedLabels } from '../../utils/pathDisambiguation';

export interface RevealRequest {
  nodeId: string;
  timestamp: number;
  onlyIfOutside?: boolean;
}

interface NetworkCanvasProps {
  snapshot: GraphSnapshot;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  selectedAreaId?: string | null;
  onSelectNode: (node: FileNode | null) => void;
  onSelectEdge: (edge: DependencyEdge | null) => void;
  revealRequest?: RevealRequest | null;
  fitViewTrigger?: number;
  resetViewTrigger?: number;
  keepGraphCentered?: boolean;
  onToggleCenterLock?: () => void;
  isVisible?: boolean;
  insets?: ViewportInsets;
  onAnnounce?: (message: string) => void;
  theme?: 'dark' | 'light';
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
  selectedAreaId = null,
  onSelectNode,
  onSelectEdge,
  revealRequest,
  fitViewTrigger,
  resetViewTrigger,
  keepGraphCentered = true,
  onToggleCenterLock,
  isVisible = true,
  insets,
  onAnnounce,
  theme = 'dark',
}): React.ReactElement => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [showLegend, setShowLegend] = useState(false);
  const [positions, setPositions] = useState<Map<string, Point3D>>(new Map());
  const positionsRef = useRef<Map<string, Point3D>>(positions);
  positionsRef.current = positions;

  // Pointer capture target reference
  const pointerTargetRef = useRef<HTMLElement | null>(null);

  // Repository initialization tracker (fit ONLY on initial load, preserve on revisions)
  const initializedRepoIdRef = useRef<string | null>(null);

  // Authoritative Camera ref (eliminates React re-render churn during 60fps dragging)
  const cameraRef = useRef<NetworkCamera>({
    yaw: DEFAULT_YAW,
    pitch: DEFAULT_PITCH,
    panX: 400,
    panY: 300,
    zoom: DEFAULT_ZOOM,
  });

  // RAF & Dirty flag scheduler
  const isDirtyRef = useRef<boolean>(true);
  const rafIdRef = useRef<number | null>(null);
  const cameraAnimRef = useRef<CameraAnimation | null>(null);
  const renderLoopRef = useRef<(timestamp: number) => void>(() => { });

  // Damped rotational inertia physics
  const inertiaRafRef = useRef<number | null>(null);
  const velocityRef = useRef<{ vx: number; vy: number }>({ vx: 0, vy: 0 });
  const lastPointerTimeRef = useRef<number>(0);
  const lastPointerPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const [hasInteracted, setHasInteracted] = useState(false);

  const requestRender = useCallback(() => {
    isDirtyRef.current = true;
    if (rafIdRef.current === null) {
      rafIdRef.current = requestAnimationFrame((timestamp) => {
        renderLoopRef.current(timestamp);
      });
    }
  }, []);

  // Cache for projection output
  const projectedDataRef = useRef<ProjectedGraph | null>(null);
  const centroidRef = useRef<Point3D>({ x: 0, y: 0, z: 0 });

  // Pointer gesture tracking
  const gestureRef = useRef<{
    active: boolean;
    mode: 'idle' | 'rotating' | 'panning';
    startX: number;
    startY: number;
    startCamera: NetworkCamera;
    pointerId: number | null;
    pointerType: string;
    exceededThreshold: boolean;
  }>({
    active: false,
    mode: 'idle',
    startX: 0,
    startY: 0,
    startCamera: { ...cameraRef.current },
    pointerId: null,
    pointerType: 'mouse',
    exceededThreshold: false,
  });

  const prefersReducedMotion = useMemo(() => {
    return typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);

  // Expose authoritative debug metrics for Playwright browser verification & runtime inspection
  useEffect(() => {
    if (typeof window !== 'undefined') {
      (window as any).__prebaseNetworkDebug = {
        getCamera: () => ({ ...cameraRef.current }),
        getCentroid: () => ({ ...centroidRef.current }),
        getProjectedNodes: () =>
          projectedDataRef.current?.projectedList?.map((p) => ({
            id: p.id,
            screenX: p.screenX,
            screenY: p.screenY,
            depthScale: p.projected.depthScale,
            z: p.projected.z,
            localPos: p.localPos,
          })) || [],
        isCenterLocked: () => keepGraphCentered,
      };
    }
    return () => {
      if (typeof window !== 'undefined') {
        delete (window as any).__prebaseNetworkDebug;
      }
    };
  }, [keepGraphCentered]);

  // Maintain stable centering from projected bounds during rotation and viewport changes (Prebasecode applyCenterLock parity)
  const applyCenterLock = useCallback(
    (immediate = false) => {
      if (!keepGraphCentered || !containerRef.current) return;
      if (cameraAnimRef.current && !immediate) return;

      const width = containerRef.current.clientWidth || 800;
      const height = containerRef.current.clientHeight || 600;
      const bounds = projectedDataRef.current?.bounds ?? null;

      const target = computeCenterLockedTransform(
        bounds,
        width,
        height,
        cameraRef.current.zoom,
        insets
      );

      if (!isCenterDeadZone(cameraRef.current, target, 0.5)) {
        cameraRef.current.panX = target.panX;
        cameraRef.current.panY = target.panY;
        requestRender();
      }
    },
    [keepGraphCentered, insets, requestRender]
  );

  // When Center Lock is enabled or insets change, re-anchor camera to projected center
  useEffect(() => {
    if (keepGraphCentered) {
      applyCenterLock(true);
    }
  }, [keepGraphCentered, insets, applyCenterLock]);

  // Compute graph layout positions once per snapshot revision
  useEffect(() => {
    if (!snapshot || snapshot.nodes.length === 0) {
      setPositions(new Map());
      positionsRef.current = new Map();
      centroidRef.current = { x: 0, y: 0, z: 0 };
      requestRender();
      return;
    }

    const width = containerRef.current?.clientWidth || 800;
    const height = containerRef.current?.clientHeight || 600;

    const result = processSnapshotRevision(
      {
        repositoryId: initializedRepoIdRef.current,
        positions: positionsRef.current,
        camera: cameraRef.current,
      },
      snapshot,
      { width, height, insets },
      'sphere'
    );

    setPositions(result.state.positions);
    positionsRef.current = result.state.positions;
    centroidRef.current = computeGraphCentroid(result.state.positions.values());
    initializedRepoIdRef.current = result.state.repositoryId;

    if (result.didTriggerInitialFit) {
      cameraRef.current = result.state.camera;
    }

    requestRender();
  }, [snapshot, insets, requestRender]);

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

    const projData = projectedDataRef.current;
    if (!projData) return;
    const projectedNode = projData.projectedMap.get(nodeId);
    if (!projectedNode) return;

    const width = containerRef.current.clientWidth || 800;
    const height = containerRef.current.clientHeight || 600;

    // Check if node is already safely visible on the front hemisphere
    const isVisible =
      projectedNode.projected.z >= -10 &&
      isNodeVisibleInViewport(
        projectedNode.screenX,
        projectedNode.screenY,
        projectedNode.radius,
        width,
        height,
        insets
      );

    if (onlyIfOutside && isVisible) {
      // Node is already comfortably visible: do nothing!
      return;
    }

    const cur = cameraRef.current;
    const localPos = projectedNode.localPos;
    // Orbit to Node: smoothly rotate 3D orb around its stable center until the node faces front
    const sgn = localPos.z >= 0 ? 1 : -1;
    const targetPitch = clampPitch(Math.atan2(sgn * localPos.y, Math.max(1e-4, sgn * localPos.z)));
    const yzHypot = Math.hypot(localPos.y, localPos.z);
    const targetYaw = wrapRotationAngle(Math.atan2(-localPos.x, sgn * Math.max(1e-4, yzHypot)));

    const targetCamera: NetworkCamera = {
      yaw: targetYaw,
      pitch: targetPitch,
      panX: cur.panX,
      panY: cur.panY,
      zoom: cur.zoom,
    };

    if (prefersReducedMotion) {
      cameraRef.current = targetCamera;
      requestRender();
    } else {
      cameraAnimRef.current = {
        startCamera: { ...cur },
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

  // Grounded entry point detection (never defaults arbitrarily to nodes[0])
  const entryCandidate = useMemo(() => {
    return findEntryPointCandidate(snapshot.nodes);
  }, [snapshot.nodes]);

  // Disambiguate duplicate filenames using minimal unique path suffixes
  const disambiguatedLabels = useMemo(() => {
    return computeDisambiguatedLabels(snapshot.nodes);
  }, [snapshot.nodes]);

  // Container resize observer
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let prevWidth = container.clientWidth;
    let prevHeight = container.clientHeight;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0 && (width !== prevWidth || height !== prevHeight)) {
          if (keepGraphCentered) {
            applyCenterLock(true);
          } else {
            const dx = (width - prevWidth) / 2;
            const dy = (height - prevHeight) / 2;
            cameraRef.current.panX += dx;
            cameraRef.current.panY += dy;
            requestRender();
          }
          prevWidth = width;
          prevHeight = height;
        }
      }
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [keepGraphCentered, applyCenterLock, requestRender]);

  // Main RAF Render Loop
  const renderLoop = useCallback(
    (timestamp: number) => {
      rafIdRef.current = null;
      if (!isVisible) return;

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

      try {
        const camera = cameraRef.current;

        // 1. Authoritative projection pass
        const projectOptions = {
          entryNodeId: entryCandidate?.nodeId,
          selectedNodeId,
          hoveredNodeId,
        };
        const projData = projectGraph(
          snapshot.nodes,
          positionsRef.current,
          centroidRef.current,
          camera,
          projectOptions
        );
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
            camera.zoom,
            null,
            theme
          );
          if (!desc) continue;

          // If an architectural area is selected and there is no active node highlight,
          // dim edges that don't connect to or from this area
          let areaAlphaMultiplier = 1.0;
          if (selectedAreaId && !activeHighlightId) {
            const srcArea = getAreaIdForPath(p1.node.relative_path);
            const tgtArea = getAreaIdForPath(p2.node.relative_path);
            if (srcArea !== selectedAreaId && tgtArea !== selectedAreaId) {
              areaAlphaMultiplier = 0.08;
            }
          }

          edgesToDraw.push({ p1, p2, desc, isEdgeSelected, areaAlphaMultiplier });
        }

        edgesToDraw.sort((a, b) => a.desc.priority - b.desc.priority);

        for (let i = 0; i < edgesToDraw.length; i++) {
          const { p1, p2, desc, isEdgeSelected, areaAlphaMultiplier } = edgesToDraw[i];
          ctx.save();
          ctx.beginPath();
          ctx.moveTo(p1.screenX, p1.screenY);
          ctx.lineTo(p2.screenX, p2.screenY);
          ctx.strokeStyle = isEdgeSelected ? '#38bdf8' : desc.color;
          ctx.lineWidth = isEdgeSelected ? Math.max(2.5, 3.2 / camera.zoom) : desc.width;
          ctx.globalAlpha = (isEdgeSelected ? 1.0 : desc.alpha) * areaAlphaMultiplier;
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

          let isDimmed = false;
          if (connectedNodes) {
            isDimmed = !connectedNodes.has(pNode.id);
          } else if (selectedAreaId) {
            isDimmed = getAreaIdForPath(pNode.node.relative_path) !== selectedAreaId;
          }

          const screenR = pNode.radius * camera.zoom;
          const depthAlpha = computeDepthAlpha(pNode.projected.depthScale);

          ctx.save();
          ctx.globalAlpha = isDimmed ? 0.18 : depthAlpha;

          const isLight = theme === 'light';

          // Selection / Hover outer ring
          if (isSelected) {
            ctx.beginPath();
            ctx.arc(pNode.screenX, pNode.screenY, screenR + 6, 0, Math.PI * 2);
            ctx.strokeStyle = isLight ? 'rgba(13, 148, 136, 0.45)' : 'rgba(45, 212, 191, 0.45)';
            ctx.lineWidth = 3.0;
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(pNode.screenX, pNode.screenY, screenR + 3, 0, Math.PI * 2);
            ctx.strokeStyle = isLight ? '#0d9488' : '#2dd4bf';
            ctx.lineWidth = 2.0;
            ctx.stroke();
          } else if (isHovered) {
            ctx.beginPath();
            ctx.arc(pNode.screenX, pNode.screenY, screenR + 3.5, 0, Math.PI * 2);
            ctx.strokeStyle = isLight ? '#0284c7' : '#38bdf8';
            ctx.lineWidth = 2.0;
            ctx.stroke();
          }

          // Node glyph body
          ctx.beginPath();
          ctx.arc(pNode.screenX, pNode.screenY, screenR, 0, Math.PI * 2);
          const isMainEntry = entryCandidate !== null && pNode.id === entryCandidate.nodeId;
          ctx.fillStyle = isMainEntry
            ? ENTRY_NODE_COLOR
            : getFileTypeColor(pNode.node.relative_path);
          ctx.fill();

          ctx.strokeStyle = isSelected
            ? (isLight ? '#0d9488' : '#2dd4bf')
            : isHovered
              ? (isLight ? '#0284c7' : '#38bdf8')
              : (isLight ? 'rgba(255, 255, 255, 0.9)' : 'rgba(15, 23, 42, 0.85)');
          ctx.lineWidth = isSelected || isHovered ? 1.8 : 1.0;
          ctx.stroke();
          ctx.restore();
        }

        // 4. Draw Node Labels (Decoupled Priority Ordering + Screen-Space Spatial Collision Hash)
        const isLight = theme === 'light';
        const fontSize = Math.max(12, Math.min(16, Math.round(12.5 * Math.sqrt(camera.zoom))));
        const monoFont = `${fontSize}px "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`;
        ctx.font = `500 ${monoFont}`;

        interface CandidateLabel {
          pNode: ProjectedNode;
          isSelected: boolean;
          isHovered: boolean;
          priorityScore: number;
          text: string;
          labelY: number;
          rect: ScreenRect;
        }

        const candidateLabels: CandidateLabel[] = [];

        for (let i = 0; i < sortedNodes.length; i++) {
          const pNode = sortedNodes[i];
          const isSelected = selectedNodeId === pNode.id;
          const isHovered = hoveredNodeId === pNode.id;
          const isConnectedToSelected =
            selectedNodeId !== null && (neighborMap.get(selectedNodeId)?.has(pNode.id) ?? false);
          const totalDegree =
            pNode.node.direct_dependency_count + pNode.node.direct_dependent_count;

          const shouldDraw = shouldDrawNodeLabel({
            isSelected,
            isHovered,
            isConnectedToSelected,
            projectedZ: pNode.projected.z,
            totalDegree,
            zoom: camera.zoom,
          });

          if (!shouldDraw) continue;

          // Disambiguate duplicate filenames with minimal unique path suffix
          const text = disambiguatedLabels.get(pNode.id) || pNode.node.filename;
          const screenR = pNode.radius * camera.zoom;
          const textWidth = ctx.measureText(text).width;
          const labelY = pNode.screenY + screenR + 4;
          const rect: ScreenRect = {
            x1: pNode.screenX - textWidth / 2 - 4,
            y1: labelY - 2,
            x2: pNode.screenX + textWidth / 2 + 4,
            y2: labelY + fontSize + 2,
          };

          const isInFocusedArea =
            selectedAreaId !== null && getAreaIdForPath(pNode.node.relative_path) === selectedAreaId;

          const priorityScore = computeLabelPriorityScore({
            isSelected,
            isHovered,
            isConnectedToSelected,
            isInFocusedArea,
            projectedZ: pNode.projected.z,
            depthScale: pNode.projected.depthScale,
            totalDegree,
          });

          candidateLabels.push({
            pNode,
            isSelected,
            isHovered,
            priorityScore,
            text,
            labelY,
            rect,
          });
        }

        // Sort candidates by priority score descending:
        // selected/hovered -> directly connected -> focused area -> visible foreground -> background
        candidateLabels.sort((a, b) => b.priorityScore - a.priorityScore);

        const collisionGrid = new LabelCollisionGrid(80);

        for (let i = 0; i < candidateLabels.length; i++) {
          const cand = candidateLabels[i];
          const isPriority = cand.isSelected || cand.isHovered;

          if (!isPriority) {
            if (collisionGrid.collides(cand.rect)) {
              continue;
            }
          }
          collisionGrid.insert(cand.rect);

          ctx.save();
          ctx.font = isPriority ? `600 ${monoFont}` : `500 ${monoFont}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';

          // Theme-adaptive halo stroke for maximum legibility
          ctx.strokeStyle = isLight ? 'rgba(255, 255, 255, 0.95)' : 'rgba(8, 11, 17, 0.92)';
          ctx.lineWidth = 3.5;
          ctx.strokeText(cand.text, cand.pNode.screenX, cand.labelY);

          ctx.fillStyle = cand.isSelected
            ? (isLight ? '#0d9488' : '#2dd4bf')
            : cand.isHovered
              ? (isLight ? '#0284c7' : '#38bdf8')
              : (isLight ? '#0f172a' : '#f1f5f9');
          ctx.fillText(cand.text, cand.pNode.screenX, cand.labelY);
          ctx.restore();
        }
      } finally {
        ctx.restore();
      }

      // If animation is still running, schedule next frame
      if (cameraAnimRef.current) {
        rafIdRef.current = requestAnimationFrame((ts) => renderLoopRef.current(ts));
      }
    },
    [
      snapshot,
      positions,
      selectedNodeId,
      selectedEdgeId,
      hoveredNodeId,
      selectedAreaId,
      entryCandidate,
      disambiguatedLabels,
      neighborMap,
      isVisible,
      theme,
    ]
  );
  renderLoopRef.current = renderLoop;

  // Trigger RAF whenever external dependencies or visibility change
  useEffect(() => {
    if (isVisible) {
      requestRender();
    } else if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  }, [snapshot, positions, selectedNodeId, selectedEdgeId, hoveredNodeId, selectedAreaId, isVisible, theme, requestRender]);

  // Clean up RAF and inertia on unmount
  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      if (inertiaRafRef.current !== null) {
        cancelAnimationFrame(inertiaRafRef.current);
        inertiaRafRef.current = null;
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

      // Iterate in reverse (frontmost nodes first by depth)
      const list = projData.projectedList;
      for (let i = list.length - 1; i >= 0; i--) {
        const pNode = list[i];
        const screenR = pNode.radius * camera.zoom;
        const hitTargetRadius = Math.max(screenR + 4, 10);
        const dist = Math.hypot(pNode.screenX - screenX, pNode.screenY - screenY);

        if (dist <= hitTargetRadius) {
          return pNode.node;
        }
      }
      return null;
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

    // Cancel any running camera animation or rotational inertia immediately
    cameraAnimRef.current = null;
    if (inertiaRafRef.current !== null) {
      cancelAnimationFrame(inertiaRafRef.current);
      inertiaRafRef.current = null;
    }

    lastPointerTimeRef.current = performance.now();
    lastPointerPosRef.current = { x: e.clientX, y: e.clientY };
    velocityRef.current = { vx: 0, vy: 0 };

    // Distinguish primary drag (rotation) from Shift-drag or middle button (pan)
    const isShiftOrMiddle = e.shiftKey || e.button === 1 || e.button === 2;
    const mode = isShiftOrMiddle ? 'panning' : 'rotating';
    if (canvasRef.current) {
      canvasRef.current.style.cursor = isShiftOrMiddle ? 'move' : 'grabbing';
    }

    gestureRef.current = {
      active: true,
      mode,
      startX: e.clientX,
      startY: e.clientY,
      startCamera: { ...cameraRef.current },
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      exceededThreshold: false,
    };

    const target = e.target as HTMLElement;
    pointerTargetRef.current = target;
    try {
      target.setPointerCapture(e.pointerId);
    } catch {
      // ignored
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const gesture = gestureRef.current;
    if (gesture.active && gesture.pointerId === e.pointerId) {
      const dx = e.clientX - gesture.startX;
      const dy = e.clientY - gesture.startY;

      const threshold =
        gesture.pointerType === 'touch'
          ? GESTURE_THRESHOLD_TOUCH
          : gesture.pointerType === 'pen'
            ? GESTURE_THRESHOLD_PEN
            : GESTURE_THRESHOLD_MOUSE;

      if (!gesture.exceededThreshold && Math.hypot(dx, dy) > threshold) {
        gesture.exceededThreshold = true;
        if (!hasInteracted) setHasInteracted(true);
      }

      if (gesture.exceededThreshold) {
        // Cancel any running camera animation
        cameraAnimRef.current = null;

        // Track pointer velocity for gentle, natural release inertia
        const now = performance.now();
        const dt = now - lastPointerTimeRef.current;
        if (dt > 0 && dt < 120) {
          velocityRef.current = {
            vx: (e.clientX - lastPointerPosRef.current.x) / dt,
            vy: (e.clientY - lastPointerPosRef.current.y) / dt,
          };
        }
        lastPointerTimeRef.current = now;
        lastPointerPosRef.current = { x: e.clientX, y: e.clientY };

        if (gesture.mode === 'rotating') {
          // Natural rotation: drag right rotates yaw negatively, drag down rotates pitch positively
          const newYaw = wrapRotationAngle(gesture.startCamera.yaw - dx * ROTATION_SENSITIVITY);
          const newPitch = clampPitch(gesture.startCamera.pitch + dy * ROTATION_SENSITIVITY);
          cameraRef.current.yaw = newYaw;
          cameraRef.current.pitch = newPitch;
          if (keepGraphCentered) {
            applyCenterLock(true);
          }
          requestRender();
        } else if (gesture.mode === 'panning') {
          if (keepGraphCentered) {
            onToggleCenterLock?.();
            onAnnounce?.('Center lock unlocked (free pan)');
          }
          cameraRef.current.panX = gesture.startCamera.panX + dx * PAN_SENSITIVITY;
          cameraRef.current.panY = gesture.startCamera.panY + dy * PAN_SENSITIVITY;
          requestRender();
        }
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
      const target = (e?.target as HTMLElement) || pointerTargetRef.current;
      if (target && gesture.pointerId !== null) {
        try {
          if (target.hasPointerCapture(gesture.pointerId)) {
            target.releasePointerCapture(gesture.pointerId);
          }
        } catch {
          // ignored
        }
      }
      pointerTargetRef.current = null;
      gesture.active = false;
      gesture.pointerId = null;
      gesture.mode = 'idle';
      if (canvasRef.current) {
        canvasRef.current.style.cursor = '';
      }
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
    } else if (gesture.mode === 'rotating') {
      // Natural interruptible rotational inertia upon release
      const now = performance.now();
      const timeSinceLastMove = now - lastPointerTimeRef.current;
      const speed = calculateReleaseSpeed(velocityRef.current.vx, velocityRef.current.vy, timeSinceLastMove);

      if (shouldInitiateInertia(speed, prefersReducedMotion)) {
        let { vx, vy } = clampLaunchVelocity(velocityRef.current);
        let lastT = performance.now();

        const coast = (t: number) => {
          const delta = Math.min(32, t - lastT);
          lastT = t;

          const step = stepRotationalInertia({
            vx,
            vy,
            camera: cameraRef.current,
            deltaMs: delta,
          });

          vx = step.vx;
          vy = step.vy;
          cameraRef.current = step.camera;

          if (step.isDone) {
            inertiaRafRef.current = null;
            return;
          }

          if (keepGraphCentered) {
            applyCenterLock(true);
          }
          requestRender();

          inertiaRafRef.current = requestAnimationFrame(coast);
        };

        if (inertiaRafRef.current !== null) {
          cancelAnimationFrame(inertiaRafRef.current);
        }
        inertiaRafRef.current = requestAnimationFrame(coast);
      }
    }
  };

  const handlePointerCancel = (e: React.PointerEvent) => {
    cleanUpPointerGesture(e);
  };

  const handleLostPointerCapture = () => {
    cleanUpPointerGesture();
  };

  // Window blur / visibility change cleanup
  useEffect(() => {
    const handleBlur = () => {
      cleanUpPointerGesture();
    };
    window.addEventListener('blur', handleBlur);
    return () => window.removeEventListener('blur', handleBlur);
  }, [cleanUpPointerGesture]);

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (inertiaRafRef.current !== null) {
      cancelAnimationFrame(inertiaRafRef.current);
      inertiaRafRef.current = null;
    }
    if (!hasInteracted) setHasInteracted(true);

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
    if (keepGraphCentered) {
      cameraRef.current = applyZoomAroundCenter(
        cameraRef.current,
        factor,
        rect.width,
        rect.height,
        insets,
        MIN_ZOOM,
        MAX_ZOOM
      );
    } else {
      cameraRef.current = applyZoomAroundCursor(
        cameraRef.current,
        factor,
        cursorX,
        cursorY,
        MIN_ZOOM,
        MAX_ZOOM
      );
    }
    requestRender();
  };

  // Keyboard accessibility
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (inertiaRafRef.current !== null) {
      cancelAnimationFrame(inertiaRafRef.current);
      inertiaRafRef.current = null;
    }

    if (e.key === 'Escape') {
      onSelectNode(null);
      onSelectEdge(null);
      return;
    }

    const cur = cameraRef.current;
    const shift = e.shiftKey;

    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (!hasInteracted) setHasInteracted(true);
      if (shift) {
        if (keepGraphCentered) {
          onToggleCenterLock?.();
          onAnnounce?.('Center lock unlocked (free pan)');
        }
        cur.panX -= 30;
      } else {
        cur.yaw = wrapRotationAngle(cur.yaw + 0.05);
        if (keepGraphCentered) {
          applyCenterLock(true);
        }
      }
      requestRender();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (!hasInteracted) setHasInteracted(true);
      if (shift) {
        if (keepGraphCentered) {
          onToggleCenterLock?.();
          onAnnounce?.('Center lock unlocked (free pan)');
        }
        cur.panX += 30;
      } else {
        cur.yaw = wrapRotationAngle(cur.yaw - 0.05);
        if (keepGraphCentered) {
          applyCenterLock(true);
        }
      }
      requestRender();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!hasInteracted) setHasInteracted(true);
      if (shift) {
        if (keepGraphCentered) {
          onToggleCenterLock?.();
          onAnnounce?.('Center lock unlocked (free pan)');
        }
        cur.panY -= 30;
      } else {
        cur.pitch = clampPitch(cur.pitch - 0.05);
        if (keepGraphCentered) {
          applyCenterLock(true);
        }
      }
      requestRender();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!hasInteracted) setHasInteracted(true);
      if (shift) {
        if (keepGraphCentered) {
          onToggleCenterLock?.();
          onAnnounce?.('Center lock unlocked (free pan)');
        }
        cur.panY += 30;
      } else {
        cur.pitch = clampPitch(cur.pitch + 0.05);
        if (keepGraphCentered) {
          applyCenterLock(true);
        }
      }
      requestRender();
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      if (!hasInteracted) setHasInteracted(true);
      const rect = canvasRef.current?.getBoundingClientRect();
      const w = rect?.width || 800;
      const h = rect?.height || 600;
      if (keepGraphCentered) {
        cameraRef.current = applyZoomAroundCenter(cur, 1.15, w, h, insets);
      } else {
        cameraRef.current = applyZoomAroundCursor(cur, 1.15, w / 2, h / 2);
      }
      requestRender();
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      if (!hasInteracted) setHasInteracted(true);
      const rect = canvasRef.current?.getBoundingClientRect();
      const w = rect?.width || 800;
      const h = rect?.height || 600;
      if (keepGraphCentered) {
        cameraRef.current = applyZoomAroundCenter(cur, 1 / 1.15, w, h, insets);
      } else {
        cameraRef.current = applyZoomAroundCursor(cur, 1 / 1.15, w / 2, h / 2);
      }
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

      {/* Floating Beginner Legend & Guide Toggle Button */}
      <button
        type="button"
        className={`graph-legend-toggle-btn ${showLegend ? 'active' : ''}`}
        onClick={() => setShowLegend((prev) => !prev)}
        aria-expanded={showLegend}
        aria-label="Toggle Codebase Orb Guide and Legend"
        title="Toggle Codebase Orb Guide and Legend"
      >
        <span className="legend-icon" aria-hidden="true">💡</span>
        <span>Graph Guide</span>
      </button>

      {/* Dismissible Graph Legend Card */}
      {showLegend && (
        <div
          className="graph-legend-card"
          role="region"
          aria-label="Network Graph Legend and Architectural Guide"
        >
          <div className="graph-legend-header">
            <h4>Codebase Orb Guide</h4>
            <button
              type="button"
              className="graph-legend-close"
              onClick={() => setShowLegend(false)}
              aria-label="Close guide"
            >
              ×
            </button>
          </div>
          <p className="legend-desc">
            Files in the same directory cluster in the same spherical sector. Connected lines represent code imports.
          </p>
          <div className="legend-section">
            <span className="legend-label">File Colors</span>
            <div className="legend-row">
              <span className="legend-swatch" style={{ background: '#38bdf8' }} />
              <span>TypeScript / JavaScript</span>
            </div>
            <div className="legend-row">
              <span className="legend-swatch" style={{ background: '#f97316' }} />
              <span>Rust / Systems</span>
            </div>
            <div className="legend-row">
              <span className="legend-swatch" style={{ background: '#a855f7' }} />
              <span>Styles & CSS</span>
            </div>
            <div className="legend-row">
              <span className="legend-swatch" style={{ background: '#eab308' }} />
              <span>Config & Data</span>
            </div>
            {entryCandidate && (
              <div className="legend-row">
                <span className="legend-swatch" style={{ background: ENTRY_NODE_COLOR }} />
                <span>Primary Entry Candidate</span>
              </div>
            )}
          </div>
          <div className="legend-section">
            <span className="legend-label">Connections</span>
            <div className="legend-row">
              <span className="legend-line solid" />
              <span>Solid: Direct static import (arrow points to imported file)</span>
            </div>
            <div className="legend-row">
              <span className="legend-line dashed" />
              <span>Dashed: Dynamic or type-only dependency</span>
            </div>
          </div>
          <div className="legend-section">
            <span className="legend-label">Controls</span>
            <div className="legend-keys">
              <span><strong>Drag:</strong> Rotate orb</span>
              <span><strong>Shift+drag:</strong> Pan</span>
              <span><strong>Scroll:</strong> Zoom in/out</span>
              <span><strong>Click file:</strong> Inspect relations</span>
            </div>
          </div>
        </div>
      )}

      <div
        className={`interaction-hint-badge ${hasInteracted ? 'hidden' : ''}`}
        aria-hidden="true"
      >
        <div className="hint-dot" />
        <span>Drag to rotate</span>
        <span style={{ opacity: 0.35 }}>•</span>
        <span>Shift+drag to pan</span>
        <span style={{ opacity: 0.35 }}>•</span>
        <span>Scroll to zoom</span>
      </div>
    </div>
  );
};
