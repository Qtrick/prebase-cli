import { Point3D } from '../../../types/graph';
import {
  centerPositions,
  fibonacciShell,
  minimumShellRadius,
  relaxLinksTowardDistance,
  computeNetworkSphereRadius,
} from './networkNormalization';

export interface LayoutNode {
  id: string;
  areaId?: string;
  val?: number;
  isEntry?: boolean;
}

export interface LayoutLink {
  source: string;
  target: string;
}

export interface LayoutRuntimeConfig {
  sphereRadius: number;
  collisionRadius: number;
  linkDistance: number;
  forceStrength: number;
}

export const DEFAULT_SPHERE_LAYOUT_CONFIG: LayoutRuntimeConfig = {
  sphereRadius: 260,
  collisionRadius: 24,
  linkDistance: 80,
  forceStrength: 0.35,
};

/**
 * Computes deterministic 3D anchors on the sphere for a set of architectural areas.
 */
export function computeAreaAnchors(
  areaIds: readonly string[],
  sphereRadius: number
): Map<string, Point3D> {
  const anchors = new Map<string, Point3D>();
  const k = areaIds.length;
  if (k === 0) return anchors;
  if (k === 1) {
    anchors.set(areaIds[0], { x: 0, y: 0, z: -sphereRadius });
    return anchors;
  }
  const sorted = [...areaIds].sort((a, b) => a.localeCompare(b));
  for (let i = 0; i < k; i++) {
    const areaId = sorted[i];
    const t = (i + 0.5) / k;
    const y = 1 - 2 * t;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = (Math.PI * (3 - Math.sqrt(5))) * i;
    anchors.set(areaId, {
      x: Math.cos(theta) * ring * sphereRadius,
      y: y * sphereRadius,
      z: Math.sin(theta) * ring * sphereRadius,
    });
  }
  return anchors;
}

/**
 * Tight geometric shell — Hierarchical community-aware spherical distribution.
 * If nodes provide areaId with 2 or more distinct areas, clusters files tightly around
 * their canonical architectural area anchors on the sphere.
 * Preserves the iconic 3D sphere silhouette and guarantees the 3D centroid is at (0, 0, 0).
 */
export function layoutSphere(
  nodes: readonly LayoutNode[],
  links: readonly LayoutLink[],
  config?: Partial<LayoutRuntimeConfig>,
  existingPositions?: Map<string, Point3D>
): Map<string, Point3D> {
  const n = nodes.length;
  if (n === 0) return new Map();

  const cfg: LayoutRuntimeConfig = {
    sphereRadius: config?.sphereRadius ?? computeNetworkSphereRadius(n),
    collisionRadius: config?.collisionRadius ?? DEFAULT_SPHERE_LAYOUT_CONFIG.collisionRadius,
    linkDistance: config?.linkDistance ?? DEFAULT_SPHERE_LAYOUT_CONFIG.linkDistance,
    forceStrength: config?.forceStrength ?? DEFAULT_SPHERE_LAYOUT_CONFIG.forceStrength,
  };

  const shellRadius = Math.max(
    cfg.sphereRadius * 0.58,
    minimumShellRadius(n, cfg.collisionRadius * 2)
  );

  // Group nodes by architectural area if present
  const areaGroups = new Map<string, LayoutNode[]>();
  for (const node of nodes) {
    const aId = node.areaId || '__default__';
    let list = areaGroups.get(aId);
    if (!list) {
      list = [];
      areaGroups.set(aId, list);
    }
    list.push(node);
  }

  const distinctAreas = Array.from(areaGroups.keys()).filter((a) => a !== '__default__');
  const useHierarchicalClustering = distinctAreas.length >= 2;

  // 1. Hierarchical area-anchored spherical layout
  if (useHierarchicalClustering) {
    const areaAnchors = computeAreaAnchors(distinctAreas, shellRadius);
    const positions = new Map<string, Point3D>();
    const pinnedIds = new Set<string>();

    for (const [areaId, areaNodes] of areaGroups.entries()) {
      const anchor = areaAnchors.get(areaId) || { x: 0, y: 0, z: -shellRadius };
      const anchorDist = Math.hypot(anchor.x, anchor.y, anchor.z) || 1;
      const nx = anchor.x / anchorDist;
      const ny = anchor.y / anchorDist;
      const nz = anchor.z / anchorDist;

      // Orthonormal tangent basis (t1, t2) perpendicular to anchor normal n
      let t1x: number, t1y: number, t1z: number;
      if (Math.abs(ny) < 0.9) {
        const len = Math.hypot(-nz, nx) || 1;
        t1x = -nz / len;
        t1y = 0;
        t1z = nx / len;
      } else {
        const len = Math.hypot(0, -nz, ny) || 1;
        t1x = 0;
        t1y = -nz / len;
        t1z = ny / len;
      }
      const t2x = ny * t1z - nz * t1y;
      const t2y = nz * t1x - nx * t1z;
      const t2z = nx * t1y - ny * t1x;

      const nArea = areaNodes.length;
      // Cap radius scales with proportional file count
      const capRadius = shellRadius * Math.min(0.42, 0.15 + 0.28 * Math.sqrt(nArea / n));
      const goldenAngle = Math.PI * (3 - Math.sqrt(5));

      // Hub and entry candidate files placed closest to area anchor
      const sortedAreaNodes = [...areaNodes].sort((a, b) => {
        if (a.isEntry) return -1;
        if (b.isEntry) return 1;
        return (b.val || 0) - (a.val || 0);
      });

      for (let j = 0; j < nArea; j++) {
        const node = sortedAreaNodes[j];
        const existing = existingPositions?.get(node.id);
        if (existing) {
          positions.set(node.id, { x: existing.x, y: existing.y, z: existing.z });
          pinnedIds.add(node.id);
          continue;
        }

        const r = capRadius * Math.sqrt((j + 0.5) / nArea);
        const phi = j * goldenAngle;
        const cosP = Math.cos(phi);
        const sinP = Math.sin(phi);

        const vx = r * (cosP * t1x + sinP * t2x);
        const vy = r * (cosP * t1y + sinP * t2y);
        const vz = r * (cosP * t1z + sinP * t2z);

        const rawX = anchor.x + vx;
        const rawY = anchor.y + vy;
        const rawZ = anchor.z + vz;
        const rawLen = Math.hypot(rawX, rawY, rawZ) || 1;

        positions.set(node.id, {
          x: (rawX / rawLen) * shellRadius,
          y: (rawY / rawLen) * shellRadius,
          z: (rawZ / rawLen) * shellRadius,
        });
      }
    }

    relaxLinksTowardDistance(
      positions,
      links,
      cfg.linkDistance,
      2,
      cfg.forceStrength * 0.012,
      pinnedIds
    );
    centerPositions(positions);
    for (const [id, p] of positions.entries()) {
      const len = Math.hypot(p.x, p.y, p.z) || 1;
      positions.set(id, {
        x: (p.x / len) * shellRadius,
        y: (p.y / len) * shellRadius,
        z: (p.z / len) * shellRadius,
      });
    }
    return positions;
  }

  // 2. Uniform Fibonacci spherical shell fallback (for single-area or unpartitioned nodes)
  if (existingPositions && existingPositions.size > 0) {
    const positions = new Map<string, Point3D>();
    const missingNodes: LayoutNode[] = [];

    for (const node of nodes) {
      const existing = existingPositions.get(node.id);
      if (existing) {
        positions.set(node.id, { x: existing.x, y: existing.y, z: existing.z });
      } else {
        missingNodes.push(node);
      }
    }

    if (missingNodes.length > 0) {
      const newPos = fibonacciShell(missingNodes, shellRadius, () => 1);
      for (const [id, p] of newPos) {
        positions.set(id, p);
      }
    }

    const pinnedIds = new Set(existingPositions.keys());
    relaxLinksTowardDistance(
      positions,
      links,
      cfg.linkDistance,
      2,
      cfg.forceStrength * 0.012,
      pinnedIds
    );
    return positions;
  }

  const positions = fibonacciShell(nodes, shellRadius, () => 1);
  relaxLinksTowardDistance(
    positions,
    links,
    cfg.linkDistance,
    2,
    cfg.forceStrength * 0.012
  );
  centerPositions(positions);
  return positions;
}
