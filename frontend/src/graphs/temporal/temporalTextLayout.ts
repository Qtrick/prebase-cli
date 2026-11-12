export interface TemporalTextLayoutResult {
  summaryX: number;
  summaryWidth: number;
  displaySummary: string;
  metaX: number | null;
  metaWidth: number;
  displayMeta: string | null;
}

export interface ComputeTemporalTextLayoutParams {
  containerWidth: number;
  summaryX: number;
  summaryText: string;
  metaText: string;
  measureText: (text: string) => number;
}

/**
 * Computes responsive commit summary and metadata placement on the Temporal canvas:
 * 1. Prioritizes commit summary readability.
 * 2. Positions metadata dynamically so it never overflows narrow viewports (<800px)
 *    or collides with the summary text.
 * 3. Gracefully compacts and truncates according to available container width.
 */
export function computeTemporalTextLayout(
  params: ComputeTemporalTextLayoutParams
): TemporalTextLayoutResult {
  const { containerWidth, summaryX, summaryText, metaText, measureText } = params;

  // Leave 20px padding from the right canvas edge
  const availableWidth = Math.max(60, containerWidth - summaryX - 20);

  const truncate = (text: string, maxPx: number): { text: string; width: number } => {
    const measured = measureText(text);
    if (measured <= maxPx) return { text, width: measured };
    if (maxPx < 18) return { text: '…', width: measureText('…') };

    let low = 0;
    let high = text.length;
    let best = '…';
    let bestWidth = measureText(best);

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const cand = text.slice(0, mid) + '…';
      const w = measureText(cand);
      if (w <= maxPx) {
        best = cand;
        bestWidth = w;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return { text: best, width: bestWidth };
  };

  // Case 1: Spacious viewport (availableWidth >= 550)
  if (availableWidth >= 550) {
    const maxSummaryWidth = Math.min(540, availableWidth - 220);
    const summaryRes = truncate(summaryText, maxSummaryWidth);
    const metaX = summaryX + Math.max(summaryRes.width + 24, Math.min(360, maxSummaryWidth + 16));
    const maxMetaWidth = containerWidth - 20 - metaX;
    const metaRes = truncate(metaText, Math.max(60, maxMetaWidth));

    return {
      summaryX,
      summaryWidth: summaryRes.width,
      displaySummary: summaryRes.text,
      metaX,
      metaWidth: metaRes.width,
      displayMeta: metaRes.text,
    };
  }

  // Case 2: Moderate viewport (340 <= availableWidth < 550)
  if (availableWidth >= 340) {
    const summaryAlloc = Math.max(140, Math.floor(availableWidth * 0.58));
    const summaryRes = truncate(summaryText, summaryAlloc);
    const metaX = summaryX + summaryRes.width + 16;
    const remainingForMeta = containerWidth - 20 - metaX;

    if (remainingForMeta >= 80) {
      const metaRes = truncate(metaText, remainingForMeta);
      return {
        summaryX,
        summaryWidth: summaryRes.width,
        displaySummary: summaryRes.text,
        metaX,
        metaWidth: metaRes.width,
        displayMeta: metaRes.text,
      };
    }
  }

  // Case 3: Narrow or constrained canvas (availableWidth < 340 or insufficient room for metadata)
  // Commit summary is prioritized so commit message remains legible without awkward truncation.
  const summaryRes = truncate(summaryText, availableWidth);
  return {
    summaryX,
    summaryWidth: summaryRes.width,
    displaySummary: summaryRes.text,
    metaX: null,
    metaWidth: 0,
    displayMeta: null,
  };
}

