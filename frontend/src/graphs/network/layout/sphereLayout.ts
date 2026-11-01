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
 * Tight geometric shell — Fibonacci spherical distribution with minimal relaxation.
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

  // If preserving existing positions during incremental revision:
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
      const shellRadius = Math.max(
        cfg.sphereRadius * 0.58,
        minimumShellRadius(n, cfg.collisionRadius * 2)
      );
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
    // Preserves existing node world positions without layout thrashing
    return positions;
  }

  // Full layout from scratch:
  const shellRadius = Math.max(
    cfg.sphereRadius * 0.58,
    minimumShellRadius(n, cfg.collisionRadius * 2)
  );

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
