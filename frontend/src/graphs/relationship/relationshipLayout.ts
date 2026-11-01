import { DependencyEdge, FileNode, RelationshipKind } from '../../types/graph';
import {
  RelationshipGraphData,
  RelationshipRole,
} from './relationshipTypes';

export interface LayoutPort {
  x: number;
  y: number;
}

export interface LayoutNode {
  id: string;
  role: RelationshipRole;
  x: number; // center x
  y: number; // center y
  width: number;
  height: number;
  node: FileNode;
  isFocus: boolean;
  columnIndex: number;
  rowIndex: number;
  inPort: LayoutPort;
  outPort: LayoutPort;
}

export interface LayoutEdge {
  id: string;
  sourceId: string;
  targetId: string;
  edge: DependencyEdge;
  startX: number;
  startY: number;
  cp1X: number;
  cp1Y: number;
  cp2X: number;
  cp2Y: number;
  endX: number;
  endY: number;
  arrowAngle: number;
  isMutual: boolean;
  isSelfLoop: boolean;
  relationshipKind: RelationshipKind;
}

export interface LayoutBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

export interface LayoutColumnHeader {
  role: RelationshipRole;
  columnIndex: number;
  title: string;
  subtitle: string;
  x: number;
  y: number;
  width: number;
  omittedCount: number;
  totalCount: number;
}

export interface RelationshipLayoutResult {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  bounds: LayoutBounds;
  headers: LayoutColumnHeader[];
  isVertical: boolean;
}

const FOCUS_WIDTH = 230;
const FOCUS_HEIGHT = 56;
const NEIGHBOR_WIDTH = 196;
const NEIGHBOR_HEIGHT = 44;
const COL_SPACING = 270;
const ROW_GAP = 14;
const HEADER_OFFSET_Y = 50;

export function computeRelationshipLayout(
  graphData: RelationshipGraphData,
  viewport: { width: number; height: number }
): RelationshipLayoutResult {
  const isVertical = viewport.width > 0 && viewport.width < 640;

  if (!graphData.focusNode || graphData.nodes.length === 0) {
    return {
      nodes: [],
      edges: [],
      bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0, width: 0, height: 0, centerX: 0, centerY: 0 },
      headers: [],
      isVertical,
    };
  }

  const layoutNodes: LayoutNode[] = [];
  const nodesById = new Map<string, LayoutNode>();
  const headers: LayoutColumnHeader[] = [];

  if (!isVertical) {
    // -------------------------------------------------------------------------
    // HORIZONTAL 3-to-5 COLUMN LAYOUT (Dependents -> Focus -> Dependencies)
    // -------------------------------------------------------------------------
    for (const col of graphData.columns) {
      const colX = col.columnIndex * COL_SPACING;
      const count = col.nodes.length;
      const isFocusCol = col.role === 'focus';
      const cardWidth = isFocusCol ? FOCUS_WIDTH : NEIGHBOR_WIDTH;
      const cardHeight = isFocusCol ? FOCUS_HEIGHT : NEIGHBOR_HEIGHT;

      const totalHeight = count > 0 ? count * cardHeight + (count - 1) * ROW_GAP : cardHeight;
      const startY = -totalHeight / 2 + cardHeight / 2;

      col.nodes.forEach((relNode, rIdx) => {
        const y = startY + rIdx * (cardHeight + ROW_GAP);
        const lNode: LayoutNode = {
          id: relNode.node.id,
          role: relNode.role,
          x: colX,
          y,
          width: cardWidth,
          height: cardHeight,
          node: relNode.node,
          isFocus: isFocusCol,
          columnIndex: col.columnIndex,
          rowIndex: rIdx,
          inPort: { x: colX - cardWidth / 2, y },
          outPort: { x: colX + cardWidth / 2, y },
        };
        layoutNodes.push(lNode);
        nodesById.set(lNode.id, lNode);
      });

      // Position column header above highest node or at default top offset
      const topY = count > 0 ? startY - cardHeight / 2 - HEADER_OFFSET_Y : -HEADER_OFFSET_Y;
      headers.push({
        role: col.role,
        columnIndex: col.columnIndex,
        title: col.title,
        subtitle: col.subtitle,
        x: colX,
        y: topY,
        width: cardWidth,
        omittedCount: col.omittedCount,
        totalCount: col.totalCount,
      });
    }
  } else {
    // -------------------------------------------------------------------------
    // VERTICAL FALLBACK LAYOUT (Dependents (top) -> Focus (mid) -> Dependencies (bot))
    // -------------------------------------------------------------------------
    const ROW_SPACING = 180;
    const HORIZONTAL_GAP = 14;

    for (const col of graphData.columns) {
      // Invert columnIndex so dependents are negative (top) and dependencies are positive (bottom)
      const rowY = col.columnIndex * ROW_SPACING;
      const count = col.nodes.length;
      const isFocusCol = col.role === 'focus';
      const cardWidth = isFocusCol ? FOCUS_WIDTH : NEIGHBOR_WIDTH;
      const cardHeight = isFocusCol ? FOCUS_HEIGHT : NEIGHBOR_HEIGHT;

      const totalWidth = count > 0 ? count * cardWidth + (count - 1) * HORIZONTAL_GAP : cardWidth;
      const startX = -totalWidth / 2 + cardWidth / 2;

      col.nodes.forEach((relNode, cIdx) => {
        const x = startX + cIdx * (cardWidth + HORIZONTAL_GAP);
        const lNode: LayoutNode = {
          id: relNode.node.id,
          role: relNode.role,
          x,
          y: rowY,
          width: cardWidth,
          height: cardHeight,
          node: relNode.node,
          isFocus: isFocusCol,
          columnIndex: col.columnIndex,
          rowIndex: cIdx,
          inPort: { x, y: rowY - cardHeight / 2 },
          outPort: { x, y: rowY + cardHeight / 2 },
        };
        layoutNodes.push(lNode);
        nodesById.set(lNode.id, lNode);
      });

      headers.push({
        role: col.role,
        columnIndex: col.columnIndex,
        title: col.title,
        subtitle: col.subtitle,
        x: 0,
        y: rowY - cardHeight / 2 - 28,
        width: Math.max(totalWidth, cardWidth),
        omittedCount: col.omittedCount,
        totalCount: col.totalCount,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // EDGE ROUTING WITH DIRECTION-AWARE BEZIER CURVES
  // ---------------------------------------------------------------------------
  const layoutEdges: LayoutEdge[] = [];

  for (const relEdge of graphData.edges) {
    const srcNode = nodesById.get(relEdge.edge.source_file_id);
    const tgtNode = nodesById.get(relEdge.edge.target_file_id);
    if (!srcNode || !tgtNode) continue;

    if (relEdge.isSelfLoop) {
      // Self loop above card
      const loopY = srcNode.y - srcNode.height / 2;
      const startX = srcNode.x - 24;
      const startY = loopY;
      const endX = srcNode.x + 24;
      const endY = loopY;
      const cp1X = srcNode.x - 48;
      const cp1Y = loopY - 40;
      const cp2X = srcNode.x + 48;
      const cp2Y = loopY - 40;

      layoutEdges.push({
        id: relEdge.edge.id,
        sourceId: srcNode.id,
        targetId: tgtNode.id,
        edge: relEdge.edge,
        startX,
        startY,
        cp1X,
        cp1Y,
        cp2X,
        cp2Y,
        endX,
        endY,
        arrowAngle: Math.PI / 2, // pointing down into the card
        isMutual: false,
        isSelfLoop: true,
        relationshipKind: relEdge.edge.relationship_kind,
      });
      continue;
    }

    if (!isVertical) {
      // Horizontal mode
      const isForward = srcNode.x < tgtNode.x;
      let startX: number, startY: number, endX: number, endY: number;
      let cp1X: number, cp1Y: number, cp2X: number, cp2Y: number;
      let arrowAngle = 0;

      if (isForward) {
        // Standard forward dependency: Left -> Right
        startX = srcNode.outPort.x;
        startY = srcNode.outPort.y;
        endX = tgtNode.inPort.x;
        endY = tgtNode.inPort.y;

        const dx = Math.max(30, (endX - startX) * 0.45);
        // Vertical curvature adjustment for mutual edges
        const yOffset = relEdge.isMutual ? (srcNode.id < tgtNode.id ? -16 : 16) : 0;

        cp1X = startX + dx;
        cp1Y = startY + yOffset;
        cp2X = endX - dx;
        cp2Y = endY + yOffset;
        arrowAngle = Math.atan2(endY - cp2Y, endX - cp2X);
      } else if (srcNode.x === tgtNode.x) {
        // Same column lateral edge (e.g. between two dependents)
        startX = srcNode.outPort.x;
        startY = srcNode.outPort.y;
        endX = tgtNode.outPort.x;
        endY = tgtNode.outPort.y;

        const loopOffset = 50 + Math.abs(srcNode.y - tgtNode.y) * 0.15;
        cp1X = startX + loopOffset;
        cp1Y = startY;
        cp2X = endX + loopOffset;
        cp2Y = endY;
        arrowAngle = Math.atan2(endY - cp2Y, endX - cp2X);
      } else {
        // Reverse edge: Right -> Left (Cycle or feedback loop)
        startX = srcNode.inPort.x;
        startY = srcNode.inPort.y;
        endX = tgtNode.outPort.x;
        endY = tgtNode.outPort.y;

        const arcY = Math.min(startY, endY) - 50;
        cp1X = startX - 40;
        cp1Y = arcY;
        cp2X = endX + 40;
        cp2Y = arcY;
        arrowAngle = Math.atan2(endY - cp2Y, endX - cp2X);
      }

      layoutEdges.push({
        id: relEdge.edge.id,
        sourceId: srcNode.id,
        targetId: tgtNode.id,
        edge: relEdge.edge,
        startX,
        startY,
        cp1X,
        cp1Y,
        cp2X,
        cp2Y,
        endX,
        endY,
        arrowAngle,
        isMutual: relEdge.isMutual,
        isSelfLoop: false,
        relationshipKind: relEdge.edge.relationship_kind,
      });
    } else {
      // Vertical mode
      const startX = srcNode.outPort.x;
      const startY = srcNode.outPort.y;
      const endX = tgtNode.inPort.x;
      const endY = tgtNode.inPort.y;

      const dy = Math.max(30, Math.abs(endY - startY) * 0.45);
      const cp1X = startX;
      const cp1Y = startY + (endY > startY ? dy : -dy);
      const cp2X = endX;
      const cp2Y = endY - (endY > startY ? dy : -dy);
      const arrowAngle = Math.atan2(endY - cp2Y, endX - cp2X);

      layoutEdges.push({
        id: relEdge.edge.id,
        sourceId: srcNode.id,
        targetId: tgtNode.id,
        edge: relEdge.edge,
        startX,
        startY,
        cp1X,
        cp1Y,
        cp2X,
        cp2Y,
        endX,
        endY,
        arrowAngle,
        isMutual: relEdge.isMutual,
        isSelfLoop: false,
        relationshipKind: relEdge.edge.relationship_kind,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // BOUNDS CALCULATION
  // ---------------------------------------------------------------------------
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const node of layoutNodes) {
    minX = Math.min(minX, node.x - node.width / 2);
    maxX = Math.max(maxX, node.x + node.width / 2);
    minY = Math.min(minY, node.y - node.height / 2);
    maxY = Math.max(maxY, node.y + node.height / 2);
  }

  for (const h of headers) {
    minX = Math.min(minX, h.x - h.width / 2);
    maxX = Math.max(maxX, h.x + h.width / 2);
    minY = Math.min(minY, h.y - 30);
  }

  if (minX === Infinity) {
    minX = 0;
    maxX = 0;
    minY = 0;
    maxY = 0;
  }

  const bounds: LayoutBounds = {
    minX,
    maxX,
    minY,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
  };

  return {
    nodes: layoutNodes,
    edges: layoutEdges,
    bounds,
    headers,
    isVertical,
  };
}
