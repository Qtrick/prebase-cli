import { FileNode } from '../../../types/graph';

export interface ProjectedPoint {
  x: number;
  y: number;
  z: number;
  depthScale: number;
  normalizedDepth: number;
}

export const NETWORK_FOCAL_LENGTH = 1100;

export function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
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

