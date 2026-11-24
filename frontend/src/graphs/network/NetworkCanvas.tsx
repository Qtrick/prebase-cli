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
  DEFAULT_ORIENTATION,
  MIN_ZOOM,
  MAX_ZOOM,
  DEFAULT_ZOOM,
  PAN_SENSITIVITY,
  GESTURE_THRESHOLD_MOUSE,
  GESTURE_THRESHOLD_PEN,
  GESTURE_THRESHOLD_TOUCH,
  projectGraph,
  projectPoint3D,
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
  ProjectedPoint,
  CameraDepthShading,
  NETWORK_FOCAL_LENGTH,
  shouldDrawNodeLabel,
  calculateReleaseSpeed,
  shouldInitiateInertia,
  clampLaunchVelocity,
  stepRotationalInertia,
  rotateOrientationByScreenDelta,
  quaternionToEuler,
  eulerToQuaternion,
  quaternionSlerp,
  computeQuaternionToFacePoint,
  ensureCameraOrientation,
  LabelCollisionGrid,
  computeLabelPriorityScore,
  ScreenRect,
  computeCameraDepthShading,
  computeEdgeDepthAttenuation,
  resolveNodeVisualDescriptor,
} from './render/networkRenderMath';
import { resolveNetworkEdgeVisual, resolveAreaEdgeVisual } from './render/networkEdgeVisual';
import { getAreaColor, ENTRY_NODE_COLOR } from './fileTypeColors';
import { findEntryPointCandidate } from '../../utils/entryPointDetection';
import {
  deriveRepositoryStructure,
  getAreaIdForPath,
  AreaEdge,
  RepositoryArea,
} from '../../utils/repositoryAreas';
import { computeAreaAnchors } from './layout/sphereLayout';
import { computeAreaMonograms } from '../../utils/monogramDisambiguation';
import { fitTextEnd, fitTextMiddle } from '../../utils/textFitting';
import {
  resolveAreaLabelPlacement,
  LabelPlacementAnchor,
} from './layout/labelPlacement';
import {
  computeLabelTargetOpacity,
  stepLabelFade,
  AreaFadeState,
} from './layout/labelFade';
import {
  AreaMotionState,
  SynchronizedMotionTimeline,
  computeAnchorRelativeOffset,
  registerLabelMotionTarget,
  stepSynchronizedMotion,
  computeRenderedLabelRect,
  DEFAULT_MOTION_DURATION_MS,
} from './layout/labelMotion';
import { computeDisambiguatedLabels } from '../../utils/pathDisambiguation';
import { matchesLanguageFilter } from '../../utils/languageFilter';
import {
  createHoverHysteresisController,
  HoverHysteresisController,
  HOVER_RELEASE_GRACE_PERIOD_MS,
} from './hoverHysteresis';
import { X, Lightbulb } from 'lucide-react';

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
  selectedAreaIds?: string[] | null;
  onSelectArea?: (areaId: string | null) => void;
  selectedAreaEdge?: AreaEdge | null;
  onSelectAreaEdge?: (edge: AreaEdge | null) => void;
  languageFilter?: 'all' | 'typescript' | 'rust' | 'python';
  sourceOnlyFilter?: boolean;
  highlightedNodeIds?: Set<string> | null;
  highlightedEdgeIds?: Set<string> | null;
  onSelectNode: (node: FileNode | null) => void;
  onSelectEdge: (edge: DependencyEdge | null) => void;
  revealRequest?: RevealRequest | null;
  fitViewTrigger?: number;
  resetViewTrigger?: number;
  zoomInTrigger?: number;
  zoomOutTrigger?: number;
  keepGraphCentered?: boolean;
  onToggleCenterLock?: () => void;
  isVisible?: boolean;
  insets?: ViewportInsets;
  onAnnounce?: (message: string) => void;
  theme?: 'dark' | 'light';
  hideInternalBreadcrumb?: boolean;
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
  selectedAreaIds = null,
  onSelectArea,
  selectedAreaEdge = null,
  onSelectAreaEdge,
  languageFilter = 'all',
  sourceOnlyFilter = false,
  highlightedNodeIds = null,
  highlightedEdgeIds = null,
  onSelectNode,
  onSelectEdge,
  revealRequest,
  fitViewTrigger,
  resetViewTrigger,
  zoomInTrigger,
  zoomOutTrigger,
  keepGraphCentered = true,
  onToggleCenterLock,
  isVisible = true,
  insets,
  onAnnounce,
  theme = 'dark',
  hideInternalBreadcrumb = false,
}): React.ReactElement => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [hoveredAreaId, setHoveredAreaId] = useState<string | null>(null);
  const [hoveredAreaEdgeId, setHoveredAreaEdgeId] = useState<string | null>(null);
  const [showLegend, setShowLegend] = useState(false);
  const [positions, setPositions] = useState<Map<string, Point3D>>(new Map());
  const positionsRef = useRef<Map<string, Point3D>>(positions);
  positionsRef.current = positions;

  // Effective set of selected areas (supporting single or multi-area selection)
  const effectiveAreaSet = useMemo(() => {
    if (selectedAreaIds && selectedAreaIds.length > 0) {
      return new Set(selectedAreaIds);
    }
    if (selectedAreaId) {
      return new Set([selectedAreaId]);
    }
    return null;
  }, [selectedAreaIds, selectedAreaId]);

  // Pointer capture target reference
  const pointerTargetRef = useRef<HTMLElement | null>(null);

  // Repository initialization tracker (fit ONLY on initial load, preserve on revisions)
  const initializedRepoIdRef = useRef<string | null>(null);

  // Authoritative Camera ref (eliminates React re-render churn during 60fps dragging)
  const cameraRef = useRef<NetworkCamera>({
    orientation: DEFAULT_ORIENTATION,
    yaw: DEFAULT_YAW,
    pitch: DEFAULT_PITCH,
    panX: 400,
    panY: 300,
    zoom: DEFAULT_ZOOM,
  });
  const selectedNodeIdRef = useRef<string | null>(selectedNodeId);
  selectedNodeIdRef.current = selectedNodeId;

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

  // Hover hysteresis controller to eliminate visual hover strobing on fast cursor traversal
  const hoverControllerRef = useRef<HoverHysteresisController | null>(null);
  useEffect(() => {
    const ctrl = createHoverHysteresisController({
      thresholdMs: 100,
      gracePeriodMs: HOVER_RELEASE_GRACE_PERIOD_MS,
      onCommitHover: (id) => {
        setHoveredNodeId(id);
        requestRender();
      },
    });
    hoverControllerRef.current = ctrl;
    return () => {
      ctrl.dispose();
      hoverControllerRef.current = null;
    };
  }, [requestRender]);

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

  // Stable camera-independent normalization radius for 3D depth perception
  const sphereRadius = useMemo(() => {
    let maxR = 140;
    const c = centroidRef.current;
    for (const p of positions.values()) {
      const d = Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z);
      if (d > maxR) maxR = d;
    }
    return maxR;
  }, [positions]);

  // Hierarchical Repository Architecture & Spherical Area Anchors
  const repoStructure = useMemo(() => {
    return deriveRepositoryStructure(snapshot.nodes, snapshot.edges);
  }, [snapshot.nodes, snapshot.edges]);

  const areaAnchors = useMemo(() => {
    const areaIds = repoStructure.areas.map((a) => a.id);
    return computeAreaAnchors(areaIds, sphereRadius);
  }, [repoStructure.areas, sphereRadius]);

  const areaMonograms = useMemo(() => {
    return computeAreaMonograms(repoStructure.areas);
  }, [repoStructure.areas]);

  const isSmallRepo = snapshot.nodes.length <= 12 || repoStructure.areas.length <= 1;

  const scope: 'overview' | 'area' | 'file' = selectedNodeId
    ? 'file'
    : selectedAreaId
      ? 'area'
      : 'overview';

  interface ProjectedAreaAnchor {
    area: RepositoryArea;
    anchor: Point3D;
    proj: ProjectedPoint;
    screenX: number;
    screenY: number;
    radius: number;
    isFront: boolean;
    depthShading: CameraDepthShading;
  }
  const projectedAreaAnchorsRef = useRef<Map<string, ProjectedAreaAnchor>>(new Map());

  interface RenderedAreaLabel {
    areaId: string;
    name: string;
    rect: ScreenRect;
    placement: string;
    opacity: number;
  }
  const renderedAreaLabelsRef = useRef<Map<string, RenderedAreaLabel>>(new Map());
  const previouslyRenderedAreaIdsRef = useRef<Set<string>>(new Set());
  const labelFadeStatesRef = useRef<Map<string, AreaFadeState>>(new Map());
  const labelMotionStatesRef = useRef<Map<string, AreaMotionState>>(new Map());
  const motionTimelineRef = useRef<SynchronizedMotionTimeline>({
    startTime: 0,
    durationMs: 220,
    activeAreaIds: new Set<string>(),
  });

  const renderedEdgesRef = useRef<{
    fileEdges: { edge: DependencyEdge; p1: { screenX: number; screenY: number }; p2: { screenX: number; screenY: number } }[];
    areaEdges: { edge: AreaEdge; p1: { screenX: number; screenY: number }; p2: { screenX: number; screenY: number } }[];
  }>({ fileEdges: [], areaEdges: [] });

  // Expose authoritative debug metrics for Playwright browser verification & runtime inspection
  useEffect(() => {
    if (typeof window !== 'undefined') {
      (window as any).__prebaseNetworkDebug = {
        getCamera: () => ({ ...cameraRef.current }),
        getCentroid: () => ({ ...centroidRef.current }),
        getSphereRadius: () => sphereRadius,
        getHoveredNodeId: () => hoverControllerRef.current?.getCommittedHoverNodeId() ?? null,
        getSelectedNodeId: () => selectedNodeIdRef.current,
        getScope: () => scope,
        getSelectedAreaId: () => selectedAreaId,
        getSelectedAreaEdge: () => selectedAreaEdge,
        getAreaCount: () => repoStructure.areas.length,
        getProjectedAreaAnchors: () =>
          Array.from(projectedAreaAnchorsRef.current.values()).map((a) => ({
            areaId: a.area.id,
            name: a.area.name,
            fileCount: a.area.fileCount,
            screenX: a.screenX,
            screenY: a.screenY,
            radius: a.radius,
            isFront: a.isFront,
            z: a.proj.z,
          })),
        getRenderedAreaLabels: () => Array.from(renderedAreaLabelsRef.current.values()),
        getFadeStates: () =>
          Array.from(labelFadeStatesRef.current.entries()).map(([k, v]) => ({
            id: k,
            ...v,
          })),
        getMotionStates: () =>
          Array.from(labelMotionStatesRef.current.entries()).map(([k, v]) => ({
            areaId: k,
            currentOffset: { ...v.currentOffset },
            startOffset: { ...v.startOffset },
            targetOffset: { ...v.targetOffset },
            candidateIndex: v.candidateIndex,
            isRelocating: !!v.isRelocating,
          })),
        getMotionTimeline: () => ({
          startTime: motionTimelineRef.current.startTime,
          durationMs: motionTimelineRef.current.durationMs,
          activeCount: motionTimelineRef.current.activeAreaIds.size,
          activeAreaIds: Array.from(motionTimelineRef.current.activeAreaIds),
        }),
        getRenderedEdgesCount: () => ({
          fileEdges: renderedEdgesRef.current.fileEdges.length,
          areaEdges: renderedEdgesRef.current.areaEdges.length,
        }),
        setCamera: (updates: Partial<NetworkCamera>) => {
          const next = { ...cameraRef.current, ...updates };
          if ((updates.yaw !== undefined || updates.pitch !== undefined) && !updates.orientation) {
            next.orientation = eulerToQuaternion(next.yaw, next.pitch);
          }
          cameraRef.current = next;
          requestRender();
        },
        getProjectedNodes: () =>
          projectedDataRef.current?.projectedList?.map((p) => {
            const depthShading = computeCameraDepthShading(p.projected.z, sphereRadius, theme);
            return {
              id: p.id,
              screenX: p.screenX,
              screenY: p.screenY,
              depthScale: p.projected.depthScale,
              z: p.projected.z,
              depth: depthShading.depth,
              shading: depthShading.shading,
              prominence: depthShading.prominence,
              localPos: p.localPos,
            };
          }) || [],
        isCenterLocked: () => keepGraphCentered,
      };
    }
    return () => {
      if (typeof window !== 'undefined') {
        delete (window as any).__prebaseNetworkDebug;
      }
    };
  }, [keepGraphCentered, sphereRadius, theme, scope, selectedAreaId, selectedAreaEdge, repoStructure]);

  // Reconcile label fade and motion states when repository structure or scope updates
  useEffect(() => {
    const validAreaIds = new Set(repoStructure.areas.map((a) => a.id));
    for (const id of labelFadeStatesRef.current.keys()) {
      if (!validAreaIds.has(id)) {
        labelFadeStatesRef.current.delete(id);
      }
    }
    for (const id of labelMotionStatesRef.current.keys()) {
      if (!validAreaIds.has(id)) {
        labelMotionStatesRef.current.delete(id);
        motionTimelineRef.current.activeAreaIds.delete(id);
      }
    }
    if (scope !== 'overview') {
      renderedAreaLabelsRef.current.clear();
      motionTimelineRef.current.activeAreaIds.clear();
      previouslyRenderedAreaIdsRef.current.clear();
    }
  }, [repoStructure, scope]);
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
        insets,
        true
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
    centroidRef.current = { x: 0, y: 0, z: 0 };
    initializedRepoIdRef.current = result.state.repositoryId;

    if (result.didTriggerInitialFit) {
      cameraRef.current = result.state.camera;
    }

    requestRender();
  }, [snapshot, insets, requestRender]);

  // Handle external Fit View trigger (preserves current yaw and pitch!)
  useEffect(() => {
    if (fitViewTrigger && fitViewTrigger > 0 && containerRef.current && positions.size > 0) {
      if (inertiaRafRef.current !== null) {
        cancelAnimationFrame(inertiaRafRef.current);
        inertiaRafRef.current = null;
      }
      const width = containerRef.current.clientWidth || 800;
      const height = containerRef.current.clientHeight || 600;

      // Single authoritative projection at current yaw & pitch with area anchors included
      const currentCam = cameraRef.current;
      const proj = projectGraph(snapshot.nodes, positions, centroidRef.current, currentCam, {
        extraPoints: areaAnchors.values(),
        extraRadius: 36,
      });
      const fit = computeNetworkFitTransform(proj.bounds, width, height, insets, 32, true, 1.55);

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
  }, [fitViewTrigger, snapshot, positions, insets, areaAnchors, prefersReducedMotion, onAnnounce, requestRender]);

  // Handle external Reset View trigger (restores standard yaw & pitch, and fits to viewport)
  useEffect(() => {
    if (resetViewTrigger && resetViewTrigger > 0 && containerRef.current && positions.size > 0) {
      if (inertiaRafRef.current !== null) {
        cancelAnimationFrame(inertiaRafRef.current);
        inertiaRafRef.current = null;
      }
      const width = containerRef.current.clientWidth || 800;
      const height = containerRef.current.clientHeight || 600;

      const resetCam: NetworkCamera = {
        orientation: DEFAULT_ORIENTATION,
        yaw: DEFAULT_YAW,
        pitch: DEFAULT_PITCH,
        panX: width / 2,
        panY: height / 2,
        zoom: 1.0,
      };

      const proj = projectGraph(snapshot.nodes, positions, centroidRef.current, resetCam, {
        extraPoints: areaAnchors.values(),
        extraRadius: 36,
      });
      const fit = computeNetworkFitTransform(proj.bounds, width, height, insets, 32, true, 1.55);

      const targetCamera: NetworkCamera = {
        orientation: DEFAULT_ORIENTATION,
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
  }, [resetViewTrigger, snapshot, positions, insets, areaAnchors, prefersReducedMotion, onAnnounce, requestRender]);

  // Handle external Zoom In trigger
  useEffect(() => {
    if (zoomInTrigger && zoomInTrigger > 0 && containerRef.current) {
      const width = containerRef.current.clientWidth || 800;
      const height = containerRef.current.clientHeight || 600;
      cameraAnimRef.current = null;
      if (inertiaRafRef.current !== null) {
        cancelAnimationFrame(inertiaRafRef.current);
        inertiaRafRef.current = null;
      }
      cameraRef.current = applyZoomAroundCenter(
        cameraRef.current,
        1.25,
        width,
        height,
        insets,
        MIN_ZOOM,
        MAX_ZOOM
      );
      requestRender();
      onAnnounce?.('Zoomed in');
    }
  }, [zoomInTrigger, insets, onAnnounce, requestRender]);

  // Handle external Zoom Out trigger
  useEffect(() => {
    if (zoomOutTrigger && zoomOutTrigger > 0 && containerRef.current) {
      const width = containerRef.current.clientWidth || 800;
      const height = containerRef.current.clientHeight || 600;
      cameraAnimRef.current = null;
      if (inertiaRafRef.current !== null) {
        cancelAnimationFrame(inertiaRafRef.current);
        inertiaRafRef.current = null;
      }
      cameraRef.current = applyZoomAroundCenter(
        cameraRef.current,
        0.8,
        width,
        height,
        insets,
        MIN_ZOOM,
        MAX_ZOOM
      );
      requestRender();
      onAnnounce?.('Zoomed out');
    }
  }, [zoomOutTrigger, insets, onAnnounce, requestRender]);

  // Handle explicit Reveal / Focus request (visibility-aware; preserves yaw & pitch)
  useEffect(() => {
    if (!revealRequest || !containerRef.current) return;
    if (inertiaRafRef.current !== null) {
      cancelAnimationFrame(inertiaRafRef.current);
      inertiaRafRef.current = null;
    }
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

    const cur = ensureCameraOrientation(cameraRef.current);
    const localPos = projectedNode.localPos;
    // Orbit to Node: smoothly rotate 3D orb around its stable center until the node faces front
    const targetOrientation = computeQuaternionToFacePoint(localPos);
    const { yaw: targetYaw, pitch: targetPitch } = quaternionToEuler(targetOrientation);

    const targetCamera: NetworkCamera = {
      orientation: targetOrientation,
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

        const startCam = ensureCameraOrientation(anim.startCamera);
        const targetCam = ensureCameraOrientation(anim.targetCamera);
        const orientation = quaternionSlerp(startCam.orientation!, targetCam.orientation!, t);
        const { yaw, pitch } = quaternionToEuler(orientation);

        cameraRef.current = {
          orientation,
          yaw,
          pitch,
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

      let isAnyLabelTransitionActive = false;
      let isAnyMotionActive = false;

      try {
        const camera = cameraRef.current;
        const isLight = theme === 'light';

        // 1. Authoritative projection pass
        const projectOptions = {
          entryNodeId: entryCandidate?.nodeId,
          selectedNodeId,
          hoveredNodeId,
          extraPoints: areaAnchors.values(),
          extraRadius: 36,
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

        // Reset rendered edge registries for this frame
        renderedEdgesRef.current = { fileEdges: [], areaEdges: [] };

        // 1. Project Area Anchors
        const areaAnchorsMap = new Map<string, ProjectedAreaAnchor>();
        for (let i = 0; i < repoStructure.areas.length; i++) {
          const area = repoStructure.areas[i];
          const anchor = areaAnchors.get(area.id);
          if (!anchor) continue;

          const proj = camera.orientation
            ? projectPoint3D(anchor.x, anchor.y, anchor.z, camera.orientation, NETWORK_FOCAL_LENGTH)
            : projectPoint3D(anchor.x, anchor.y, anchor.z, camera.yaw, camera.pitch, NETWORK_FOCAL_LENGTH);

          const screenX = camera.panX + proj.x * camera.zoom;
          const screenY = camera.panY + proj.y * camera.zoom;
          const radius = Math.max(12, Math.min(22, 16 * proj.depthScale * Math.sqrt(Math.min(1.4, camera.zoom))));
          const depthShading = computeCameraDepthShading(proj.z, sphereRadius, theme);
          const isFront = proj.z <= 15;

          areaAnchorsMap.set(area.id, {
            area,
            anchor,
            proj,
            screenX,
            screenY,
            radius,
            isFront,
            depthShading,
          });
        }
        projectedAreaAnchorsRef.current = areaAnchorsMap;

        // 2. Draw Edges based on scope
        if (scope === 'overview' && !isSmallRepo) {
          // OVERVIEW SCOPE: Draw aggregated area edges between area anchors!
          for (let i = 0; i < repoStructure.areaEdges.length; i++) {
            const aEdge = repoStructure.areaEdges[i];
            const p1 = areaAnchorsMap.get(aEdge.sourceAreaId);
            const p2 = areaAnchorsMap.get(aEdge.targetAreaId);
            if (!p1 || !p2) continue;

            const isSelected = selectedAreaEdge?.id === aEdge.id;
            const isHovered = hoveredAreaEdgeId === aEdge.id;
            const desc = resolveAreaEdgeVisual(aEdge, isSelected, isHovered, camera.zoom, theme);

            // Camera depth attenuation
            const edgeProminence = computeEdgeDepthAttenuation(p1.proj.z, p2.proj.z, sphereRadius);
            const alphaMultiplier = isSelected ? 1.0 : (0.45 + 0.55 * edgeProminence);

            ctx.save();
            ctx.beginPath();
            ctx.moveTo(p1.screenX, p1.screenY);
            ctx.lineTo(p2.screenX, p2.screenY);
            ctx.strokeStyle = desc.color;
            ctx.lineWidth = desc.width;
            ctx.globalAlpha = desc.alpha * alphaMultiplier;
            if (desc.dash.length > 0) ctx.setLineDash(desc.dash);
            ctx.stroke();

            // Directional arrow on area edge
            if (desc.showArrow || isSelected) {
              const dx = p2.screenX - p1.screenX;
              const dy = p2.screenY - p1.screenY;
              const len = Math.hypot(dx, dy);
              if (len > 32) {
                const midX = p1.screenX + dx * 0.60;
                const midY = p1.screenY + dy * 0.60;
                const angle = Math.atan2(dy, dx);
                const arrowSize = Math.max(5.0, 6.5 * Math.min(1.3, camera.zoom));

                ctx.fillStyle = desc.color;
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

            renderedEdgesRef.current.areaEdges.push({
              edge: aEdge,
              p1: { screenX: p1.screenX, screenY: p1.screenY },
              p2: { screenX: p2.screenX, screenY: p2.screenY },
            });
          }
        } else if (scope === 'file') {
          // FILE SCOPE: Draw incident edges to selectedNodeId (or hoveredNodeId)
          const targetId = selectedNodeId || hoveredNodeId;
          const edgesToDraw = [];

          for (let i = 0; i < snapshot.edges.length; i++) {
            const edge = snapshot.edges[i];
            const p1 = projData.projectedMap.get(edge.source_file_id);
            const p2 = projData.projectedMap.get(edge.target_file_id);
            if (!p1 || !p2) continue;

            const isIncident = Boolean(
              targetId && (edge.source_file_id === targetId || edge.target_file_id === targetId)
            );
            if (!isIncident && !selectedEdgeId) continue;

            const isSelected = selectedEdgeId === edge.id;
            const direction = edge.source_file_id === targetId
              ? 'outgoing'
              : edge.target_file_id === targetId
                ? 'incoming'
                : 'both';

            const desc = resolveNetworkEdgeVisual(
              edge,
              isIncident || isSelected,
              targetId,
              camera.zoom,
              entryCandidate?.nodeId,
              theme,
              direction
            );
            if (!desc) continue;

            edgesToDraw.push({ p1, p2, edge, desc, isSelected });
          }

          edgesToDraw.sort((a, b) => a.desc.priority - b.desc.priority);

          for (let i = 0; i < edgesToDraw.length; i++) {
            const { p1, p2, edge, desc, isSelected } = edgesToDraw[i];
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(p1.screenX, p1.screenY);
            ctx.lineTo(p2.screenX, p2.screenY);
            ctx.strokeStyle = desc.color;
            ctx.lineWidth = desc.width;
            ctx.globalAlpha = desc.alpha;
            if (desc.dash.length > 0) ctx.setLineDash(desc.dash);
            ctx.stroke();

            // Arrow
            if (desc.showArrow || isSelected) {
              const dx = p2.screenX - p1.screenX;
              const dy = p2.screenY - p1.screenY;
              const len = Math.hypot(dx, dy);
              if (len > 24) {
                const midX = p1.screenX + dx * 0.62;
                const midY = p1.screenY + dy * 0.62;
                const angle = Math.atan2(dy, dx);
                const arrowSize = Math.max(4.5, 5.5 * Math.min(1.2, camera.zoom));

                ctx.fillStyle = desc.color;
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

            renderedEdgesRef.current.fileEdges.push({
              edge,
              p1: { screenX: p1.screenX, screenY: p1.screenY },
              p2: { screenX: p2.screenX, screenY: p2.screenY },
            });
          }
        } else if (scope === 'area' && !isSmallRepo) {
          // AREA SCOPE: Draw internal area edges + external edges connected to selectedAreaId
          const activeArea = selectedAreaId;
          const edgesToDraw = [];

          for (let i = 0; i < snapshot.edges.length; i++) {
            const edge = snapshot.edges[i];
            const p1 = projData.projectedMap.get(edge.source_file_id);
            const p2 = projData.projectedMap.get(edge.target_file_id);
            if (!p1 || !p2) continue;

            const srcArea = getAreaIdForPath(p1.node.relative_path);
            const tgtArea = getAreaIdForPath(p2.node.relative_path);
            const isInternal = srcArea === activeArea && tgtArea === activeArea;
            const isExternal = srcArea === activeArea || tgtArea === activeArea;

            if (!isInternal && !isExternal) continue;

            const isSelected = selectedEdgeId === edge.id;
            const isIncident = Boolean(hoveredNodeId && (edge.source_file_id === hoveredNodeId || edge.target_file_id === hoveredNodeId));

            const desc = resolveNetworkEdgeVisual(
              edge,
              isIncident || isSelected,
              hoveredNodeId,
              camera.zoom,
              entryCandidate?.nodeId,
              theme
            );
            if (!desc) continue;

            let alphaMult = isInternal ? 1.0 : 0.65;
            if (languageFilter && languageFilter !== 'all') {
              if (!matchesLanguageFilter(p1.node, languageFilter) && !matchesLanguageFilter(p2.node, languageFilter)) {
                alphaMult *= 0.1;
              }
            }

            edgesToDraw.push({ p1, p2, edge, desc, isSelected, alphaMult });
          }

          edgesToDraw.sort((a, b) => a.desc.priority - b.desc.priority);

          for (let i = 0; i < edgesToDraw.length; i++) {
            const { p1, p2, edge, desc, isSelected, alphaMult } = edgesToDraw[i];
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(p1.screenX, p1.screenY);
            ctx.lineTo(p2.screenX, p2.screenY);
            ctx.strokeStyle = isSelected ? '#38bdf8' : desc.color;
            ctx.lineWidth = isSelected ? Math.max(2.5, 3.2 / camera.zoom) : desc.width;
            ctx.globalAlpha = (isSelected ? 1.0 : desc.alpha) * alphaMult;
            if (desc.dash.length > 0) ctx.setLineDash(desc.dash);
            ctx.stroke();

            // Arrow
            if (desc.showArrow || isSelected) {
              const dx = p2.screenX - p1.screenX;
              const dy = p2.screenY - p1.screenY;
              const len = Math.hypot(dx, dy);
              if (len > 24) {
                const midX = p1.screenX + dx * 0.62;
                const midY = p1.screenY + dy * 0.62;
                const angle = Math.atan2(dy, dx);
                const arrowSize = Math.max(4.0, 5.0 * Math.min(1.2, camera.zoom));

                ctx.fillStyle = isSelected ? '#38bdf8' : desc.color;
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

            renderedEdgesRef.current.fileEdges.push({
              edge,
              p1: { screenX: p1.screenX, screenY: p1.screenY },
              p2: { screenX: p2.screenX, screenY: p2.screenY },
            });
          }
        } else {
          // SMALL REPO / DEFAULT SCOPE: Render all file edges
          const activeHighlightId = selectedNodeId || hoveredNodeId;
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
              entryCandidate?.nodeId,
              theme
            );
            if (!desc) continue;

            let depthMultiplier = 1.0;
            if (!isEdgeSelected && !isConnected && (!highlightedEdgeIds || highlightedEdgeIds.size === 0)) {
              const edgeProminence = computeEdgeDepthAttenuation(p1.projected.z, p2.projected.z, sphereRadius);
              depthMultiplier = 0.35 + 0.65 * edgeProminence;
            }

            let areaAlphaMultiplier = 1.0;
            if (highlightedEdgeIds && highlightedEdgeIds.size > 0) {
              if (!highlightedEdgeIds.has(edge.id)) areaAlphaMultiplier = 0.08;
            } else if (effectiveAreaSet && !activeHighlightId) {
              const srcArea = getAreaIdForPath(p1.node.relative_path);
              const tgtArea = getAreaIdForPath(p2.node.relative_path);
              if (!effectiveAreaSet.has(srcArea) && !effectiveAreaSet.has(tgtArea)) {
                areaAlphaMultiplier = 0.08;
              }
            }

            if (languageFilter && languageFilter !== 'all') {
              const srcMatch = matchesLanguageFilter(p1.node, languageFilter);
              const tgtMatch = matchesLanguageFilter(p2.node, languageFilter);
              if (!srcMatch && !tgtMatch) areaAlphaMultiplier *= 0.1;
            }

            if (sourceOnlyFilter) {
              const srcIsSource = p1.node.analysis_status === 'Analyzed' && p1.node.file_kind === 'Source';
              const tgtIsSource = p2.node.analysis_status === 'Analyzed' && p2.node.file_kind === 'Source';
              if (!srcIsSource && !tgtIsSource) areaAlphaMultiplier *= 0.08;
            }

            edgesToDraw.push({ p1, p2, edge, desc, isEdgeSelected, areaAlphaMultiplier: areaAlphaMultiplier * depthMultiplier });
          }

          edgesToDraw.sort((a, b) => a.desc.priority - b.desc.priority);

          for (let i = 0; i < edgesToDraw.length; i++) {
            const { p1, p2, edge, desc, isEdgeSelected, areaAlphaMultiplier } = edgesToDraw[i];
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(p1.screenX, p1.screenY);
            ctx.lineTo(p2.screenX, p2.screenY);
            ctx.strokeStyle = isEdgeSelected ? '#38bdf8' : desc.color;
            ctx.lineWidth = isEdgeSelected ? Math.max(2.5, 3.2 / camera.zoom) : desc.width;
            ctx.globalAlpha = (isEdgeSelected ? 1.0 : desc.alpha) * areaAlphaMultiplier;
            if (desc.dash.length > 0) ctx.setLineDash(desc.dash);
            ctx.stroke();

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

            renderedEdgesRef.current.fileEdges.push({
              edge,
              p1: { screenX: p1.screenX, screenY: p1.screenY },
              p2: { screenX: p2.screenX, screenY: p2.screenY },
            });
          }
        }

        // 3. Draw Area Anchor Badges & Overview Area Labels (Overview Mode Architectural Underlay)
        if (scope === 'overview' && !isSmallRepo) {
          const sortedAnchors = Array.from(areaAnchorsMap.values()).sort((a, b) => b.proj.z - a.proj.z);
          for (let i = 0; i < sortedAnchors.length; i++) {
            const pAnchor = sortedAnchors[i];
            const isAreaHovered = hoveredAreaId === pAnchor.area.id;
            const isAreaSelected = selectedAreaId === pAnchor.area.id;
            const areaColor = getAreaColor(pAnchor.area.id, theme);
            const isLight = theme === 'light';

            ctx.save();
            ctx.globalAlpha = 0.50 + 0.50 * pAnchor.depthShading.depth;

            // Outer glow ring
            if (isAreaSelected || isAreaHovered) {
              ctx.beginPath();
              ctx.arc(pAnchor.screenX, pAnchor.screenY, pAnchor.radius + 4.5, 0, Math.PI * 2);
              ctx.strokeStyle = areaColor;
              ctx.lineWidth = isAreaSelected ? 3.0 : 2.0;
              ctx.stroke();
            }

            // Badge fill
            ctx.beginPath();
            ctx.arc(pAnchor.screenX, pAnchor.screenY, pAnchor.radius, 0, Math.PI * 2);
            ctx.fillStyle = areaColor;
            ctx.fill();

            // Badge border
            ctx.strokeStyle = isLight ? 'rgba(255, 255, 255, 0.95)' : 'rgba(15, 23, 42, 0.90)';
            ctx.lineWidth = 1.8;
            ctx.stroke();

            // Monogram text (disambiguated uniquely across repository areas)
            const parts = pAnchor.area.name.split(/[-_/ ]+/).filter(Boolean);
            const fallbackMonogram = (parts.length >= 2 ? parts[0][0] + parts[1][0] : pAnchor.area.name.slice(0, 2)).toUpperCase();
            const monogram = areaMonograms.get(pAnchor.area.id) || fallbackMonogram;
            ctx.fillStyle = '#ffffff';
            ctx.font = `700 ${Math.round(pAnchor.radius * 0.8)}px "JetBrains Mono", ui-monospace, monospace`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(monogram, pAnchor.screenX, pAnchor.screenY + 0.5);
            ctx.restore();
          }
        }

        // 4. Draw Nodes (sorted far-to-near for Painter's algorithm — rendered ON TOP of area backdrops)
        const obstacleGrid = new LabelCollisionGrid(80);

        // Register architectural area anchors into the obstacle collision grid
        for (const pAnchor of areaAnchorsMap.values()) {
          obstacleGrid.insert({
            x1: pAnchor.screenX - pAnchor.radius - 2,
            y1: pAnchor.screenY - pAnchor.radius - 2,
            x2: pAnchor.screenX + pAnchor.radius + 2,
            y2: pAnchor.screenY + pAnchor.radius + 2,
          });
        }

        const sortedNodes = projData.projectedList;
        for (let i = sortedNodes.length - 1; i >= 0; i--) {
          const pNode = sortedNodes[i];
          const isSelected = selectedNodeId === pNode.id;
          const isHovered = hoveredNodeId === pNode.id;
          const isHighlighted = (highlightedNodeIds && highlightedNodeIds.has(pNode.id)) || false;

          let isDimmed = false;
          if (connectedNodes) {
            isDimmed = !connectedNodes.has(pNode.id);
          } else if (highlightedNodeIds) {
            isDimmed = !highlightedNodeIds.has(pNode.id);
          } else if (scope === 'area' && selectedAreaId) {
            isDimmed = getAreaIdForPath(pNode.node.relative_path) !== selectedAreaId;
          } else if (effectiveAreaSet) {
            isDimmed = !effectiveAreaSet.has(getAreaIdForPath(pNode.node.relative_path));
          }

          if (!isDimmed && languageFilter && languageFilter !== 'all') {
            isDimmed = !matchesLanguageFilter(pNode.node, languageFilter);
          }

          if (!isDimmed && sourceOnlyFilter) {
            isDimmed = pNode.node.analysis_status !== 'Analyzed' || pNode.node.file_kind !== 'Source';
          }

          const isOverviewMode = scope === 'overview' && !isSmallRepo;
          const screenR = isOverviewMode
            ? Math.max(2.8, Math.min(5.0, pNode.radius * 0.75 * camera.zoom))
            : pNode.radius * camera.zoom;

          const depthShading = computeCameraDepthShading(
            pNode.projected.z,
            sphereRadius,
            theme,
            { isSelected, isHovered, minProminence: isHighlighted ? 0.8 : undefined }
          );

          const isMainEntry = entryCandidate !== null && pNode.id === entryCandidate.nodeId;
          const nodeAreaId = getAreaIdForPath(pNode.node.relative_path);
          const descriptor = resolveNodeVisualDescriptor(
            pNode.node,
            nodeAreaId,
            depthShading.prominence,
            depthShading.depth,
            theme,
            {
              isEntry: isMainEntry,
              isSelected,
              isHovered,
              isHighlighted,
              isDimmed,
              isOverviewMode,
            }
          );

          ctx.save();
          ctx.globalAlpha = descriptor.depthAlpha;

          const isLight = theme === 'light';

          // Selection / Hover / Highlight outer ring with electric indigo palette
          if (isSelected || isHighlighted) {
            ctx.beginPath();
            ctx.arc(pNode.screenX, pNode.screenY, screenR + 5.5, 0, Math.PI * 2);
            ctx.strokeStyle = isLight ? 'rgba(79, 70, 229, 0.35)' : 'rgba(99, 102, 241, 0.40)';
            ctx.lineWidth = 3.0;
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(pNode.screenX, pNode.screenY, screenR + 2.5, 0, Math.PI * 2);
            ctx.strokeStyle = descriptor.haloColor || (isLight ? '#4f46e5' : '#818cf8');
            ctx.lineWidth = 2.0;
            ctx.stroke();
          } else if (isHovered && descriptor.haloColor) {
            ctx.beginPath();
            ctx.arc(pNode.screenX, pNode.screenY, screenR + 3, 0, Math.PI * 2);
            ctx.strokeStyle = descriptor.haloColor;
            ctx.lineWidth = descriptor.haloWidth;
            ctx.stroke();
          }

          // Node glyph body with camera-relative depth color shading
          ctx.beginPath();
          ctx.arc(pNode.screenX, pNode.screenY, screenR, 0, Math.PI * 2);
          ctx.fillStyle = descriptor.fillColor;
          ctx.fill();

          // Architectural group membership ring colored by canonical area color
          ctx.strokeStyle = descriptor.areaRingColor;
          ctx.lineWidth = descriptor.ringWidth;
          ctx.stroke();
          ctx.restore();

          // Register prominent foreground file nodes as obstacles for label placement
          if (descriptor.depthAlpha >= 0.25 || isSelected || isHovered || isHighlighted) {
            const haloPad = isSelected || isHovered ? 8 : 4;
            obstacleGrid.insert({
              x1: pNode.screenX - screenR - haloPad,
              y1: pNode.screenY - screenR - haloPad,
              x2: pNode.screenX + screenR + haloPad,
              y2: pNode.screenY + screenR + haloPad,
            });
          }
        }

        // 4.5 Draw Architectural Area Labels (Collision-Aware Multi-Candidate Placement + Smooth Depth Fade + Synchronized Motion)
        isAnyLabelTransitionActive = false;
        isAnyMotionActive = false;
        renderedAreaLabelsRef.current.clear();

        if (scope === 'overview' && !isSmallRepo) {
          const now = timestamp || performance.now();
          const fadeMap = labelFadeStatesRef.current;
          const motionMap = labelMotionStatesRef.current;
          const motionTimeline = motionTimelineRef.current;
          const placedLabelsGrid = new LabelCollisionGrid(90);

          // Advance synchronized motion timeline for active transitions
          const timelineStillActive = stepSynchronizedMotion(
            motionMap,
            motionTimeline,
            now,
            prefersReducedMotion
          );
          if (timelineStillActive) {
            isAnyMotionActive = true;
          }

          // Populate placedLabelsGrid with all area anchor badges so labels never cover anchor monograms
          for (const a of areaAnchorsMap.values()) {
            placedLabelsGrid.insert({
              x1: a.screenX - a.radius - 2,
              y1: a.screenY - a.radius - 2,
              x2: a.screenX + a.radius + 2,
              y2: a.screenY + a.radius + 2,
            });
          }

          const allAnchors = Array.from(areaAnchorsMap.values());
          allAnchors.sort((a, b) => {
            if (a.area.id === selectedAreaId) return -1;
            if (b.area.id === selectedAreaId) return 1;
            if (a.area.id === hoveredAreaId) return -1;
            if (b.area.id === hoveredAreaId) return 1;
            if (b.area.fileCount !== a.area.fileCount) {
              return b.area.fileCount - a.area.fileCount;
            }
            return a.area.id.localeCompare(b.area.id);
          });

          for (let i = 0; i < allAnchors.length; i++) {
            const pAnchor = allAnchors[i];
            const isSelected = pAnchor.area.id === selectedAreaId;
            const isHovered = pAnchor.area.id === hoveredAreaId;
            const isPriority = isSelected || isHovered;

            const existingFadeState = fadeMap.get(pAnchor.area.id);
            const targetOpacity = computeLabelTargetOpacity(
              pAnchor.isFront,
              pAnchor.depthShading.prominence,
              isPriority,
              existingFadeState ? existingFadeState.currentOpacity : 0.0
            );

            let fadeState = existingFadeState;
            if (!fadeState) {
              // Initial state: front-facing labels start immediately visible at targetOpacity
              fadeState = {
                currentOpacity: targetOpacity,
                targetOpacity,
                lastTimestamp: now,
              };
              fadeMap.set(pAnchor.area.id, fadeState);
            }

            const transitionActive = stepLabelFade(
              fadeState,
              targetOpacity,
              now,
              prefersReducedMotion
            );
            if (transitionActive) {
              isAnyLabelTransitionActive = true;
            }

            if (fadeState.currentOpacity <= 0.01) {
              continue;
            }

            const rawLabelText = pAnchor.area.name;
            const countText = `${pAnchor.area.fileCount} files`;

            ctx.save();
            const areaFont = `600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
            ctx.font = areaFont;
            const labelText = fitTextEnd(rawLabelText, 160, (s) => ctx.measureText(s).width, areaFont);
            const nameWidth = ctx.measureText(labelText).width;
            ctx.font = `500 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
            const countWidth = ctx.measureText(countText).width;

            const boxWidth = Math.max(nameWidth, countWidth) + 16;
            const boxHeight = 32;

            const placementAnchor: LabelPlacementAnchor = {
              id: pAnchor.area.id,
              screenX: pAnchor.screenX,
              screenY: pAnchor.screenY,
              radius: pAnchor.radius,
              isSelected,
              isHovered,
            };

            const existingMotionState = motionMap.get(pAnchor.area.id);
            const prevCandidateIndex = existingMotionState?.candidateIndex ?? fadeState.candidateIndex;

            const placementResult = resolveAreaLabelPlacement(
              placementAnchor,
              boxWidth,
              boxHeight,
              obstacleGrid,
              width,
              height,
              insets,
              prevCandidateIndex,
              placedLabelsGrid
            );

            fadeState.candidateIndex = placementResult.candidateIndex;

            if (placementResult.isSuppressed && !isPriority) {
              ctx.restore();
              continue;
            }

            const wasRenderedLastFrame = previouslyRenderedAreaIdsRef.current.has(pAnchor.area.id);
            const isReentry = !wasRenderedLastFrame;

            // Register candidate placement with synchronized motion engine
            const targetOffset = computeAnchorRelativeOffset(
              pAnchor.screenX,
              pAnchor.screenY,
              placementResult.rect
            );
            const motionJoined = registerLabelMotionTarget(
              motionMap,
              motionTimeline,
              pAnchor.area.id,
              placementResult.candidateIndex,
              targetOffset,
              now,
              prefersReducedMotion,
              DEFAULT_MOTION_DURATION_MS,
              isReentry
            );
            if (motionJoined) {
              isAnyMotionActive = true;
            }

            const motionState = motionMap.get(pAnchor.area.id)!;
            const rect = computeRenderedLabelRect(
              pAnchor.screenX,
              pAnchor.screenY,
              motionState.currentOffset,
              boxWidth,
              boxHeight
            );

            obstacleGrid.insert(rect);
            placedLabelsGrid.insert(rect);

            renderedAreaLabelsRef.current.set(pAnchor.area.id, {
              areaId: pAnchor.area.id,
              name: pAnchor.area.name,
              rect,
              placement: placementResult.placement,
              opacity: fadeState.currentOpacity,
            });

            ctx.globalAlpha = (isLight ? 0.95 : 0.90) * fadeState.currentOpacity;

            // Pill background
            ctx.beginPath();
            if (ctx.roundRect) {
              ctx.roundRect(rect.x1, rect.y1, boxWidth, boxHeight, 6);
            } else {
              ctx.rect(rect.x1, rect.y1, boxWidth, boxHeight);
            }
            ctx.fillStyle = isLight ? 'rgba(255, 255, 255, 0.92)' : 'rgba(13, 18, 31, 0.88)';
            ctx.fill();

            // Pill border (highlighted if selected or hovered)
            ctx.strokeStyle = isSelected
              ? (isLight ? '#4f46e5' : '#6366f1')
              : isHovered
                ? (isLight ? '#0284c7' : '#38bdf8')
                : (isLight ? 'rgba(0, 0, 0, 0.12)' : 'rgba(255, 255, 255, 0.15)');
            ctx.lineWidth = isSelected || isHovered ? 1.5 : 1;
            ctx.stroke();

            // Area name
            const textCenterX = (rect.x1 + rect.x2) / 2;
            ctx.font = areaFont;
            ctx.fillStyle = isLight ? '#0f172a' : '#f8fafc';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(labelText, textCenterX, rect.y1 + 3);

            // File count
            ctx.font = `500 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
            ctx.fillStyle = isLight ? '#64748b' : '#94a3b8';
            ctx.fillText(countText, textCenterX, rect.y1 + 17);

            ctx.restore();
          }
          previouslyRenderedAreaIdsRef.current = new Set(renderedAreaLabelsRef.current.keys());
        }

        // 5. Draw Node Labels (Spatial Collision Grid)
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

          // In Overview scope: suppress labels except for hovered or selected nodes
          if (scope === 'overview' && !isSelected && !isHovered) {
            continue;
          }

          if (languageFilter && languageFilter !== 'all') {
            if (!matchesLanguageFilter(pNode.node, languageFilter)) {
              continue;
            }
          }

          // In File scope: suppress labels for unrelated nodes
          if (scope === 'file' && !isSelected && !isHovered && !isConnectedToSelected) {
            continue;
          }

          // In Area scope: suppress labels for nodes outside selected area unless hovered
          if (scope === 'area' && selectedAreaId) {
            if (getAreaIdForPath(pNode.node.relative_path) !== selectedAreaId && !isHovered) {
              continue;
            }
          }

          const shouldDraw = shouldDrawNodeLabel({
            isSelected,
            isHovered,
            isConnectedToSelected,
            projectedZ: pNode.projected.z,
            totalDegree,
            zoom: camera.zoom,
          });

          if (!shouldDraw) continue;

          const rawText = disambiguatedLabels.get(pNode.id) || pNode.node.filename;
          const text = fitTextMiddle(rawText, 180, (s) => ctx.measureText(s).width, monoFont);
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
            effectiveAreaSet !== null && effectiveAreaSet.has(getAreaIdForPath(pNode.node.relative_path));

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

        candidateLabels.sort((a, b) => b.priorityScore - a.priorityScore);

        const collisionGrid = obstacleGrid;

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
      if (cameraAnimRef.current || isAnyLabelTransitionActive || isAnyMotionActive) {
        rafIdRef.current = requestAnimationFrame((ts) => renderLoopRef.current(ts));
      }
    },
    [
      snapshot,
      positions,
      selectedNodeId,
      selectedEdgeId,
      hoveredNodeId,
      hoveredAreaId,
      hoveredAreaEdgeId,
      selectedAreaId,
      selectedAreaEdge,
      effectiveAreaSet,
      languageFilter,
      highlightedNodeIds,
      highlightedEdgeIds,
      entryCandidate,
      disambiguatedLabels,
      neighborMap,
      repoStructure,
      areaAnchors,
      isSmallRepo,
      scope,
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
  }, [
    snapshot,
    positions,
    selectedNodeId,
    selectedEdgeId,
    hoveredNodeId,
    hoveredAreaId,
    hoveredAreaEdgeId,
    selectedAreaId,
    selectedAreaEdge,
    effectiveAreaSet,
    languageFilter,
    highlightedNodeIds,
    highlightedEdgeIds,
    repoStructure,
    isSmallRepo,
    scope,
    isVisible,
    theme,
    requestRender,
  ]);

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

      // Iterate frontmost nodes first (nearer nodes have smaller z and are at the start of projectedList)
      const list = projData.projectedList;
      for (let i = 0; i < list.length; i++) {
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
      if (!canvas) return null;

      const rect = canvas.getBoundingClientRect();
      const screenX = clientX - rect.left;
      const screenY = clientY - rect.top;

      const hitTolerance = 6;
      let bestEdge: DependencyEdge | null = null;
      let bestDist = Infinity;

      // Test against rendered edges first for exact parity with screen
      const edgeList = renderedEdgesRef.current.fileEdges;
      if (edgeList.length > 0) {
        for (let i = 0; i < edgeList.length; i++) {
          const item = edgeList[i];
          const dist = pointToSegmentDistance(
            { x: screenX, y: screenY },
            { x: item.p1.screenX, y: item.p1.screenY },
            { x: item.p2.screenX, y: item.p2.screenY }
          );
          if (dist <= hitTolerance && dist < bestDist) {
            bestDist = dist;
            bestEdge = item.edge;
          }
        }
        return bestEdge;
      }

      // Fallback
      const projData = projectedDataRef.current;
      if (!projData) return null;
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

  const findAreaAnchorAtPoint = useCallback(
    (clientX: number, clientY: number): RepositoryArea | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const screenX = clientX - rect.left;
      const screenY = clientY - rect.top;

      let bestArea: RepositoryArea | null = null;
      let bestDist = Infinity;

      for (const [, projAnchor] of projectedAreaAnchorsRef.current.entries()) {
        const dist = Math.hypot(projAnchor.screenX - screenX, projAnchor.screenY - screenY);
        // Constrain hit radius to the anchor badge boundary so it never intercepts clicks intended for surrounding file nodes
        const hitRadius = projAnchor.radius + 2;
        if (dist <= hitRadius && dist < bestDist) {
          bestDist = dist;
          bestArea = projAnchor.area;
        }
      }
      return bestArea;
    },
    []
  );

  const findAreaEdgeAtPoint = useCallback(
    (clientX: number, clientY: number): AreaEdge | null => {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const screenX = clientX - rect.left;
      const screenY = clientY - rect.top;

      const hitTolerance = 8;
      let bestEdge: AreaEdge | null = null;
      let bestDist = Infinity;

      for (const rendered of renderedEdgesRef.current.areaEdges) {
        const dist = pointToSegmentDistance(
          { x: screenX, y: screenY },
          { x: rendered.p1.screenX, y: rendered.p1.screenY },
          { x: rendered.p2.screenX, y: rendered.p2.screenY }
        );
        if (dist <= hitTolerance && dist < bestDist) {
          bestDist = dist;
          bestEdge = rendered.edge;
        }
      }
      return bestEdge;
    },
    []
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
    hoverControllerRef.current?.handleGestureStart();
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
          // Unrestricted screen-relative continuous 3D rotation (quaternion orientation)
          const startCam = ensureCameraOrientation(gesture.startCamera);
          const newOrientation = rotateOrientationByScreenDelta(startCam.orientation!, dx, dy);
          const { yaw: newYaw, pitch: newPitch } = quaternionToEuler(newOrientation);
          cameraRef.current.orientation = newOrientation;
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

    // File nodes have first-class interaction precedence over area anchors & edges
    const hitNode = findNodeAtPoint(e.clientX, e.clientY);
    if (hitNode) {
      if (hoveredAreaId !== null) {
        setHoveredAreaId(null);
        requestRender();
      }
      if (hoveredAreaEdgeId !== null) {
        setHoveredAreaEdgeId(null);
        requestRender();
      }
      hoverControllerRef.current?.handlePointerMoveOverNode(hitNode.id);
      if (canvasRef.current) canvasRef.current.style.cursor = 'pointer';
      return;
    }

    // Hover hit test with hysteresis based on scope
    if (scope === 'overview' && !isSmallRepo) {
      const hitArea = findAreaAnchorAtPoint(e.clientX, e.clientY);
      if (hitArea) {
        if (hoveredAreaId !== hitArea.id) {
          setHoveredAreaId(hitArea.id);
          requestRender();
        }
        setHoveredAreaEdgeId(null);
        hoverControllerRef.current?.handlePointerMoveOverEmpty();
        if (canvasRef.current) canvasRef.current.style.cursor = 'pointer';
        return;
      } else if (hoveredAreaId !== null) {
        setHoveredAreaId(null);
        requestRender();
      }

      const hitAreaEdge = findAreaEdgeAtPoint(e.clientX, e.clientY);
      if (hitAreaEdge) {
        if (hoveredAreaEdgeId !== hitAreaEdge.id) {
          setHoveredAreaEdgeId(hitAreaEdge.id);
          requestRender();
        }
        hoverControllerRef.current?.handlePointerMoveOverEmpty();
        if (canvasRef.current) canvasRef.current.style.cursor = 'pointer';
        return;
      } else if (hoveredAreaEdgeId !== null) {
        setHoveredAreaEdgeId(null);
        requestRender();
      }

      hoverControllerRef.current?.handlePointerMoveOverEmpty();
      if (canvasRef.current) canvasRef.current.style.cursor = '';
    } else {
      if (hoveredAreaId !== null) {
        setHoveredAreaId(null);
        requestRender();
      }
      if (hoveredAreaEdgeId !== null) {
        setHoveredAreaEdgeId(null);
        requestRender();
      }

      hoverControllerRef.current?.handlePointerMoveOverEmpty();
      if (canvasRef.current) canvasRef.current.style.cursor = '';
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
      hoverControllerRef.current?.handleGestureEnd();
      if (canvasRef.current) {
        canvasRef.current.style.cursor = '';
      }
    },
    []
  );

  const handlePointerUp = (e: React.PointerEvent) => {
    const gesture = gestureRef.current;
    const wasDragging = gesture.exceededThreshold;
    const previousMode = gesture.mode;

    cleanUpPointerGesture(e);

    // If click below threshold: perform selection WITHOUT moving the camera
    if (!wasDragging) {
      // 1. File nodes have first-class selection precedence over area anchors & edges
      const hitNode = findNodeAtPoint(e.clientX, e.clientY);
      if (hitNode) {
        hoverControllerRef.current?.handleClickNode(hitNode.id);
        onSelectNode(hitNode);
        onSelectEdge(null);
        onSelectAreaEdge?.(null);
        onAnnounce?.(`Selected file ${hitNode.filename}`);
        return;
      }

      if (scope === 'overview' && !isSmallRepo) {
        const hitArea = findAreaAnchorAtPoint(e.clientX, e.clientY);
        if (hitArea) {
          onSelectArea?.(hitArea.id);
          onSelectNode(null);
          onSelectEdge(null);
          onSelectAreaEdge?.(null);
          onAnnounce?.(`Focused architectural area ${hitArea.name}`);
          return;
        }

        const hitAreaEdge = findAreaEdgeAtPoint(e.clientX, e.clientY);
        if (hitAreaEdge) {
          onSelectAreaEdge?.(hitAreaEdge);
          onSelectNode(null);
          onSelectEdge(null);
          onAnnounce?.(`Selected inter-area relationship between ${hitAreaEdge.sourceAreaId} and ${hitAreaEdge.targetAreaId}`);
          return;
        }

        onSelectNode(null);
        onSelectEdge(null);
        onSelectAreaEdge?.(null);
      } else {
        const hitEdge = findEdgeAtPoint(e.clientX, e.clientY);
        if (hitEdge) {
          onSelectEdge(hitEdge);
          onSelectNode(null);
          onSelectAreaEdge?.(null);
          onAnnounce?.(`Selected relationship ${hitEdge.relationship_kind}`);
        } else {
          const hitArea = findAreaAnchorAtPoint(e.clientX, e.clientY);
          if (hitArea && hitArea.id !== selectedAreaId) {
            onSelectArea?.(hitArea.id);
            onSelectNode(null);
            onSelectEdge(null);
            onSelectAreaEdge?.(null);
            onAnnounce?.(`Switched to area ${hitArea.name}`);
          } else {
            if (selectedNodeId) {
              onSelectNode(null);
            } else if (selectedAreaId) {
              onSelectArea?.(null);
            }
            onSelectEdge(null);
            onSelectAreaEdge?.(null);
          }
        }
      }
    } else if (previousMode === 'rotating') {
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

  const applyWheelZoom = useCallback(
    (e: { clientX: number; clientY: number; deltaY: number; deltaMode: number; ctrlKey: boolean }) => {
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
    },
    [hasInteracted, keepGraphCentered, insets, requestRender]
  );

  // Directly attached native non-passive wheel listener: guarantees synchronous cancellation
  // of default browser zoom gestures (including trackpad pinch where e.ctrlKey === true)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onNativeWheel = (e: WheelEvent) => {
      if (e.cancelable) {
        e.preventDefault();
      }
      applyWheelZoom(e);
    };

    canvas.addEventListener('wheel', onNativeWheel, { passive: false });
    return () => {
      canvas.removeEventListener('wheel', onNativeWheel);
    };
  }, [applyWheelZoom]);

  // Keyboard accessibility
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (inertiaRafRef.current !== null) {
      cancelAnimationFrame(inertiaRafRef.current);
      inertiaRafRef.current = null;
    }

    if (e.key === 'Escape') {
      if (selectedNodeId) {
        onSelectNode(null);
      } else if (selectedAreaEdge) {
        onSelectAreaEdge?.(null);
      } else if (selectedAreaId) {
        onSelectArea?.(null);
      }
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
        const curCam = ensureCameraOrientation(cur);
        const nextOrientation = rotateOrientationByScreenDelta(curCam.orientation!, 10, 0);
        const { yaw, pitch } = quaternionToEuler(nextOrientation);
        cur.orientation = nextOrientation;
        cur.yaw = yaw;
        cur.pitch = pitch;
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
        const curCam = ensureCameraOrientation(cur);
        const nextOrientation = rotateOrientationByScreenDelta(curCam.orientation!, -10, 0);
        const { yaw, pitch } = quaternionToEuler(nextOrientation);
        cur.orientation = nextOrientation;
        cur.yaw = yaw;
        cur.pitch = pitch;
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
        const curCam = ensureCameraOrientation(cur);
        const nextOrientation = rotateOrientationByScreenDelta(curCam.orientation!, 0, -10);
        const { yaw, pitch } = quaternionToEuler(nextOrientation);
        cur.orientation = nextOrientation;
        cur.yaw = yaw;
        cur.pitch = pitch;
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
        const curCam = ensureCameraOrientation(cur);
        const nextOrientation = rotateOrientationByScreenDelta(curCam.orientation!, 0, 10);
        const { yaw, pitch } = quaternionToEuler(nextOrientation);
        cur.orientation = nextOrientation;
        cur.yaw = yaw;
        cur.pitch = pitch;
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
          : hoveredAreaId || hoveredAreaEdgeId || hoveredNodeId
            ? 'pointer'
            : 'grab',
      }}
    >
      {/* Interactive Hierarchical Breadcrumb Navigation */}
      {!hideInternalBreadcrumb && (
        <div className="network-breadcrumb-bar" role="navigation" aria-label="Graph Level Navigation">
          <button
            type="button"
            className={`crumb-btn ${scope === 'overview' ? 'active' : ''}`}
            onClick={() => {
              onSelectArea?.(null);
              onSelectNode(null);
              onSelectAreaEdge?.(null);
            }}
            title="Return to Repository Overview"
          >
            Overview
          </button>

          {selectedAreaId && (
            <>
              <span className="crumb-sep">/</span>
              <button
                type="button"
                className={`crumb-btn ${scope === 'area' ? 'active' : ''}`}
                onClick={() => {
                  onSelectNode(null);
                  onSelectAreaEdge?.(null);
                }}
                title={`Area: ${selectedAreaId}`}
              >
                Area: {selectedAreaId}
              </button>
            </>
          )}

          {selectedNodeId && (
            <>
              <span className="crumb-sep">/</span>
              <span className="crumb-current">
                {snapshot.nodes.find((n) => n.id === selectedNodeId)?.filename || 'File'}
              </span>
              <button
                type="button"
                className="crumb-clear-btn"
                onClick={() => onSelectNode(null)}
                title="Deselect file"
                aria-label="Deselect file"
              >
                <X size={12} />
              </button>
            </>
          )}

          {selectedAreaEdge && !selectedNodeId && (
            <>
              <span className="crumb-sep">/</span>
              <span className="crumb-current">
                {selectedAreaEdge.sourceAreaId} → {selectedAreaEdge.targetAreaId} ({selectedAreaEdge.edgeCount})
              </span>
              <button
                type="button"
                className="crumb-clear-btn"
                onClick={() => onSelectAreaEdge?.(null)}
                title="Deselect area relationship"
                aria-label="Deselect area relationship"
              >
                <X size={12} />
              </button>
            </>
          )}
        </div>
      )}

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
        onPointerLeave={() => hoverControllerRef.current?.handlePointerLeaveCanvas()}
        onLostPointerCapture={handleLostPointerCapture}
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
        <Lightbulb size={13} className="legend-icon" aria-hidden="true" />
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
            <h4>Codebase Architecture Guide</h4>
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
            PreBase organizes the codebase into 3D architectural zones on the sphere. Connections aggregate inter-area dependencies.
          </p>
          <div className="legend-section">
            <span className="legend-label">Exploration Levels</span>
            <div className="legend-row">
              <span className="legend-swatch" style={{ background: '#6366f1' }} />
              <span><strong>Overview:</strong> Architectural areas &amp; component relationships</span>
            </div>
            <div className="legend-row">
              <span className="legend-swatch" style={{ background: '#38bdf8' }} />
              <span><strong>Area View:</strong> Internal files &amp; external boundaries</span>
            </div>
            <div className="legend-row">
              <span className="legend-swatch" style={{ background: '#2dd4bf' }} />
              <span><strong>File View:</strong> Immediate dependencies &amp; dependents</span>
            </div>
          </div>
          <div className="legend-section">
            <span className="legend-label">File Types</span>
            <div className="legend-row">
              <span className="legend-swatch" style={{ background: '#38bdf8' }} />
              <span>TypeScript / JavaScript</span>
            </div>
            <div className="legend-row">
              <span className="legend-swatch" style={{ background: '#f97316' }} />
              <span>Rust / Systems</span>
            </div>
            <div className="legend-row">
              <span className="legend-swatch" style={{ background: '#3572A5' }} />
              <span>Python / Scripts</span>
            </div>
            <div className="legend-row">
              <span className="legend-swatch" style={{ background: '#a855f7' }} />
              <span>Styles &amp; CSS</span>
            </div>
            <div className="legend-row">
              <span className="legend-swatch" style={{ background: '#eab308' }} />
              <span>Config &amp; Data</span>
            </div>
            {entryCandidate && (
              <div className="legend-row">
                <span className="legend-swatch" style={{ background: ENTRY_NODE_COLOR }} />
                <span>Primary Entry Candidate</span>
              </div>
            )}
          </div>
          <div className="legend-section">
            <span className="legend-label">Dependency Direction</span>
            <div className="legend-row">
              <span className="legend-swatch" style={{ background: '#2dd4bf' }} />
              <span>Outgoing: Files this component depends on</span>
            </div>
            <div className="legend-row">
              <span className="legend-swatch" style={{ background: '#a78bfa' }} />
              <span>Incoming: Components that import this file</span>
            </div>
          </div>
          <div className="legend-section">
            <span className="legend-label">Controls</span>
            <div className="legend-keys">
              <span><strong>Drag:</strong> Rotate 3D orb continuously</span>
              <span><strong>Shift+drag:</strong> Pan</span>
              <span><strong>Scroll:</strong> Zoom in/out</span>
              <span><strong>Click area:</strong> Drill into architectural area</span>
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
