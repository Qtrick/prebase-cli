import { Point3D } from '../../../types/graph';
import { centerPositions, hash01, computeNetworkSphereRadius } from './networkNormalization';

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

export function layoutOrganic(
  nodes: LayoutNode[],
  links: LayoutLink[],
  config?: Partial<LayoutRuntimeConfig>
): Map<string, Point3D> {
  const n = nodes.length;
  const positions = new Map<string, Point3D>();
  if (n === 0) return positions;

  const sphereRadius = config?.sphereRadius ?? computeNetworkSphereRadius(n);
  const forceStrength = config?.forceStrength ?? 1.0;

  const degree = new Map<string, number>();
  for (const node of nodes) {
    degree.set(node.id, 0);
  }
  for (const link of links) {
    degree.set(link.source, (degree.get(link.source) ?? 0) + 1);
    degree.set(link.target, (degree.get(link.target) ?? 0) + 1);
  }

  const maxDeg = Math.max(1, ...degree.values());
  const maxR = sphereRadius * 0.82;
  const minDist = Math.max(16, sphereRadius / Math.max(6, Math.sqrt(n) * 1.25));
  const linkIdeal = minDist * 2.2;
  const zSpread = sphereRadius * 0.15;

  for (const node of nodes) {
    const d = degree.get(node.id) ?? 0;
    const hubT = d / maxDeg;
    const r = maxR * (0.08 + 0.62 * (1 - hubT) + hash01(node.id, 3) * 0.22);
    const angle = hash01(node.id, 1) * Math.PI * 2 + hash01(node.id, 9) * 0.4;
    const zT = hash01(`${node.id}|z`, 5) * 0.55 + hash01(node.id, 17) * 0.45;
    positions.set(node.id, {
      x: Math.cos(angle) * r,
      y: Math.sin(angle) * r * (0.92 + hash01(node.id, 4) * 0.16),
      z: (zT - 0.5) * zSpread,
    });
  }

  const ids = [...positions.keys()];
  const iterations = Math.min(100, 45 + Math.floor(n * 0.4));

  for (let iter = 0; iter < iterations; iter++) {
    const cooling = 1 - iter / iterations;

    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = positions.get(ids[i])!;
        const b = positions.get(ids[j])!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dz = b.z - a.z;
        let dist = Math.hypot(dx, dy, dz);
        if (dist < 0.001) {
          dx = hash01(ids[i], j) - 0.5;
          dy = hash01(ids[j], i) - 0.5;
          dz = hash01(`${ids[i]}|${ids[j]}`, iter) - 0.5;
          dist = Math.hypot(dx, dy, dz) || 0.15;
        }
        if (dist < minDist) {
          const push = ((minDist - dist) / dist) * 0.6 * cooling;
          a.x -= dx * push;
          a.y -= dy * push;
          a.z -= dz * push;
          b.x += dx * push;
          b.y += dy * push;
          b.z += dz * push;
        } else if (dist < minDist * 2.5) {
          const push = ((minDist * 2.5 - dist) / dist) * 0.12 * cooling;
          a.x -= dx * push;
          a.y -= dy * push;
          a.z -= dz * push;
          b.x += dx * push;
          b.y += dy * push;
          b.z += dz * push;
        }
      }
    }

    for (const link of links) {
      const s = positions.get(link.source);
      const t = positions.get(link.target);
      if (!s || !t) continue;
      const dx = t.x - s.x;
      const dy = t.y - s.y;
      const dz = t.z - s.z;
      const dist = Math.hypot(dx, dy, dz) || 0.001;
      const pull = ((dist - linkIdeal) / dist) * 0.055 * forceStrength * cooling;
      s.x += dx * pull;
      s.y += dy * pull;
      s.z += dz * pull;
      t.x -= dx * pull;
      t.y -= dy * pull;
      t.z -= dz * pull;
    }

    for (const p of positions.values()) {
      const d = Math.hypot(p.x, p.y, p.z);
      if (d < minDist * 0.4) {
        const k = (minDist * 0.4 - d) / (d || 0.1);
        p.x -= p.x * k * 0.5;
        p.y -= p.y * k * 0.5;
        p.z -= p.z * k * 0.5;
      }
      if (d > maxR) {
        const k = (d - maxR) / d;
        p.x *= 1 - k * 0.9;
        p.y *= 1 - k * 0.9;
        p.z *= 1 - k * 0.9;
      }
    }
  }

  centerPositions(positions);
  return positions;
}

