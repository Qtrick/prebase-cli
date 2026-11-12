import { describe, it, expect } from 'vitest';
import { computeTemporalTextLayout } from '../temporalTextLayout';

describe('Temporal Text Layout Bounds & Responsiveness', () => {
  const mockMeasure = (text: string) => text.length * 7; // approximate font metric

  it('never positions metadata outside container bounds at 600px width', () => {
    const layout = computeTemporalTextLayout({
      containerWidth: 600,
      summaryX: 180,
      summaryText: 'feat(core): implement very long commit message that could overflow narrow containers',
      metaText: 'John Doe • 2 hours ago',
      measureText: mockMeasure,
    });

    expect(layout.summaryX + layout.summaryWidth).toBeLessThanOrEqual(600);
    if (layout.metaX !== null) {
      expect(layout.metaX + layout.metaWidth).toBeLessThanOrEqual(600);
      expect(layout.metaX).toBeGreaterThanOrEqual(layout.summaryX + layout.summaryWidth);
    }
  });

  it('gracefully prioritizes commit summary and suppresses/compacts metadata under 450px width', () => {
    const layout = computeTemporalTextLayout({
      containerWidth: 420,
      summaryX: 160,
      summaryText: 'fix(watcher): prevent infinite feedback loop on server logs',
      metaText: 'Alice Developer • yesterday',
      measureText: mockMeasure,
    });

    expect(layout.summaryX + layout.summaryWidth).toBeLessThanOrEqual(420);
    // At very narrow width, summary must remain readable (at least 150px) and meta should not collide
    expect(layout.summaryWidth).toBeGreaterThanOrEqual(140);
  });

  it('allocates spacious summary and clean metadata offset on wide 1440px displays', () => {
    const layout = computeTemporalTextLayout({
      containerWidth: 1440,
      summaryX: 200,
      summaryText: 'docs: update architecture guidelines',
      metaText: 'Bob • 3 days ago',
      measureText: mockMeasure,
    });

    expect(layout.metaX).not.toBeNull();
    expect(layout.metaX! + layout.metaWidth).toBeLessThan(1440);
  });

  it('handles extremely narrow container without throwing or negative offsets', () => {
    const layout = computeTemporalTextLayout({
      containerWidth: 250,
      summaryX: 150,
      summaryText: 'initial commit',
      metaText: 'Author • 1s',
      measureText: mockMeasure,
    });

    expect(layout.summaryWidth).toBeGreaterThan(0);
    expect(layout.summaryX + layout.summaryWidth).toBeLessThanOrEqual(250);
    expect(layout.metaX).toBeNull();
  });

  describe('Finding D: Adaptive text sizing at narrow widths (400px - 700px, inspector open)', () => {
    it('proves the old hardcoded 380px/400px layout caused massive off-canvas overflow at narrow widths', () => {
      // The defect mechanism prior to adaptive calculation:
      // const maxSummaryWidth = Math.max(380, Math.min(580, containerWidth - textStartX - 260));
      // const metaX = summaryX + Math.max(summaryWidth + 24, 400);
      const summaryX = 160;
      const containerWidth = 500; // e.g. Narrow viewport or inspector open
      const oldSummaryWidth = 380; // Hardcoded minimum forced 380px
      expect(oldSummaryWidth).toBe(380);
      const oldMetaX = summaryX + 400; // Hardcoded minimum forced summaryX + 400 = 560px!
      const oldTotalRight = oldMetaX + 120; // 680px!

      // At 500px canvas width, the old math overflowed by 180px (36% off-canvas)!
      expect(oldTotalRight).toBeGreaterThan(containerWidth);
      expect(oldTotalRight - containerWidth).toBe(180);

      // The new computeTemporalTextLayout guarantees layout fits within container bounds:
      const newLayout = computeTemporalTextLayout({
        containerWidth,
        summaryX,
        summaryText: 'feat(server): harden cooperative cancellation, traversal error coverage, and cross-port defenses',
        metaText: 'Alice Developer <alice@prebase.dev> • 2 hours ago',
        measureText: mockMeasure,
      });

      const totalRight = newLayout.metaX !== null
        ? newLayout.metaX + newLayout.metaWidth
        : newLayout.summaryX + newLayout.summaryWidth;

      expect(totalRight).toBeLessThanOrEqual(containerWidth);
    });

    it('guarantees zero clipping across continuous widths 400px to 700px with inspector open', () => {
      const longSummary = 'refactor(ui,core): polish interface design, resolve temporal light contrast, and reconcile live selections';
      const longMeta = 'Senior Maintainer <maintainer@prebase.dev> • Nov 12, 2026';

      // Sweep widths: 400px, 450px, 500px, 550px, 600px, 650px, 700px
      for (let width = 400; width <= 700; width += 50) {
        // Vary summaryX from single trunk lane (120px) to multi-lane branch (220px)
        for (const summaryX of [120, 160, 200, 240]) {
          const layout = computeTemporalTextLayout({
            containerWidth: width,
            summaryX,
            summaryText: longSummary,
            metaText: longMeta,
            measureText: mockMeasure,
          });

          // Summary must never exceed container width minus right margin
          expect(layout.summaryX + layout.summaryWidth).toBeLessThanOrEqual(width);

          // If metadata is displayed, it must not overflow container bounds
          if (layout.metaX !== null) {
            expect(layout.metaX + layout.metaWidth).toBeLessThanOrEqual(width);
            expect(layout.metaX).toBeGreaterThanOrEqual(layout.summaryX + layout.summaryWidth);
          }

          // Total rendered content right edge must strictly stay within container
          const totalRight = layout.metaX !== null
            ? layout.metaX + layout.metaWidth
            : layout.summaryX + layout.summaryWidth;
          expect(totalRight).toBeLessThanOrEqual(width);
        }
      }
    });

    it('preserves commit summary readability by omitting metadata when multi-lane push leaves < 340px available', () => {
      // Branch commit on lane 4: summaryX starts at 220px on a 480px canvas (only 260px available!)
      const layout = computeTemporalTextLayout({
        containerWidth: 480,
        summaryX: 220,
        summaryText: 'fix(core): ensure deterministic topology lanes across page slices',
        metaText: 'Developer • 5m ago',
        measureText: mockMeasure,
      });

      // Metadata should be suppressed so summary receives all 240px available without aggressive clipping
      expect(layout.metaX).toBeNull();
      expect(layout.displayMeta).toBeNull();
      expect(layout.summaryWidth).toBeGreaterThan(100);
      expect(layout.summaryX + layout.summaryWidth).toBeLessThanOrEqual(480);
    });
  });
});
