import { describe, it, expect } from 'vitest';
import {
  parseInitialUrlParams,
  shouldIgnoreGlobalShortcut,
  hasModifierCombination,
} from '../App';
import { getNodeRelationshipSentence } from '../../inspector/Inspector';

describe('App interaction & security unit tests', () => {
  describe('Safe URL focus query parameter parsing', () => {
    it('parses standard query focus path', () => {
      const res = parseInitialUrlParams('?view=2d&focus=src/components/Button.tsx');
      expect(res.activeTab).toBe('network');
      expect(res.networkViewMode).toBe('2d');
      expect(res.initialFocusPath).toBe('src/components/Button.tsx');
    });

    it('parses paths with spaces and unicode correctly without double-decoding', () => {
      const res = parseInitialUrlParams('?view=3d&focus=src%2Fcomponents%2FMy%20Button%20%E2%9C%A8.tsx');
      expect(res.initialFocusPath).toBe('src/components/My Button ✨.tsx');
    });

    it('tolerates percent signs in filenames without throwing URIError', () => {
      const res = parseInitialUrlParams('?view=2d&focus=src/100%real.ts');
      expect(res.initialFocusPath).toBe('src/100%real.ts');
    });

    it('tolerates malformed percent sequences without crashing', () => {
      const res = parseInitialUrlParams('?view=2d&focus=%E0%A4%A');
      expect(res.networkViewMode).toBe('2d');
      expect(typeof res.initialFocusPath).toBe('string');
    });

    it('handles empty or missing focus parameter', () => {
      const res = parseInitialUrlParams('?view=temporal');
      expect(res.activeTab).toBe('temporal');
      expect(res.initialFocusPath).toBeNull();
    });
  });

  describe('Keyboard shortcut filtering rules', () => {
    it('ignores shortcuts when focused on input, textarea, or select', () => {
      expect(shouldIgnoreGlobalShortcut({ target: { tagName: 'input' } })).toBe(true);
      expect(shouldIgnoreGlobalShortcut({ target: { tagName: 'textarea' } })).toBe(true);
      expect(shouldIgnoreGlobalShortcut({ target: { tagName: 'select' } })).toBe(true);
    });

    it('ignores shortcuts when focused on contenteditable or textbox role', () => {
      expect(shouldIgnoreGlobalShortcut({ target: { tagName: 'div', isContentEditable: true } })).toBe(true);
      expect(
        shouldIgnoreGlobalShortcut({
          target: { tagName: 'div', getAttribute: (attr) => (attr === 'role' ? 'textbox' : null) },
        })
      ).toBe(true);
    });

    it('ignores shortcuts during IME composition', () => {
      expect(shouldIgnoreGlobalShortcut({ target: { tagName: 'body' }, isComposing: true })).toBe(true);
      expect(shouldIgnoreGlobalShortcut({ target: { tagName: 'body' }, keyCode: 229 })).toBe(true);
    });

    it('detects modifier combinations (e.g. Cmd+C, Cmd+V, Cmd+1, Ctrl+C)', () => {
      expect(hasModifierCombination({ metaKey: true })).toBe(true);
      expect(hasModifierCombination({ ctrlKey: true })).toBe(true);
      expect(hasModifierCombination({ altKey: true })).toBe(true);
      expect(hasModifierCombination({})).toBe(false);
    });

    it('allows clean single-key shortcuts when not editing and without modifier keys', () => {
      expect(shouldIgnoreGlobalShortcut({ target: { tagName: 'body' } })).toBe(false);
      expect(shouldIgnoreGlobalShortcut({ target: { tagName: 'canvas' } })).toBe(false);
    });
  });

  describe('Truthful file relationship descriptions (getNodeRelationshipSentence)', () => {
    it('returns empty string when node is null', () => {
      expect(getNodeRelationshipSentence(null)).toBe('');
    });

    it('reports unsupported files truthfully without false dependency claims', () => {
      const text = getNodeRelationshipSentence({
        analysis_status: 'Unsupported',
        direct_dependency_count: 0,
        direct_dependent_count: 0,
      });
      expect(text).toBe('PreBase discovered this file but does not currently analyze its internal dependencies.');
    });

    it('reports failed parse status truthfully', () => {
      const text = getNodeRelationshipSentence({
        analysis_status: 'Failed',
        direct_dependency_count: 0,
        direct_dependent_count: 0,
      });
      expect(text).toBe("PreBase encountered an error while parsing this file's imports.");
    });

    it('uses grounded language when dependent files exist without exaggerated foundation labels', () => {
      const text = getNodeRelationshipSentence({
        analysis_status: 'Analyzed',
        direct_dependency_count: 0,
        direct_dependent_count: 4,
      });
      expect(text).toBe('This file is directly used by 4 other files, and imports no other indexed files.');
      expect(text).not.toContain('foundation');
      expect(text).not.toContain('core');
    });

    it('uses grounded language for isolated files', () => {
      const text = getNodeRelationshipSentence({
        analysis_status: 'Analyzed',
        direct_dependency_count: 0,
        direct_dependent_count: 0,
      });
      expect(text).toBe('This file has no direct internal dependencies or dependents in this repository.');
    });

    it('uses grounded language for mixed dependencies and dependents', () => {
      const text = getNodeRelationshipSentence({
        analysis_status: 'Analyzed',
        direct_dependency_count: 2,
        direct_dependent_count: 3,
      });
      expect(text).toBe('This file uses 2 internal files and is used by 3 other files.');
    });
  });
});

