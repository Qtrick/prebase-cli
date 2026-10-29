import { Point3D } from '../../../types/graph';

export function hash01(str: string, seed: number): number {
  let h = (seed * 2654435761) ^ 0xdeadbeef;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 1597334677);
  }
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

export function centerPositions(positions: Map<string, Point3D>): void {
  const n = positions.size;
  if (n === 0) return;

  let sx = 0, sy = 0, sz = 0;
  for (const p of positions.values()) {
    sx += p.x;
    sy += p.y;
    sz += p.z;
  }
  const cx = sx / n;
  const cy = sy / n;
  const cz = sz / n;

  for (const p of positions.values()) {
    p.x -= cx;
    p.y -= cy;
    p.z -= cz;
  }
}

export function computeNetworkSphereRadius(nodeCount: number, spreadMultiplier = 1.0): number {
  const base = Math.max(120, Math.sqrt(nodeCount) * 48);
  return base * spreadMultiplier;
}

