import { RelationshipLayoutResult } from './relationshipLayout';

/**
 * Computes a structural identity key for a 2D relationship layout.
 * Evaluates node identities, edge endpoints/kinds, and spatial bounds
 * to detect topology changes even when node count and bounding box dimensions coincide.
 */
export function computeRelationshipLayoutKey(layout: RelationshipLayoutResult): string {
  const nodeIds = layout.nodes.map((n) => n.id).sort().join(',');
  const edgeKeys = layout.edges
    .map((e) => `${e.sourceId}->${e.targetId}:${e.edge.relationship_kind}`)
    .sort()
    .join(';');
  const b = layout.bounds;
  return `${nodeIds}|${edgeKeys}|${Math.round(b.minX)}:${Math.round(b.maxX)}:${Math.round(b.minY)}:${Math.round(b.maxY)}`;
}

