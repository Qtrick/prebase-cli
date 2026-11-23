import { describe, it, expect, beforeEach } from 'vitest';
import {
  fitTextEnd,
  fitTextPrefix,
  fitTextMiddle,
  getGraphemeClusters,
  clearTextFitCache,
  getTextFitCacheSize,
} from '../textFitting';

describe('Universal Text Fitting Engine (textFitting.ts)', () => {
  // Deterministic mock measure function: 1 char = 10px width
  const charWidth = 10;
  const mockMeasure = (str: string) => str.length * charWidth;

  beforeEach(() => {
    clearTextFitCache();
  });

  describe('getGraphemeClusters', () => {
    it('returns empty array for empty string', () => {
      expect(getGraphemeClusters('')).toEqual([]);
    });

    it('splits ASCII text into single-character clusters', () => {
      expect(getGraphemeClusters('hello')).toEqual(['h', 'e', 'l', 'l', 'o']);
    });

    it('handles emoji and surrogate pairs cleanly', () => {
      const clusters = getGraphemeClusters('a🎉b');
      expect(clusters).toEqual(['a', '🎉', 'b']);
    });
  });

  describe('fitTextEnd', () => {
    it('returns full text if it already fits maxWidth', () => {
      const result = fitTextEnd('hello', 100, mockMeasure);
      expect(result).toBe('hello');
    });

    it('returns empty string if maxWidth <= 0', () => {
      expect(fitTextEnd('hello', 0, mockMeasure)).toBe('');
      expect(fitTextEnd('hello', -10, mockMeasure)).toBe('');
    });

    it('returns empty string if maxWidth is less than ellipsis width', () => {
      // '…' length is 1, mockMeasure is 10
      expect(fitTextEnd('hello', 5, mockMeasure)).toBe('');
    });

    it('truncates text with ellipsis and ensures width does not exceed maxWidth', () => {
      // 'hello world' is 11 chars = 110px. MaxWidth = 60px.
      // Must fit in 60px (<= 6 chars including '…'). e.g., 'hello…' (6 chars = 60px).
      const result = fitTextEnd('hello world', 60, mockMeasure);
      expect(result).toBe('hello…');
      expect(mockMeasure(result)).toBeLessThanOrEqual(60);
    });

    it('uses LRU cache for identical queries', () => {
      expect(getTextFitCacheSize()).toBe(0);
      const res1 = fitTextEnd('testing cache', 50, mockMeasure, '12px sans-serif');
      expect(getTextFitCacheSize()).toBe(1);
      const res2 = fitTextEnd('testing cache', 50, mockMeasure, '12px sans-serif');
      expect(res1).toBe(res2);
      expect(getTextFitCacheSize()).toBe(1);
    });
  });

  describe('fitTextPrefix', () => {
    it('returns full path if it already fits', () => {
      const path = 'src/index.ts';
      expect(fitTextPrefix(path, 200, mockMeasure)).toBe(path);
    });

    it('returns empty string for non-positive or sub-ellipsis width', () => {
      expect(fitTextPrefix('src/index.ts', 0, mockMeasure)).toBe('');
      expect(fitTextPrefix('src/index.ts', 5, mockMeasure)).toBe('');
    });

    it('truncates prefix of long path while preserving trailing path segments', () => {
      // 'crates/prebase-parser/src/tsconfig.rs' is 36 chars = 360px
      // With maxWidth = 150px, can fit at most 15 chars.
      // Trailing suffix should preserve '…/tsconfig.rs' (14 chars = 140px)
      const path = 'crates/prebase-parser/src/tsconfig.rs';
      const result = fitTextPrefix(path, 150, mockMeasure);
      expect(result.startsWith('…')).toBe(true);
      expect(result.endsWith('tsconfig.rs')).toBe(true);
      expect(mockMeasure(result)).toBeLessThanOrEqual(150);
    });
  });

  describe('fitTextMiddle', () => {
    it('returns full filename if it fits', () => {
      const filename = 'tsconfig.rs';
      expect(fitTextMiddle(filename, 150, mockMeasure)).toBe(filename);
    });

    it('preserves file extension when truncating middle', () => {
      // 'very_long_component_name.test.tsx' is 33 chars = 330px
      // maxWidth = 160px (at most 16 chars).
      // Should preserve '.test.tsx' (10 chars) and prefix, e.g. 'very…test.tsx'
      const filename = 'very_long_component_name.test.tsx';
      const result = fitTextMiddle(filename, 160, mockMeasure);
      expect(result.includes('…')).toBe(true);
      expect(result.endsWith('.tsx')).toBe(true);
      expect(mockMeasure(result)).toBeLessThanOrEqual(160);
    });

    it('handles files without extension gracefully', () => {
      const name = 'very_long_file_name_without_extension';
      const result = fitTextMiddle(name, 100, mockMeasure);
      expect(result.includes('…')).toBe(true);
      expect(mockMeasure(result)).toBeLessThanOrEqual(100);
    });
  });
});
