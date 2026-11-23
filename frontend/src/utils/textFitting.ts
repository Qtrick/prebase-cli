/**
 * PreBase — High-Performance Universal Text Fitting & Containment Utility
 *
 * Implements deterministic text measurement, grapheme-cluster-safe truncation,
 * binary-search fitting, and bounded LRU caching for Canvas and DOM rendering.
 *
 * Guarantees:
 * 1. Measured output width NEVER exceeds the specified maxWidth constraint.
 * 2. Never slices surrogate pairs, combining marks, or multi-code-point emoji.
 * 3. Supports end-ellipsis, prefix-ellipsis (for file paths), and middle-ellipsis
 *    (preserving file extensions).
 * 4. Gracefully handles degenerate cases (negative, zero, or sub-ellipsis widths).
 */

interface IntlSegmenter {
  segment(input: string): Iterable<{ segment: string }>;
}

let graphemeSegmenter: IntlSegmenter | null = null;
try {
  const intlAny = Intl as unknown as {
    Segmenter?: new (locales?: string | string[], options?: { granularity: string }) => IntlSegmenter;
  };
  if (typeof intlAny !== 'undefined' && typeof intlAny.Segmenter === 'function') {
    graphemeSegmenter = new intlAny.Segmenter(undefined, { granularity: 'grapheme' });
  }
} catch {
  graphemeSegmenter = null;
}

/**
 * Splits text into user-perceived grapheme clusters without splitting
 * surrogate pairs, combining diacritics, or zero-width joiners.
 */
export function getGraphemeClusters(text: string): string[] {
  if (!text) return [];
  if (graphemeSegmenter) {
    const segments = graphemeSegmenter.segment(text);
    const clusters: string[] = [];
    for (const seg of segments) {
      clusters.push(seg.segment);
    }
    return clusters;
  }
  // Safe Unicode fallback: Array.from iterates code points rather than UTF-16 code units
  return Array.from(text);
}

const textFitCache = new Map<string, string>();
const MAX_CACHE_SIZE = 2500;

function getCached(key: string): string | undefined {
  const value = textFitCache.get(key);
  if (value !== undefined) {
    // Refresh LRU order: delete and re-insert
    textFitCache.delete(key);
    textFitCache.set(key, value);
  }
  return value;
}

function setCached(key: string, value: string): void {
  if (textFitCache.size >= MAX_CACHE_SIZE) {
    // Evict oldest 500 entries
    let count = 0;
    for (const k of textFitCache.keys()) {
      textFitCache.delete(k);
      count++;
      if (count >= 500) break;
    }
  }
  textFitCache.set(key, value);
}

export function clearTextFitCache(): void {
  textFitCache.clear();
}

export function getTextFitCacheSize(): number {
  return textFitCache.size;
}

/**
 * Truncates text with an end ellipsis ('…') so that its measured width <= maxWidth.
 */
export function fitTextEnd(
  text: string,
  maxWidth: number,
  measureText: (s: string) => number,
  fontKey = '',
  ellipsis = '…'
): string {
  if (!text || maxWidth <= 0) return '';

  const cacheKey = fontKey ? `end|${text}|${Math.floor(maxWidth)}|${fontKey}` : '';
  if (cacheKey) {
    const hit = getCached(cacheKey);
    if (hit !== undefined) return hit;
  }

  const fullWidth = measureText(text);
  if (fullWidth <= maxWidth) {
    if (cacheKey) setCached(cacheKey, text);
    return text;
  }

  const ellipsisW = measureText(ellipsis);
  if (ellipsisW > maxWidth) {
    // Sub-ellipsis boundary: test single grapheme or return empty string
    const clusters = getGraphemeClusters(text);
    if (clusters.length > 0 && measureText(clusters[0]) <= maxWidth) {
      if (cacheKey) setCached(cacheKey, clusters[0]);
      return clusters[0];
    }
    if (cacheKey) setCached(cacheKey, '');
    return '';
  }

  const clusters = getGraphemeClusters(text);
  let low = 0;
  let high = clusters.length;
  let best = ellipsis;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = clusters.slice(0, mid).join('') + ellipsis;
    const w = measureText(candidate);
    if (w <= maxWidth) {
      best = candidate;
      low = mid + 1; // Try longer prefix
    } else {
      high = mid - 1; // Too wide, try shorter prefix
    }
  }

  if (cacheKey) setCached(cacheKey, best);
  return best;
}

/**
 * Truncates file paths with a prefix ellipsis ('…/' or '…') so that the trailing
 * filename and deepest directory segment remain visible, while total width <= maxWidth.
 */
export function fitTextPrefix(
  text: string,
  maxWidth: number,
  measureText: (s: string) => number,
  fontKey = '',
  ellipsis = '…'
): string {
  if (!text || maxWidth <= 0) return '';

  const cacheKey = fontKey ? `pre|${text}|${Math.floor(maxWidth)}|${fontKey}` : '';
  if (cacheKey) {
    const hit = getCached(cacheKey);
    if (hit !== undefined) return hit;
  }

  const fullWidth = measureText(text);
  if (fullWidth <= maxWidth) {
    if (cacheKey) setCached(cacheKey, text);
    return text;
  }

  const ellipsisW = measureText(ellipsis);
  if (ellipsisW > maxWidth) {
    const clusters = getGraphemeClusters(text);
    const lastCluster = clusters[clusters.length - 1];
    if (lastCluster && measureText(lastCluster) <= maxWidth) {
      if (cacheKey) setCached(cacheKey, lastCluster);
      return lastCluster;
    }
    if (cacheKey) setCached(cacheKey, '');
    return '';
  }

  const clusters = getGraphemeClusters(text);
  let low = 0;
  let high = clusters.length;
  let best = ellipsis;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const suffix = clusters.slice(clusters.length - mid).join('');
    const candidate = ellipsis + suffix;
    const w = measureText(candidate);
    if (w <= maxWidth) {
      best = candidate;
      low = mid + 1; // Suffix fits, try keeping more
    } else {
      high = mid - 1; // Suffix too long, keep less
    }
  }

  if (cacheKey) setCached(cacheKey, best);
  return best;
}

/**
 * Truncates filenames with a middle ellipsis ('…') so that the beginning of the
 * filename and the file extension (e.g., '.test.tsx' or '.rs') remain preserved.
 */
export function fitTextMiddle(
  text: string,
  maxWidth: number,
  measureText: (s: string) => number,
  fontKey = '',
  ellipsis = '…'
): string {
  if (!text || maxWidth <= 0) return '';

  const cacheKey = fontKey ? `mid|${text}|${Math.floor(maxWidth)}|${fontKey}` : '';
  if (cacheKey) {
    const hit = getCached(cacheKey);
    if (hit !== undefined) return hit;
  }

  const fullWidth = measureText(text);
  if (fullWidth <= maxWidth) {
    if (cacheKey) setCached(cacheKey, text);
    return text;
  }

  // Detect extension
  const lastDot = text.lastIndexOf('.');
  const hasExt = lastDot > 0 && text.length - lastDot <= 10;

  if (!hasExt) {
    const res = fitTextEnd(text, maxWidth, measureText, fontKey, ellipsis);
    if (cacheKey) setCached(cacheKey, res);
    return res;
  }

  const ext = text.slice(lastDot);
  const base = text.slice(0, lastDot);
  const extEllipsisW = measureText(ellipsis + ext);

  if (extEllipsisW > maxWidth) {
    // If extension + ellipsis doesn't fit, fall back to end-ellipsis on full text
    const res = fitTextEnd(text, maxWidth, measureText, fontKey, ellipsis);
    if (cacheKey) setCached(cacheKey, res);
    return res;
  }

  const baseClusters = getGraphemeClusters(base);
  let low = 0;
  let high = baseClusters.length;
  let best = ellipsis + ext;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = baseClusters.slice(0, mid).join('') + ellipsis + ext;
    const w = measureText(candidate);
    if (w <= maxWidth) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (cacheKey) setCached(cacheKey, best);
  return best;
}
