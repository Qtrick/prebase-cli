import { FileNode, NetworkCamera, Point3D, ViewportInsets } from '../../../types/graph';

export interface ProjectedPoint {
  x: number;
  y: number;
  z: number;
  depthScale: number;
  normalizedDepth: number;
}

export interface ProjectedNode {
  id: string;
  node: FileNode;
  worldPos: Point3D;
  localPos: Point3D;
  projected: ProjectedPoint;
  screenX: number;
  screenY: number;
  radius: number;
}

export interface ProjectedGraph {
  projectedList: ProjectedNode[];
  projectedMap: Map<string, ProjectedNode>;
  bounds: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  };
}

export const DEFAULT_YAW = 0.55;
export const DEFAULT_PITCH = 0.28;
export const MIN_ZOOM = 0.15;
export const MAX_ZOOM = 4.0;
export const DEFAULT_ZOOM = 1.0;
export const NETWORK_FOCAL_LENGTH = 1100;
export const ROTATION_SENSITIVITY = 0.005;
export const PAN_SENSITIVITY = 1.0;
export const PITCH_CLAMP_LIMIT = 1.48; // ~84.8 degrees, prevents upside-down inversion

export const GESTURE_THRESHOLD_MOUSE = 4;
export const GESTURE_THRESHOLD_PEN = 6;
export const GESTURE_THRESHOLD_TOUCH = 8;

export function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export function wrapRotationAngle(angle: number): number {
  const fullTurn = Math.PI * 2;
  return (((angle + Math.PI) % fullTurn) + fullTurn) % fullTurn - Math.PI;
}

export function clampPitch(pitch: number): number {
  return Math.max(-PITCH_CLAMP_LIMIT, Math.min(PITCH_CLAMP_LIMIT, pitch));
}

export function computeGraphCentroid(positions: Iterable<Point3D>): Point3D {
  let count = 0;
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (const p of positions) {
    if (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
      sx += p.x;
      sy += p.y;
      sz += p.z;
      count++;
    }
  }
  if (count === 0) return { x: 0, y: 0, z: 0 };
  return { x: sx / count, y: sy / count, z: sz / count };
}

export function normalizeDepthScale(depthScale: number): number {
  if (!Number.isFinite(depthScale)) return 0.5;
  return Math.max(0, Math.min(1, (depthScale - 0.65) / 0.85));
}

export function computeDepthAlpha(depthScale: number, minAlpha = 0.55, maxAlpha = 1.0): number {
  const norm = normalizeDepthScale(depthScale);
  return minAlpha + norm * (maxAlpha - minAlpha);
}

export function projectPoint3D(
  x: number,
  y: number,
  z: number,
  yaw = 0,
  pitch = 0,
  focalLength: number = NETWORK_FOCAL_LENGTH
): ProjectedPoint {
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const y1 = y * cp - z * sp;
  const z1 = y * sp + z * cp;

  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const x2 = x * cy + z1 * sy;
  const z2 = -x * sy + z1 * cy;

  const distance = Math.max(focalLength * 0.25, focalLength + z2);
  const depthScale = focalLength / distance;
  const normalizedDepth = normalizeDepthScale(depthScale);

  return {
    x: x2 * depthScale,
    y: y1 * depthScale,
    z: z2,
    depthScale,
    normalizedDepth,
  };
}

export function computeNetworkSemanticWeight(node: FileNode, entryNodeId?: string | null): number {
  if (entryNodeId && node.id === entryNodeId) return 10;
  const degree = (node.direct_dependency_count || 0) + (node.direct_dependent_count || 0);
  if (degree > 0) {
    return Math.max(1.5, 1.2 + Math.sqrt(degree) * 1.4);
  }
  return 1.5;
}

export function computeNetworkVisualRadius(
  node: FileNode,
  depthScale: number,
  options?: {
    entryNodeId?: string | null;
    isSelected?: boolean;
    isHovered?: boolean;
    zoom?: number;
  }
): number {
  const entryId = options?.entryNodeId;
  const isSelected = Boolean(options?.isSelected);
  const isHovered = Boolean(options?.isHovered);
  const zoom = options?.zoom ?? 1;

  const weight = computeNetworkSemanticWeight(node, entryId);
  const baseR = 5.0 + Math.sqrt(weight) * 2.5;

  const norm = normalizeDepthScale(depthScale);
  const depthFactor = 0.85 + norm * 0.35;

  // Zoom compensation
  const zoomFactor = Math.max(0.6, Math.min(1.4, 1 / Math.sqrt(zoom)));

  let r = baseR * depthFactor * zoomFactor;
  if (isSelected) r += 3;
  else if (isHovered) r += 1.5;

  return Math.max(4, r);
}

/**
 * Authoritative single-pass projection:
 * Projects all nodes relative to the graph centroid using the camera's orientation and translation.
 */
export function projectGraph(
  nodes: readonly FileNode[],
  positions: Map<string, Point3D>,
  centroid: Point3D,
  camera: NetworkCamera,
  options?: {
    entryNodeId?: string | null;
    selectedNodeId?: string | null;
    hoveredNodeId?: string | null;
  }
): ProjectedGraph {
  const projectedList: ProjectedNode[] = [];
  const projectedMap = new Map<string, ProjectedNode>();

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const worldPos = positions.get(node.id);
    if (!worldPos) continue;

    const localPos: Point3D = {
      x: worldPos.x - centroid.x,
      y: worldPos.y - centroid.y,
      z: worldPos.z - centroid.z,
    };

    const projected = projectPoint3D(
      localPos.x,
      localPos.y,
      localPos.z,
      camera.yaw,
      camera.pitch,
      NETWORK_FOCAL_LENGTH
    );

    const radius = computeNetworkVisualRadius(node, projected.depthScale, {
      entryNodeId: options?.entryNodeId,
      isSelected: options?.selectedNodeId === node.id,
      isHovered: options?.hoveredNodeId === node.id,
      zoom: camera.zoom,
    });

    const screenX = camera.panX + projected.x * camera.zoom;
    const screenY = camera.panY + projected.y * camera.zoom;

    const projectedNode: ProjectedNode = {
      id: node.id,
      node,
      worldPos,
      localPos,
      projected,
      screenX,
      screenY,
      radius,
    };

    projectedList.push(projectedNode);
    projectedMap.set(node.id, projectedNode);

    minX = Math.min(minX, projected.x - radius);
    maxX = Math.max(maxX, projected.x + radius);
    minY = Math.min(minY, projected.y - radius);
    maxY = Math.max(maxY, projected.y + radius);
  }

  // Sort by depth (z) ascending for drawing back-to-front
  projectedList.sort((a, b) => a.projected.z - b.projected.z);

  return {
    projectedList,
    projectedMap,
    bounds: {
      minX: Number.isFinite(minX) ? minX : 0,
      maxX: Number.isFinite(maxX) ? maxX : 0,
      minY: Number.isFinite(minY) ? minY : 0,
      maxY: Number.isFinite(maxY) ? maxY : 0,
    },
  };
}

/**
 * Computes fit transform { panX, panY, zoom } that neatly frames the graph in usable viewport.
 * Preserves the camera's current yaw and pitch.
 */
export function computeNetworkFitTransform(
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
  viewportWidth: number,
  viewportHeight: number,
  insets?: ViewportInsets,
  padding = 64
): { panX: number; panY: number; zoom: number } {
  const insetLeft = insets?.left ?? 0;
  const insetRight = insets?.right ?? 0;
  const insetTop = insets?.top ?? 0;
  const insetBottom = insets?.bottom ?? 0;

  const usableW = Math.max(100, viewportWidth - insetLeft - insetRight);
  const usableH = Math.max(100, viewportHeight - insetTop - insetBottom);
  const usableCenterX = insetLeft + usableW / 2;
  const usableCenterY = insetTop + usableH / 2;

  const graphWidth = Math.max(20, bounds.maxX - bounds.minX);
  const graphHeight = Math.max(20, bounds.maxY - bounds.minY);

  const scaleX = (usableW - padding * 2) / graphWidth;
  const scaleY = (usableH - padding * 2) / graphHeight;
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(scaleX, scaleY)));

  const graphMidX = (bounds.minX + bounds.maxX) / 2;
  const graphMidY = (bounds.minY + bounds.maxY) / 2;

  return {
    panX: usableCenterX - graphMidX * zoom,
    panY: usableCenterY - graphMidY * zoom,
    zoom,
  };
}

/**
 * Determines whether a projected node is safely visible within the usable viewport.
 */
export function isNodeVisibleInViewport(
  screenX: number,
  screenY: number,
  radius: number,
  viewportWidth: number,
  viewportHeight: number,
  insets?: ViewportInsets,
  margin = 48
): boolean {
  const minX = (insets?.left ?? 0) + margin;
  const maxX = viewportWidth - (insets?.right ?? 0) - margin;
  const minY = (insets?.top ?? 0) + margin;
  const maxY = viewportHeight - (insets?.bottom ?? 0) - margin;

  return (
    screenX - radius >= minX &&
    screenX + radius <= maxX &&
    screenY - radius >= minY &&
    screenY + radius <= maxY
  );
}

/**
 * Zooms around cursor position so the world coordinate beneath the cursor remains stationary.
 */
export function applyZoomAroundCursor(
  camera: NetworkCamera,
  factor: number,
  cursorX: number,
  cursorY: number,
  minZoom = MIN_ZOOM,
  maxZoom = MAX_ZOOM
): NetworkCamera {
  const prevZoom = camera.zoom;
  if (!Number.isFinite(prevZoom) || prevZoom <= 0) {
    return { ...camera, zoom: clamp(factor, minZoom, maxZoom) };
  }

  const nextZoom = clamp(prevZoom * factor, minZoom, maxZoom);
  if (nextZoom === prevZoom) {
    return camera;
  }

  const ratio = nextZoom / prevZoom;
  const nextPanX = cursorX - (cursorX - camera.panX) * ratio;
  const nextPanY = cursorY - (cursorY - camera.panY) * ratio;

  return {
    ...camera,
    panX: nextPanX,
    panY: nextPanY,
    zoom: nextZoom,
  };
}

export function normalizeWheelZoomDelta(e: { deltaY: number; deltaMode: number; ctrlKey?: boolean }): number {
  if (!Number.isFinite(e.deltaY) || e.deltaY === 0) return 0;

  let multiplier = 1.0;
  if (e.deltaMode === 1) multiplier = 24.0; // Line mode
  else if (e.deltaMode === 2) multiplier = 400.0; // Page mode

  let delta = e.deltaY * multiplier;
  if (e.ctrlKey) delta *= 1.5;

  return Math.max(-320, Math.min(320, delta));
}

export function computeContinuousZoomFactor(normalizedDelta: number): number {
  if (!Number.isFinite(normalizedDelta) || normalizedDelta === 0) return 1.0;
  return Math.pow(2, -normalizedDelta * 0.0025);
}

export function createDefaultCamera(
  viewportWidth = 800,
  viewportHeight = 600,
  insets?: ViewportInsets
): NetworkCamera {
  const insetLeft = insets?.left ?? 0;
  const insetRight = insets?.right ?? 0;
  const insetTop = insets?.top ?? 0;
  const insetBottom = insets?.bottom ?? 0;

  const usableW = Math.max(100, viewportWidth - insetLeft - insetRight);
  const usableH = Math.max(100, viewportHeight - insetTop - insetBottom);

  return {
    yaw: DEFAULT_YAW,
    pitch: DEFAULT_PITCH,
    panX: insetLeft + usableW / 2,
    panY: insetTop + usableH / 2,
    zoom: DEFAULT_ZOOM,
  };
}

export function resetNetworkCamera(
  camera?: Partial<NetworkCamera>,
  viewportWidth = 800,
  viewportHeight = 600,
  insets?: ViewportInsets
): NetworkCamera {
  const def = createDefaultCamera(viewportWidth, viewportHeight, insets);
  return {
    ...camera,
    yaw: DEFAULT_YAW,
    pitch: DEFAULT_PITCH,
    panX: def.panX,
    panY: def.panY,
    zoom: DEFAULT_ZOOM,
  };
}

/**
 * Hit testing for projected nodes in reverse order (frontmost/highest depth first).
 * Returns the frontmost FileNode if screen coordinates fall within hit target radius.
 */
export function findHitNode(
  projectedList: readonly ProjectedNode[],
  screenX: number,
  screenY: number,
  zoom: number
): FileNode | null {
  for (let i = projectedList.length - 1; i >= 0; i--) {
    const pNode = projectedList[i];
    const screenR = pNode.radius * zoom;
    const hitTargetRadius = Math.max(screenR + 4, 10);
    const dist = Math.hypot(pNode.screenX - screenX, pNode.screenY - screenY);

    if (dist <= hitTargetRadius) {
      return pNode.node;
    }
  }
  return null;
}

/**
 * Computes camera transform to reveal and focus a target node.
 * If onlyIfOutside is true and the node is already within the usable viewport, returns null (no camera movement).
 * Otherwise, centers the node in the usable viewport while preserving camera yaw, pitch, and zoom.
 */
export function computeRevealCamera(
  projectedNode: ProjectedNode,
  currentCamera: NetworkCamera,
  viewportWidth: number,
  viewportHeight: number,
  insets?: ViewportInsets,
  onlyIfOutside = false
): NetworkCamera | null {
  const isVisible = isNodeVisibleInViewport(
    projectedNode.screenX,
    projectedNode.screenY,
    projectedNode.radius,
    viewportWidth,
    viewportHeight,
    insets
  );

  if (onlyIfOutside && isVisible) {
    return null;
  }

  const insetLeft = insets?.left ?? 0;
  const insetRight = insets?.right ?? 0;
  const insetTop = insets?.top ?? 0;
  const insetBottom = insets?.bottom ?? 0;
  const usableCenterX = insetLeft + Math.max(100, viewportWidth - insetLeft - insetRight) / 2;
  const usableCenterY = insetTop + Math.max(100, viewportHeight - insetTop - insetBottom) / 2;

  const targetPanX = usableCenterX - projectedNode.projected.x * currentCamera.zoom;
  const targetPanY = usableCenterY - projectedNode.projected.y * currentCamera.zoom;

  return {
    ...currentCamera,
    panX: targetPanX,
    panY: targetPanY,
  };
}

export interface NetworkGestureState {
  active: boolean;
  mode: 'idle' | 'rotating' | 'panning';
  startX: number;
  startY: number;
  startCamera: NetworkCamera;
  pointerId: number | null;
  pointerType: string;
  exceededThreshold: boolean;
}

export function createInitialGestureState(camera: NetworkCamera): NetworkGestureState {
  return {
    active: false,
    mode: 'idle',
    startX: 0,
    startY: 0,
    startCamera: { ...camera },
    pointerId: null,
    pointerType: 'mouse',
    exceededThreshold: false,
  };
}

export function getGestureThreshold(pointerType: string): number {
  if (pointerType === 'touch') return GESTURE_THRESHOLD_TOUCH;
  if (pointerType === 'pen') return GESTURE_THRESHOLD_PEN;
  return GESTURE_THRESHOLD_MOUSE;
}

export function handleGesturePointerDown(
  params: {
    clientX: number;
    clientY: number;
    pointerId: number;
    pointerType: string;
    shiftKey?: boolean;
    button?: number;
    currentCamera: NetworkCamera;
  }
): NetworkGestureState {
  const isShiftOrMiddle = Boolean(params.shiftKey || params.button === 1 || params.button === 2);
  return {
    active: true,
    mode: isShiftOrMiddle ? 'panning' : 'rotating',
    startX: params.clientX,
    startY: params.clientY,
    startCamera: { ...params.currentCamera },
    pointerId: params.pointerId,
    pointerType: params.pointerType,
    exceededThreshold: false,
  };
}

export function handleGesturePointerMove(
  gesture: NetworkGestureState,
  clientX: number,
  clientY: number,
  currentCamera: NetworkCamera
): { gesture: NetworkGestureState; camera: NetworkCamera } {
  if (!gesture.active) {
    return { gesture, camera: currentCamera };
  }

  const dx = clientX - gesture.startX;
  const dy = clientY - gesture.startY;
  const threshold = getGestureThreshold(gesture.pointerType);
  const exceeded = gesture.exceededThreshold || Math.hypot(dx, dy) > threshold;

  const nextGesture: NetworkGestureState = {
    ...gesture,
    exceededThreshold: exceeded,
  };

  if (!exceeded) {
    return { gesture: nextGesture, camera: currentCamera };
  }

  if (gesture.mode === 'rotating') {
    return {
      gesture: nextGesture,
      camera: {
        ...currentCamera,
        yaw: wrapRotationAngle(gesture.startCamera.yaw - dx * ROTATION_SENSITIVITY),
        pitch: clampPitch(gesture.startCamera.pitch + dy * ROTATION_SENSITIVITY),
      },
    };
  }

  if (gesture.mode === 'panning') {
    return {
      gesture: nextGesture,
      camera: {
        ...currentCamera,
        panX: gesture.startCamera.panX + dx * PAN_SENSITIVITY,
        panY: gesture.startCamera.panY + dy * PAN_SENSITIVITY,
      },
    };
  }

  return { gesture: nextGesture, camera: currentCamera };
}

export function resetGestureState(camera?: NetworkCamera): NetworkGestureState {
  return {
    active: false,
    mode: 'idle',
    startX: 0,
    startY: 0,
    startCamera: camera
      ? { ...camera }
      : { yaw: DEFAULT_YAW, pitch: DEFAULT_PITCH, panX: 0, panY: 0, zoom: DEFAULT_ZOOM },
    pointerId: null,
    pointerType: 'mouse',
    exceededThreshold: false,
  };
}


