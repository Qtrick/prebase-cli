import { describe, it, expect } from 'vitest';
import {
  isSupportedPointerGestureButton,
  handleGesturePointerDown,
} from '../render/networkRenderMath';
import {
  HIDE_GROUP_LABELS_STORAGE_KEY,
  parseBooleanPreference,
  readHideGroupLabelsPreference,
  writeHideGroupLabelsPreference,
} from '../../../utils/graphPreferences';
import { NetworkCamera } from '../../../types/graph';

describe('Right-Click Rejection & Pointer Gesture Lifecycle (networkRenderMath.ts)', () => {
  const baseCamera: NetworkCamera = {
    yaw: 0.25,
    pitch: -0.15,
    panX: 12,
    panY: -8,
    zoom: 1.2,
  };

  describe('isSupportedPointerGestureButton', () => {
    it('rejects right-click (button === 2) and Ctrl+left-click (ctrlKey && button === 0)', () => {
      expect(isSupportedPointerGestureButton(2)).toBe(false);
      expect(isSupportedPointerGestureButton(2, false)).toBe(false);
      expect(isSupportedPointerGestureButton(2, true)).toBe(false);
      expect(isSupportedPointerGestureButton(0, true)).toBe(false);
    });

    it('accepts primary left-click (button === 0) without ctrlKey and middle-click (button === 1)', () => {
      expect(isSupportedPointerGestureButton(0)).toBe(true);
      expect(isSupportedPointerGestureButton(0, false)).toBe(true);
      expect(isSupportedPointerGestureButton(1)).toBe(true);
      expect(isSupportedPointerGestureButton(1, false)).toBe(true);
    });

    it('rejects auxiliary mouse buttons (e.g. back/forward buttons 3, 4)', () => {
      expect(isSupportedPointerGestureButton(3)).toBe(false);
      expect(isSupportedPointerGestureButton(4)).toBe(false);
      expect(isSupportedPointerGestureButton(-1)).toBe(false);
    });
  });

  describe('handleGesturePointerDown', () => {
    it('rejects right-click (button === 2) with idle inactive state', () => {
      const state = handleGesturePointerDown({
        clientX: 240,
        clientY: 180,
        pointerId: 7,
        pointerType: 'mouse',
        button: 2,
        currentCamera: baseCamera,
      });

      expect(state.active).toBe(false);
      expect(state.mode).toBe('idle');
      expect(state.pointerId).toBeNull();
      expect(state.exceededThreshold).toBe(false);
      expect(state.startCamera).toEqual(baseCamera);
    });

    it('rejects Ctrl+left-click (ctrlKey && button === 0) with idle inactive state', () => {
      const state = handleGesturePointerDown({
        clientX: 240,
        clientY: 180,
        pointerId: 8,
        pointerType: 'mouse',
        button: 0,
        ctrlKey: true,
        currentCamera: baseCamera,
      });

      expect(state.active).toBe(false);
      expect(state.mode).toBe('idle');
      expect(state.pointerId).toBeNull();
    });

    it('starts rotating mode on primary left-click (button === 0)', () => {
      const state = handleGesturePointerDown({
        clientX: 310,
        clientY: 220,
        pointerId: 11,
        pointerType: 'mouse',
        button: 0,
        currentCamera: baseCamera,
      });

      expect(state.active).toBe(true);
      expect(state.mode).toBe('rotating');
      expect(state.pointerId).toBe(11);
      expect(state.startX).toBe(310);
      expect(state.startY).toBe(220);
      expect(state.exceededThreshold).toBe(false);
      expect(state.startCamera).toEqual(baseCamera);
      expect(state.startCamera).not.toBe(baseCamera);
    });

    it('starts panning mode on Shift+left-click (shiftKey && button === 0)', () => {
      const state = handleGesturePointerDown({
        clientX: 150,
        clientY: 95,
        pointerId: 12,
        pointerType: 'mouse',
        button: 0,
        shiftKey: true,
        currentCamera: baseCamera,
      });

      expect(state.active).toBe(true);
      expect(state.mode).toBe('panning');
      expect(state.pointerId).toBe(12);
    });

    it('starts panning mode on middle-click (button === 1)', () => {
      const state = handleGesturePointerDown({
        clientX: 400,
        clientY: 300,
        pointerId: 13,
        pointerType: 'mouse',
        button: 1,
        currentCamera: baseCamera,
      });

      expect(state.active).toBe(true);
      expect(state.mode).toBe('panning');
      expect(state.pointerId).toBe(13);
    });
  });
});

describe('Graph Preferences Persistence (graphPreferences.ts)', () => {
  describe('parseBooleanPreference', () => {
    it('parses exact "true" and "false" strings and falls back to defaultValue otherwise', () => {
      expect(parseBooleanPreference('true')).toBe(true);
      expect(parseBooleanPreference('false')).toBe(false);
      expect(parseBooleanPreference(null)).toBe(false);
      expect(parseBooleanPreference(null, true)).toBe(true);
      expect(parseBooleanPreference('TRUE')).toBe(false);
      expect(parseBooleanPreference('1')).toBe(false);
      expect(parseBooleanPreference('yes')).toBe(false);
      expect(parseBooleanPreference('', true)).toBe(true);
    });
  });

  describe('readHideGroupLabelsPreference', () => {
    it('defaults to false when key is missing or storage is null', () => {
      const emptyStorage = { getItem: () => null };
      expect(readHideGroupLabelsPreference(emptyStorage)).toBe(false);
      expect(readHideGroupLabelsPreference(null)).toBe(false);
    });

    it('reads stored boolean values under HIDE_GROUP_LABELS_STORAGE_KEY', () => {
      const store = new Map<string, string>();
      const storage = {
        getItem: (key: string) => store.get(key) ?? null,
      };

      store.set(HIDE_GROUP_LABELS_STORAGE_KEY, 'true');
      expect(readHideGroupLabelsPreference(storage)).toBe(true);

      store.set(HIDE_GROUP_LABELS_STORAGE_KEY, 'false');
      expect(readHideGroupLabelsPreference(storage)).toBe(false);

      store.set(HIDE_GROUP_LABELS_STORAGE_KEY, 'corrupted-value');
      expect(readHideGroupLabelsPreference(storage)).toBe(false);
    });

    it('handles throwing localStorage.getItem gracefully without throwing', () => {
      const throwingStorage = {
        getItem: () => {
          throw new Error('SecurityError: storage access denied');
        },
      };

      expect(() => readHideGroupLabelsPreference(throwingStorage)).not.toThrow();
      expect(readHideGroupLabelsPreference(throwingStorage)).toBe(false);
    });
  });

  describe('writeHideGroupLabelsPreference', () => {
    it('persists boolean preference as "true"/"false" and round-trips with readHideGroupLabelsPreference', () => {
      const store = new Map<string, string>();
      const storage = {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
      };

      expect(writeHideGroupLabelsPreference(true, storage)).toBe(true);
      expect(store.get(HIDE_GROUP_LABELS_STORAGE_KEY)).toBe('true');
      expect(readHideGroupLabelsPreference(storage)).toBe(true);

      expect(writeHideGroupLabelsPreference(false, storage)).toBe(true);
      expect(store.get(HIDE_GROUP_LABELS_STORAGE_KEY)).toBe('false');
      expect(readHideGroupLabelsPreference(storage)).toBe(false);
    });

    it('handles null storage or throwing localStorage.setItem gracefully', () => {
      expect(writeHideGroupLabelsPreference(true, null)).toBe(false);

      const throwingStorage = {
        setItem: () => {
          throw new Error('QuotaExceededError');
        },
      };

      expect(() => writeHideGroupLabelsPreference(true, throwingStorage)).not.toThrow();
      expect(writeHideGroupLabelsPreference(true, throwingStorage)).toBe(false);
    });
  });
});
