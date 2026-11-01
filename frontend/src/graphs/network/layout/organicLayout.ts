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
  config?: Partial<LayoutRuntimeConfig>,
  existingPositions?: Map<string, Point3D>
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
  const zSpread = sphereRadius * 0.72;

  // Build adjacency to place new nodes near connected existing nodes
  const neighbors = new Map<string, string[]>();
  for (const link of links) {
    if (!neighbors.has(link.source)) neighbors.set(link.source, []);
    if (!neighbors.has(link.target)) neighbors.set(link.target, []);
    neighbors.get(link.source)!.push(link.target);
    neighbors.get(link.target)!.push(link.source);
  }

  const isNewNode = new Set<string>();

  for (const node of nodes) {
    if (existingPositions && existingPositions.has(node.id)) {
      const p = existingPositions.get(node.id)!;
      positions.set(node.id, { x: p.x, y: p.y, z: p.z });
    } else {
      isNewNode.add(node.id);
      // If new node has connected neighbors with known positions, place near their center
      const connected = (neighbors.get(node.id) || [])
        .map((nid) => (existingPositions ? existingPositions.get(nid) : positions.get(nid)))
        .filter((pos): pos is Point3D => pos !== undefined);

      if (connected.length > 0) {
        let avgX = 0, avgY = 0, avgZ = 0;
        for (const p of connected) {
          avgX += p.x;
          avgY += p.y;
          avgZ += p.z;
        }
        avgX /= connected.length;
        avgY /= connected.length;
        avgZ /= connected.length;

        const jitter = minDist * 0.75;
        const jAngle = hash01(node.id, 1) * Math.PI * 2;
        positions.set(node.id, {
          x: avgX + Math.cos(jAngle) * jitter,
          y: avgY + Math.sin(jAngle) * jitter,
          z: avgZ + (hash01(node.id, 7) - 0.5) * (zSpread * 0.5),
        });
      } else {
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
    }
  }

  const ids = [...positions.keys()];
  const hasExisting = Boolean(existingPositions && existingPositions.size > 0);
  const iterations = hasExisting
    ? Math.min(35, 15 + Math.floor(isNewNode.size * 2))
    : Math.min(100, 45 + Math.floor(n * 0.4));

  for (let iter = 0; iter < iterations; iter++) {
    const cooling = 1 - iter / iterations;

    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const idA = ids[i];
        const idB = ids[j];

        // Skip pairwise repulsion between two existing nodes if preserving layout
        if (hasExisting && !isNewNode.has(idA) && !isNewNode.has(idB)) {
          continue;
        }

        const a = positions.get(idA)!;
        const b = positions.get(idB)!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dz = b.z - a.z;
        let dist = Math.hypot(dx, dy, dz);
        if (dist < 0.001) {
          dx = hash01(idA, j) - 0.5;
          dy = hash01(idB, i) - 0.5;
          dz = hash01(`${idA}|${idB}`, iter) - 0.5;
          dist = Math.hypot(dx, dy, dz) || 0.15;
        }

        const weightA = isNewNode.has(idA) ? 1.0 : (hasExisting ? 0.05 : 0.5);
        const weightB = isNewNode.has(idB) ? 1.0 : (hasExisting ? 0.05 : 0.5);

        if (dist < minDist) {
          const push = ((minDist - dist) / dist) * 0.6 * cooling;
          a.x -= dx * push * weightA;
          a.y -= dy * push * weightA;
          a.z -= dz * push * weightA;
          b.x += dx * push * weightB;
          b.y += dy * push * weightB;
          b.z += dz * push * weightB;
        } else if (dist < minDist * 2.5) {
          const push = ((minDist * 2.5 - dist) / dist) * 0.12 * cooling;
          a.x -= dx * push * weightA;
          a.y -= dy * push * weightA;
          a.z -= dz * push * weightA;
          b.x += dx * push * weightB;
          b.y += dy * push * weightB;
          b.z += dz * push * weightB;
        }
      }
    }

    for (const link of links) {
      if (hasExisting && !isNewNode.has(link.source) && !isNewNode.has(link.target)) {
        continue;
      }
      const s = positions.get(link.source);
      const t = positions.get(link.target);
      if (!s || !t) continue;
      const dx = t.x - s.x;
      const dy = t.y - s.y;
      const dz = t.z - s.z;
      const dist = Math.hypot(dx, dy, dz) || 0.001;
      const pull = ((dist - linkIdeal) / dist) * 0.055 * forceStrength * cooling;

      const weightS = isNewNode.has(link.source) ? 1.0 : (hasExisting ? 0.05 : 0.5);
      const weightT = isNewNode.has(link.target) ? 1.0 : (hasExisting ? 0.05 : 0.5);

      s.x += dx * pull * weightS;
      s.y += dy * pull * weightS;
      s.z += dz * pull * weightS;
      t.x -= dx * pull * weightT;
      t.y -= dy * pull * weightT;
      t.z -= dz * pull * weightT;
    }

    // Keep within spherical bound
    for (const [id, p] of positions.entries()) {
      if (hasExisting && !isNewNode.has(id)) continue;
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

  // Only perform global centering on fresh layout to preserve user viewport and spatial orientation
  if (!hasExisting) {
    centerPositions(positions);
  }

  return positions;
}
