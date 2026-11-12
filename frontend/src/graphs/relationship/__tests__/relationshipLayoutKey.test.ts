import { describe, it, expect } from 'vitest';
import { computeRelationshipLayoutKey } from '../relationshipLayoutKey';
import { RelationshipLayoutResult, LayoutBounds } from '../relationshipLayout';

const makeBounds = (minX: number, maxX: number, minY: number, maxY: number): LayoutBounds => ({
  minX,
  maxX,
  minY,
  maxY,
  width: maxX - minX,
  height: maxY - minY,
  centerX: (minX + maxX) / 2,
  centerY: (minY + maxY) / 2,
});

describe('2D Relationship Layout Identity Key', () => {
  it('detects node replacement even when node count and bounds are identical', () => {
    const layoutA: RelationshipLayoutResult = {
      nodes: [
        { id: 'core', x: 0, y: 0 } as any,
        { id: 'auth', x: 100, y: 50 } as any,
      ],
      edges: [
        { sourceId: 'core', targetId: 'auth', edge: { relationship_kind: 'Direct' } } as any,
      ],
      bounds: makeBounds(0, 100, 0, 50),
      headers: [],
      isVertical: false,
    };

    const layoutB: RelationshipLayoutResult = {
      nodes: [
        { id: 'core', x: 0, y: 0 } as any,
        { id: 'session', x: 100, y: 50 } as any, // 'auth' -> 'session'
      ],
      edges: [
        { sourceId: 'core', targetId: 'session', edge: { relationship_kind: 'Direct' } } as any,
      ],
      bounds: makeBounds(0, 100, 0, 50), // Identical bounds & count
      headers: [],
      isVertical: false,
    };

    const keyA = computeRelationshipLayoutKey(layoutA);
    const keyB = computeRelationshipLayoutKey(layoutB);

    expect(keyA).not.toBe(keyB);
  });

  it('detects relationship kind or direction change', () => {
    const layoutA: RelationshipLayoutResult = {
      nodes: [
        { id: 'core', x: 0, y: 0 } as any,
        { id: 'db', x: 100, y: 50 } as any,
      ],
      edges: [
        { sourceId: 'core', targetId: 'db', edge: { relationship_kind: 'Direct' } } as any,
      ],
      bounds: makeBounds(0, 100, 0, 50),
      headers: [],
      isVertical: false,
    };

    const layoutB: RelationshipLayoutResult = {
      nodes: [
        { id: 'core', x: 0, y: 0 } as any,
        { id: 'db', x: 100, y: 50 } as any,
      ],
      edges: [
        { sourceId: 'core', targetId: 'db', edge: { relationship_kind: 'TypeOnly' } } as any,
      ],
      bounds: makeBounds(0, 100, 0, 50),
      headers: [],
      isVertical: false,
    };

    expect(computeRelationshipLayoutKey(layoutA)).not.toBe(computeRelationshipLayoutKey(layoutB));
  });

  it('produces identical key when topology and bounds are unchanged', () => {
    const layoutA: RelationshipLayoutResult = {
      nodes: [{ id: 'a', x: 0, y: 0 } as any, { id: 'b', x: 50, y: 50 } as any],
      edges: [{ sourceId: 'a', targetId: 'b', edge: { relationship_kind: 'Direct' } } as any],
      bounds: makeBounds(0, 50, 0, 50),
      headers: [],
      isVertical: false,
    };

    const layoutB: RelationshipLayoutResult = {
      nodes: [{ id: 'a', x: 0, y: 0 } as any, { id: 'b', x: 50, y: 50 } as any],
      edges: [{ sourceId: 'a', targetId: 'b', edge: { relationship_kind: 'Direct' } } as any],
      bounds: makeBounds(0, 50, 0, 50),
      headers: [],
      isVertical: false,
    };

    expect(computeRelationshipLayoutKey(layoutA)).toBe(computeRelationshipLayoutKey(layoutB));
  });

  describe('Finding E: Layout key invalidation and unadjusted camera refit trigger', () => {
    it('proves that old boundsKey formulation missed dependency replacements', () => {
      // Simulating old boundsKey formulation: `${minX}:${maxX}:${minY}:${maxY}:${nodes.length}`
      const oldBoundsKey = (layout: RelationshipLayoutResult) =>
        `${Math.round(layout.bounds.minX)}:${Math.round(layout.bounds.maxX)}:${Math.round(layout.bounds.minY)}:${Math.round(layout.bounds.maxY)}:${layout.nodes.length}`;

      const layoutA: RelationshipLayoutResult = {
        nodes: [{ id: 'focus', x: 0, y: 0 } as any, { id: 'depA', x: 270, y: 0 } as any],
        edges: [{ sourceId: 'focus', targetId: 'depA', edge: { relationship_kind: 'Import' } } as any],
        bounds: makeBounds(0, 270, 0, 60),
        headers: [],
        isVertical: false,
      };

      const layoutB: RelationshipLayoutResult = {
        nodes: [{ id: 'focus', x: 0, y: 0 } as any, { id: 'depB', x: 270, y: 0 } as any],
        edges: [{ sourceId: 'focus', targetId: 'depB', edge: { relationship_kind: 'Import' } } as any],
        bounds: makeBounds(0, 270, 0, 60),
        headers: [],
        isVertical: false,
      };

      // The old formulation produced identical keys (the defect!)
      expect(oldBoundsKey(layoutA)).toBe(oldBoundsKey(layoutB));

      // The corrected computeRelationshipLayoutKey distinguishes them
      expect(computeRelationshipLayoutKey(layoutA)).not.toBe(computeRelationshipLayoutKey(layoutB));
    });

    it('triggers refit when view is unadjusted and dependency is replaced', () => {
      let refitCount = 0;
      const fitToGraph = () => {
        refitCount++;
      };

      let hasUserAdjustedView = false;
      let previousState: { focusNodeId: string; boundsKey: string } | null = null;

      const handleLayoutUpdate = (focusNodeId: string, layout: RelationshipLayoutResult) => {
        const boundsKey = computeRelationshipLayoutKey(layout);
        const focusChanged = !previousState || previousState.focusNodeId !== focusNodeId;
        const layoutChanged = previousState !== null && previousState.boundsKey !== boundsKey;

        if (!focusChanged && !layoutChanged) return;

        previousState = { focusNodeId, boundsKey };

        if (focusChanged) {
          hasUserAdjustedView = false;
          fitToGraph();
        } else if (hasUserAdjustedView) {
          // User manually adjusted: preserve user framing, do not refit
        } else {
          // Unadjusted: automatically refit to reframe new dependencies
          fitToGraph();
        }
      };

      const layoutA: RelationshipLayoutResult = {
        nodes: [{ id: 'focus', x: 0, y: 0 } as any, { id: 'auth-v1', x: 270, y: 0 } as any],
        edges: [{ sourceId: 'focus', targetId: 'auth-v1', edge: { relationship_kind: 'Import' } } as any],
        bounds: makeBounds(0, 270, 0, 60),
        headers: [],
        isVertical: false,
      };

      // 1. Initial focus layout
      handleLayoutUpdate('focus', layoutA);
      expect(refitCount).toBe(1);

      // 2. Dependency replaced by auth-v2 (same node count, same bounds) while unadjusted
      const layoutB: RelationshipLayoutResult = {
        nodes: [{ id: 'focus', x: 0, y: 0 } as any, { id: 'auth-v2', x: 270, y: 0 } as any],
        edges: [{ sourceId: 'focus', targetId: 'auth-v2', edge: { relationship_kind: 'Import' } } as any],
        bounds: makeBounds(0, 270, 0, 60),
        headers: [],
        isVertical: false,
      };

      handleLayoutUpdate('focus', layoutB);
      // Key invalidation successfully triggers refit!
      expect(refitCount).toBe(2);

      // 3. User manually pans/zooms (adjusts view)
      hasUserAdjustedView = true;

      // 4. Another dependency replacement arrives
      const layoutC: RelationshipLayoutResult = {
        nodes: [{ id: 'focus', x: 0, y: 0 } as any, { id: 'auth-v3', x: 270, y: 0 } as any],
        edges: [{ sourceId: 'focus', targetId: 'auth-v3', edge: { relationship_kind: 'Import' } } as any],
        bounds: makeBounds(0, 270, 0, 60),
        headers: [],
        isVertical: false,
      };

      handleLayoutUpdate('focus', layoutC);
      // Because user manually adjusted view, refit is NOT called, preserving user viewport
      expect(refitCount).toBe(2);
    });
  });
});
