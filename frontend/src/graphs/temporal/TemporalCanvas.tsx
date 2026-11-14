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
import { computeTemporalTextLayout } from './temporalTextLayout';

interface TemporalCanvasProps {
  commits: CommitSummary[];
  selectedCommitHash: string | null;
  onSelectCommit: (commit: CommitSummary | null) => void;
  isFiltered?: boolean;
  fitViewTrigger?: number;
  resetViewTrigger?: number;
  theme?: 'dark' | 'light';
}

export const TemporalCanvas: React.FC<TemporalCanvasProps> = ({
  commits,
  selectedCommitHash,
  onSelectCommit,
  isFiltered,
  fitViewTrigger,
  resetViewTrigger,
  theme = 'dark',
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

  // Fit View helper: scales horizontally to fit tracks & text without squishing vertical timeline (Defect 5.9)
  const fitView = useCallback(() => {
    if (!containerRef.current || layout.nodes.length === 0) return;
    const width = containerRef.current.clientWidth || 800;

    const pad = 60;
    const graphWidth = Math.max(100, layout.bounds.width);
    const scaleX = (width - pad * 2) / graphWidth;
    const k = Math.min(1.0, Math.max(0.65, scaleX));

    const x = pad + 10;
    const y = pad;

    setTransform({ x, y, k });
  }, [layout]);

  // Initial fit view ONLY on first commits load (preserve camera transform during pagination! Defect 5.8)
  const hasInitializedViewRef = useRef(false);
  useEffect(() => {
    if (commits.length > 0 && !hasInitializedViewRef.current) {
      hasInitializedViewRef.current = true;
      fitView();
    }
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

  // Expose deterministic debug API for automated browser verification (parity with NetworkCanvas)
  useEffect(() => {
    if (typeof window !== 'undefined') {
      (window as any).__prebaseTemporalDebug = {
        getLayout: () => layout,
        getTransform: () => ({ ...transform }),
        getScreenPosition: (commitIndex: number) => {
          if (commitIndex < 0 || commitIndex >= layout.nodes.length) return null;
          const node = layout.nodes[commitIndex];
          return {
            x: transform.x + node.x * transform.k,
            y: transform.y + node.y * transform.k,
            node,
          };
        },
      };
    }
    return () => {
      if (typeof window !== 'undefined') {
        delete (window as any).__prebaseTemporalDebug;
      }
    };
  }, [layout, transform]);

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

    const isLight = theme === 'light';

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
        ctx.globalAlpha = isLight ? 0.2 : 0.3;
        ctx.fill();
        ctx.globalAlpha = 1.0;
      }

      // Inner circle
      ctx.beginPath();
      ctx.arc(item.x, item.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = isSelected ? (isLight ? '#0284c7' : '#ffffff') : color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = isSelected ? (isLight ? '#0284c7' : color) : (isLight ? '#ffffff' : '#0f172a');
      ctx.stroke();

      // 3. Draw text and badges on the right side of the lanes
      const textStartX = MARGIN_LEFT + (Math.max(1, item.lane) + 1.2) * 36 + 20;

      // Hash Badge
      const badgeWidth = 64;
      const badgeHeight = 20;
      const badgeX = textStartX;
      const badgeY = item.y - badgeHeight / 2;

      ctx.fillStyle = isSelected
        ? (isLight ? 'rgba(2, 132, 199, 0.15)' : 'rgba(56, 189, 248, 0.25)')
        : (isLight ? 'rgba(241, 245, 249, 0.95)' : 'rgba(30, 41, 59, 0.8)');
      ctx.strokeStyle = isSelected
        ? (isLight ? '#0284c7' : '#38bdf8')
        : (isLight ? 'rgba(203, 213, 225, 0.8)' : 'rgba(71, 85, 105, 0.6)');
      ctx.lineWidth = 1;
      roundRect(ctx, badgeX, badgeY, badgeWidth, badgeHeight, 4);
      ctx.fill();
      ctx.stroke();

      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
      ctx.fillStyle = isSelected
        ? (isLight ? '#0284c7' : '#38bdf8')
        : (isLight ? '#475569' : '#94a3b8');
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.fillText(item.commit.short_hash, badgeX + badgeWidth / 2, item.y);

      // Commit summary title
      const summaryX = badgeX + badgeWidth + 12;
      ctx.textAlign = 'left';
      ctx.font = isSelected
        ? '600 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
        : '500 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.fillStyle = isSelected
        ? (isLight ? '#0f172a' : '#f8fafc')
        : (isLight ? '#1e293b' : '#e2e8f0');

      // Responsive commit summary and author placement
      const containerWidth = containerRef.current?.clientWidth || 900;
      const relTime = formatRelativeTime(item.commit.author_timestamp);
      const metaText = `${item.commit.author_name} • ${relTime}`;
      const textLayout = computeTemporalTextLayout({
        containerWidth,
        summaryX,
        summaryText: item.commit.summary,
        metaText,
        measureText: (txt: string) => ctx.measureText(txt).width,
      });

      ctx.fillText(textLayout.displaySummary, textLayout.summaryX, item.y);

      // Render author & relative date if space permits without clipping
      if (textLayout.metaX !== null && textLayout.displayMeta) {
        ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.fillStyle = isLight ? '#475569' : '#94a3b8';
        ctx.fillText(textLayout.displayMeta, textLayout.metaX, item.y);
      }
    }

    ctx.restore();
  }, [layout, transform, selectedCommitHash, hoveredHash, theme]);

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

  const scrollCommitIntoView = (targetNode: LayoutCommit) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const height = canvas.clientHeight || 600;
    setTransform((prev) => {
      const screenY = prev.y + targetNode.y * prev.k;
      if (screenY < 60) {
        return {
          ...prev,
          y: 80 - targetNode.y * prev.k,
        };
      } else if (screenY > height - 80) {
        return {
          ...prev,
          y: height - 100 - targetNode.y * prev.k,
        };
      }
      return prev;
    });
  };

  // Keyboard navigation for accessible commit selection
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (layout.nodes.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const currentIndex = layout.nodes.findIndex((n) => n.commit.hash === selectedCommitHash);
      if (currentIndex === -1) {
        onSelectCommit(layout.nodes[0].commit);
        scrollCommitIntoView(layout.nodes[0]);
      } else if (currentIndex < layout.nodes.length - 1) {
        const nextNode = layout.nodes[currentIndex + 1];
        onSelectCommit(nextNode.commit);
        scrollCommitIntoView(nextNode);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const currentIndex = layout.nodes.findIndex((n) => n.commit.hash === selectedCommitHash);
      if (currentIndex === -1) {
        const lastNode = layout.nodes[layout.nodes.length - 1];
        onSelectCommit(lastNode.commit);
        scrollCommitIntoView(lastNode);
      } else if (currentIndex > 0) {
        const prevNode = layout.nodes[currentIndex - 1];
        onSelectCommit(prevNode.commit);
        scrollCommitIntoView(prevNode);
      }
    } else if (e.key === 'Home') {
      e.preventDefault();
      onSelectCommit(layout.nodes[0].commit);
      scrollCommitIntoView(layout.nodes[0]);
    } else if (e.key === 'End') {
      e.preventDefault();
      const lastNode = layout.nodes[layout.nodes.length - 1];
      onSelectCommit(lastNode.commit);
      scrollCommitIntoView(lastNode);
    } else if (e.key === 'Escape') {
      if (selectedCommitHash) {
        e.preventDefault();
        onSelectCommit(null);
      }
    }
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
      <canvas
        ref={canvasRef}
        className="temporal-canvas"
        tabIndex={0}
        role="application"
        aria-label="Git commit history DAG"
        aria-description="Use ArrowUp and ArrowDown to navigate commits, Home/End for start/end, Escape to deselect, mouse drag to pan timeline, mouse wheel to zoom, and click to inspect commit details."
        onKeyDown={handleKeyDown}
      />
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

