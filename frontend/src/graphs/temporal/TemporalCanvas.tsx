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
  LANE_WIDTH,
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
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, k: 1 });
  const [hoveredHash, setHoveredHash] = useState<string | null>(null);

  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<Point2D>({ x: 0, y: 0 });
  const initialTransformRef = useRef<Transform>({ x: 0, y: 0, k: 1 });
  const initialScrollTopRef = useRef<number>(0);
  const didDragRef = useRef(false);

  const layout = useMemo(() => computeTemporalLayout(commits, isFiltered), [commits, isFiltered]);

  // Fit View helper: aligns view to top without squishing vertical timeline or altering scale
  const fitView = useCallback(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTo({ top: 0, behavior: 'smooth' });
    }
    setTransform({ x: 0, y: 0, k: 1.0 });
  }, []);

  // Initial fit view ONLY on first commits load (preserve scroll position during pagination!)
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
      fitView();
    }
  }, [resetViewTrigger, fitView]);

  // Synchronize native vertical scrolling with canvas camera transform
  const handleNativeScroll = useCallback(() => {
    if (!scrollContainerRef.current) return;
    const scrollTop = scrollContainerRef.current.scrollTop;
    setTransform((prev) => ({
      x: prev.x,
      y: -scrollTop,
      k: 1.0, // Strict scale invariance (zero wheel-based zoom scaling)
    }));
  }, []);

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
    const maxLane = layout.nodes.reduce((max, n) => Math.max(max, n.lane), 0);
    const laneAreaWidth = (maxLane + 1) * LANE_WIDTH;
    const textStartX = MARGIN_LEFT + laneAreaWidth + 14;

    for (let i = 0; i < layout.nodes.length; i++) {
      const item = layout.nodes[i];
      const isSelected = item.commit.hash === selectedCommitHash;
      const isHovered = item.commit.hash === hoveredHash;
      const color = getLaneColor(item.lane);

      // Selected row subtle background highlight
      if (isSelected) {
        ctx.fillStyle = isLight ? 'rgba(0, 0, 0, 0.04)' : 'rgba(255, 255, 255, 0.04)';
        ctx.fillRect(0, item.y - ROW_HEIGHT / 2, width, ROW_HEIGHT);
      }

      // Node circle
      const radius = isSelected ? 7 : isHovered ? 6.5 : 5;

      // Outer ring on select/hover
      if (isSelected || isHovered) {
        ctx.beginPath();
        ctx.arc(item.x, item.y, radius + 4, 0, Math.PI * 2);
        ctx.strokeStyle = isSelected
          ? (isLight ? '#4f46e5' : '#818cf8')
          : (isLight ? 'rgba(0, 0, 0, 0.15)' : 'rgba(255, 255, 255, 0.2)');
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // Inner circle
      ctx.beginPath();
      ctx.arc(item.x, item.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = isSelected ? (isLight ? '#4f46e5' : '#818cf8') : color;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = isLight ? '#ffffff' : '#0e1526';
      ctx.stroke();

      // 3. Draw text and badges on the right side of the lanes
      // Hash Badge
      const badgeWidth = 60;
      const badgeHeight = 19;
      const badgeX = textStartX;
      const badgeY = item.y - badgeHeight / 2;

      ctx.fillStyle = isSelected
        ? (isLight ? 'rgba(79, 70, 229, 0.12)' : 'rgba(99, 102, 241, 0.20)')
        : (isLight ? '#f1f5f9' : '#141d33');
      ctx.strokeStyle = isSelected
        ? (isLight ? 'rgba(79, 70, 229, 0.5)' : 'rgba(99, 102, 241, 0.55)')
        : (isLight ? '#e2e8f0' : '#232f48');
      ctx.lineWidth = 1;
      roundRect(ctx, badgeX, badgeY, badgeWidth, badgeHeight, 4);
      ctx.fill();
      ctx.stroke();

      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
      ctx.fillStyle = isSelected
        ? (isLight ? '#4f46e5' : '#818cf8')
        : (isLight ? '#334155' : '#94a3b8');
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
        ? (isLight ? '#202023' : '#ededef')
        : (isLight ? '#38383e' : '#d4d4d8');

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
        ctx.fillStyle = isLight ? '#85858e' : '#71717a';
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
    initialScrollTopRef.current = scrollContainerRef.current ? scrollContainerRef.current.scrollTop : 0;
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
      if (scrollContainerRef.current) {
        scrollContainerRef.current.scrollTop = initialScrollTopRef.current - dy;
      }
      setTransform((prev) => ({
        ...prev,
        x: initialTransformRef.current.x + dx,
      }));
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

  const scrollCommitIntoView = (targetNode: LayoutCommit) => {
    if (!scrollContainerRef.current) return;
    const height = scrollContainerRef.current.clientHeight || 600;
    const targetY = Math.max(0, targetNode.y - height / 2);
    scrollContainerRef.current.scrollTo({ top: targetY, behavior: 'smooth' });
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
    >
      <div
        ref={scrollContainerRef}
        className="temporal-scroll-container"
        style={{
          width: '100%',
          height: '100%',
          overflowY: 'auto',
          overflowX: 'hidden',
          position: 'relative',
        }}
        onScroll={handleNativeScroll}
      >
        <canvas
          ref={canvasRef}
          className="temporal-canvas"
          tabIndex={0}
          role="application"
          aria-label="Git commit history DAG"
          aria-description="Use ArrowUp and ArrowDown to navigate commits, Home and End to jump, Enter or Click to inspect commit details."
          style={{
            position: 'sticky',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            display: 'block',
          }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onKeyDown={handleKeyDown}
        />
        <div
          className="temporal-scroll-spacer"
          style={{
            height: Math.max(layout.bounds.height + 120, 600),
            width: '100%',
            position: 'relative',
            pointerEvents: 'none',
          }}
        />
      </div>
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

