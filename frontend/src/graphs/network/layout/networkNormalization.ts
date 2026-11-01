import { Point3D } from '../../../types/graph';

export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export function hash01(str: string, seed = 0): number {
  let h = (seed * 2654435761) ^ 0xdeadbeef;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 1597334677);
  }
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

export function clampToSphere(p: Point3D, maxRadius: number): Point3D {
  const d = Math.hypot(p.x, p.y, p.z);
  if (d <= maxRadius || d === 0) {
    return p;
  }
  const k = maxRadius / d;
  return { x: p.x * k, y: p.y * k, z: p.z * k };
}

/** Conservative shell radius needed for evenly distributed points at a given separation. */
export function minimumShellRadius(nodeCount: number, minimumDistance: number): number {
  if (nodeCount <= 1) {
    return 0;
  }
  return minimumDistance * Math.sqrt(nodeCount / (4 * Math.PI)) * 1.28;
}

export function centerPositions(positions: Map<string, Point3D>): void {
  const n = positions.size;
  if (n === 0) return;

  let sx = 0,
    sy = 0,
    sz = 0;
  for (const p of positions.values()) {
    sx += p.x;
    sy += p.y;
    sz += p.z;
  }
  const inv = 1 / n;
  sx *= inv;
  sy *= inv;
  sz *= inv;

  for (const [id, p] of positions) {
    positions.set(id, { x: p.x - sx, y: p.y - sy, z: p.z - sz });
  }
}

export function computeNetworkSphereRadius(nodeCount: number, spreadMultiplier = 1.0): number {
  const base = Math.max(140, Math.min(360, Math.sqrt(Math.max(1, nodeCount)) * 36));
  return base * spreadMultiplier;
}

/**
 * Bounded spring relaxation. Pulls or pushes linked nodes toward a target distance.
 */
export function relaxLinksTowardDistance(
  positions: Map<string, Point3D>,
  links: readonly { source: string; target: string }[],
  linkDistance: number,
  passes: number,
  strength: number,
  pinnedIds: ReadonlySet<string> = new Set<string>()
): void {
  for (let pass = 0; pass < passes; pass++) {
    for (const link of links) {
      const s = positions.get(link.source);
      const t = positions.get(link.target);
      if (!s || !t) continue;

      let dx = t.x - s.x;
      let dy = t.y - s.y;
      let dz = t.z - s.z;
      let distance = Math.hypot(dx, dy, dz);

      if (distance < 1e-6) {
        const angle = hash01(`${link.source}|${link.target}`, pass) * Math.PI * 2;
        dx = Math.cos(angle);
        dy = Math.sin(angle);
        dz = hash01(`${link.target}|${link.source}`, pass) - 0.5;
        distance = Math.hypot(dx, dy, dz) || 0.1;
      }

      const amount = ((distance - linkDistance) / distance) * strength;
      const sourcePinned = pinnedIds.has(link.source);
      const targetPinned = pinnedIds.has(link.target);
      const sourceShare = sourcePinned ? 0 : targetPinned ? 1 : 0.5;
      const targetShare = targetPinned ? 0 : sourcePinned ? 1 : 0.5;

      s.x += dx * amount * sourceShare;
      s.y += dy * amount * sourceShare;
      s.z += dz * amount * sourceShare;
      t.x -= dx * amount * targetShare;
      t.y -= dy * amount * targetShare;
      t.z -= dz * amount * targetShare;
    }
  }
}

/**
 * Distributes nodes evenly along a spherical Fibonacci shell.
 */
export function fibonacciShell<T extends { id: string }>(
  nodes: readonly T[],
  sphereRadius: number,
  radialFn: (node: T, index: number, total: number) => number = () => 1
): Map<string, Point3D> {
  const positions = new Map<string, Point3D>();
  const n = nodes.length;
  if (n === 0) return positions;

  for (let i = 0; i < n; i++) {
    const node = nodes[i];
    const t = (i + 0.5) / Math.max(1, n);
    const y = 1 - 2 * t;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = GOLDEN_ANGLE * i;
    const radial = sphereRadius * radialFn(node, i, n);

    positions.set(
      node.id,
      clampToSphere(
        {
          x: Math.cos(theta) * ring * radial,
          y: y * radial * 0.95,
          z: Math.sin(theta) * ring * radial,
        },
        sphereRadius
      )
    );
  }

  return positions;
}
