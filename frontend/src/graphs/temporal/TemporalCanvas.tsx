import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { CommitSummary } from '../../types/temporal';
import { Transform, Point2D } from '../../types/graph';
import {
  computeTemporalLayout,
  formatRelativeTime,
  getLaneColor,
  LayoutCommit,
  MARGIN_LEFT,
  ROW_HEIGHT,
} from './temporalLayout';

interface TemporalCanvasProps {
  commits: CommitSummary[];
  selectedCommitHash: string | null;
  onSelectCommit: (commit: CommitSummary | null) => void;
  isFiltered?: boolean;
  fitViewTrigger?: number;
  resetViewTrigger?: number;
}

export const TemporalCanvas: React.FC<TemporalCanvasProps> = ({
  commits,
  selectedCommitHash,
  onSelectCommit,
  isFiltered,
  fitViewTrigger,
  resetViewTrigger,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, k: 1 });
  const [hoveredHash, setHoveredHash] = useState<string | null>(null);

  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<Point2D>({ x: 0, y: 0 });
  const initialTransformRef = useRef<Transform>({ x: 0, y: 0, k: 1 });
  const didDragRef = useRef(false);

  const layout = useMemo(() => computeTemporalLayout(commits, isFiltered), [commits, isFiltered]);

  // Fit View helper
  const fitView = useCallback(() => {
    if (!containerRef.current || layout.nodes.length === 0) return;
    const width = containerRef.current.clientWidth || 800;
    const height = containerRef.current.clientHeight || 600;

    const pad = 60;
    const graphWidth = Math.max(100, layout.bounds.width);
    const graphHeight = Math.max(100, layout.bounds.height);

    const scaleX = (width - pad * 2) / graphWidth;
    const scaleY = (height - pad * 2) / graphHeight;
    const k = Math.min(1.2, Math.max(0.4, Math.min(scaleX, scaleY)));

    const x = pad + 20;
    const y = pad;

    setTransform({ x, y, k });
  }, [layout]);

  // Initial fit view on commits load
  useEffect(() => {
    fitView();
  }, [commits, fitView]);

  // External trigger for fit view
  useEffect(() => {
    if (fitViewTrigger && fitViewTrigger > 0) {
      fitView();
    }
  }, [fitViewTrigger, fitView]);

  // External trigger for reset view
  useEffect(() => {
    if (resetViewTrigger && resetViewTrigger > 0) {
      if (containerRef.current) {
        setTransform({ x: MARGIN_LEFT, y: 40, k: 1 });
      }
    }
  }, [resetViewTrigger]);

  // Demand-driven canvas rendering (zero idle CPU usage)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 800;
    const height = canvas.clientHeight || 600;

    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    // Camera transform
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.k, transform.k);

    // 1. Draw commit edges (branch, merge lines, and stubs)
    for (const edge of layout.edges) {
      ctx.beginPath();
      ctx.strokeStyle = getLaneColor(edge.lane);
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';

      const isHighlighted =
        edge.fromHash === selectedCommitHash ||
        edge.toHash === selectedCommitHash ||
        edge.fromHash === hoveredHash ||
        edge.toHash === hoveredHash;

      ctx.globalAlpha = isHighlighted ? 1.0 : 0.65;
      if (isHighlighted) {
        ctx.lineWidth = 3.5;
      }

      if (edge.isDashed) {
        ctx.setLineDash([4, 4]);
      } else {
        ctx.setLineDash([]);
      }

      if (edge.isStub) {
        ctx.moveTo(edge.fromX, edge.fromY);
        ctx.lineTo(edge.toX, edge.toY);
        ctx.stroke();
        // Continuation stub dot
        ctx.beginPath();
        ctx.arc(edge.toX, edge.toY, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = getLaneColor(edge.lane);
        ctx.fill();
      } else if (Math.abs(edge.fromX - edge.toX) < 1) {
        // Straight line down the same lane
        ctx.moveTo(edge.fromX, edge.fromY);
        ctx.lineTo(edge.toX, edge.toY);
        ctx.stroke();
      } else {
        // Smooth Bézier curve for branch or merge
        ctx.moveTo(edge.fromX, edge.fromY);
        const cpY1 = edge.fromY + (edge.toY - edge.fromY) * 0.5;
        const cpY2 = edge.fromY + (edge.toY - edge.fromY) * 0.5;
        ctx.bezierCurveTo(edge.fromX, cpY1, edge.toX, cpY2, edge.toX, edge.toY);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    ctx.globalAlpha = 1.0;

    // 2. Draw commit nodes & labels
    for (let i = 0; i < layout.nodes.length; i++) {
      const item = layout.nodes[i];
      const isSelected = item.commit.hash === selectedCommitHash;
      const isHovered = item.commit.hash === hoveredHash;
      const color = getLaneColor(item.lane);

      // Node circle
      const radius = isSelected ? 8 : isHovered ? 7 : 5.5;

      // Outer glow on select/hover
      if (isSelected || isHovered) {
        ctx.beginPath();
        ctx.arc(item.x, item.y, radius + 5, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.3;
        ctx.fill();
        ctx.globalAlpha = 1.0;
      }

      // Inner circle
      ctx.beginPath();
      ctx.arc(item.x, item.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = isSelected ? '#ffffff' : color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = isSelected ? color : '#0f172a';
      ctx.stroke();

      // 3. Draw text and badges on the right side of the lanes
      const textStartX = MARGIN_LEFT + (Math.max(1, item.lane) + 1.2) * 36 + 20;

      // Hash Badge
      const badgeWidth = 64;
      const badgeHeight = 20;
      const badgeX = textStartX;
      const badgeY = item.y - badgeHeight / 2;

      ctx.fillStyle = isSelected ? 'rgba(56, 189, 248, 0.25)' : 'rgba(30, 41, 59, 0.8)';
      ctx.strokeStyle = isSelected ? '#38bdf8' : 'rgba(71, 85, 105, 0.6)';
      ctx.lineWidth = 1;
      roundRect(ctx, badgeX, badgeY, badgeWidth, badgeHeight, 4);
      ctx.fill();
      ctx.stroke();

      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
      ctx.fillStyle = isSelected ? '#38bdf8' : '#94a3b8';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.fillText(item.commit.short_hash, badgeX + badgeWidth / 2, item.y);

      // Commit summary title
      const summaryX = badgeX + badgeWidth + 12;
      ctx.textAlign = 'left';
      ctx.font = isSelected
        ? '600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
        : '500 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.fillStyle = isSelected ? '#f8fafc' : '#e2e8f0';

      const maxSummaryWidth = 360;
      const summaryText = truncateText(ctx, item.commit.summary, maxSummaryWidth);
      ctx.fillText(summaryText, summaryX, item.y);

      // Author & Relative Date
      const metaX = summaryX + 380;
      ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.fillStyle = '#64748b';
      const relTime = formatRelativeTime(item.commit.author_timestamp);
      ctx.fillText(`${item.commit.author_name} • ${relTime}`, metaX, item.y);
    }

    ctx.restore();
  }, [layout, transform, selectedCommitHash, hoveredHash]);

  // Coordinate projection from screen to world
  const toWorld = useCallback(
    (screenX: number, screenY: number): Point2D => {
      return {
        x: (screenX - transform.x) / transform.k,
        y: (screenY - transform.y) / transform.k,
      };
    },
    [transform]
  );

  // Hit-testing for commit nodes
  const hitTest = useCallback(
    (worldX: number, worldY: number): LayoutCommit | null => {
      for (const node of layout.nodes) {
        // Test commit node dot
        const dist = Math.hypot(node.x - worldX, node.y - worldY);
        if (dist <= 14) return node;

        // Test label row hit area
        if (
          worldX >= node.x - 10 &&
          worldX <= node.x + 800 &&
          worldY >= node.y - ROW_HEIGHT / 2 &&
          worldY <= node.y + ROW_HEIGHT / 2
        ) {
          return node;
        }
      }
      return null;
    },
    [layout.nodes]
  );

  // Mouse drag & pan
  const handleMouseDown = (e: React.MouseEvent) => {
    isDraggingRef.current = true;
    didDragRef.current = false;
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    initialTransformRef.current = { ...transform };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (isDraggingRef.current) {
      const dx = e.clientX - dragStartRef.current.x;
      const dy = e.clientY - dragStartRef.current.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        didDragRef.current = true;
      }
      setTransform({
        x: initialTransformRef.current.x + dx,
        y: initialTransformRef.current.y + dy,
        k: initialTransformRef.current.k,
      });
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const world = toWorld(screenX, screenY);
    const hit = hitTest(world.x, world.y);

    if (hit) {
      setHoveredHash(hit.commit.hash);
      canvas.style.cursor = 'pointer';
    } else {
      setHoveredHash(null);
      canvas.style.cursor = 'grab';
    }
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    isDraggingRef.current = false;
    const canvas = canvasRef.current;
    if (canvas) canvas.style.cursor = 'default';

    if (!didDragRef.current) {
      const rect = canvas?.getBoundingClientRect();
      if (!rect) return;
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;
      const world = toWorld(screenX, screenY);
      const hit = hitTest(world.x, world.y);

      if (hit) {
        onSelectCommit(hit.commit);
      } else {
        onSelectCommit(null);
      }
    }
  };

  // Zoom on wheel
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const zoomFactor = e.deltaY < 0 ? 1.12 : 0.88;
    const newK = Math.max(0.2, Math.min(3.0, transform.k * zoomFactor));

    const worldX = (mouseX - transform.x) / transform.k;
    const worldY = (mouseY - transform.y) / transform.k;

    setTransform({
      x: mouseX - worldX * newK,
      y: mouseY - worldY * newK,
      k: newK,
    });
  };

  return (
    <div
      ref={containerRef}
      className="temporal-canvas-container"
      style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onWheel={handleWheel}
    >
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
    </div>
  );
};

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function truncateText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) {
    return text;
  }
  let current = text;
  while (current.length > 4 && ctx.measureText(current + '…').width > maxWidth) {
    current = current.slice(0, -1);
  }
  return current + '…';
}

