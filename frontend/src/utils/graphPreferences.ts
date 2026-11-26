/**
 * PreBase — Local Graph Preference Storage Helpers
 *
 * Safely reads and writes local-only UI preferences without throwing
 * when browser storage is unavailable or contains unexpected values.
 */

export const HIDE_GROUP_LABELS_STORAGE_KEY = 'prebase_hide_group_labels_on_movement';

export function parseBooleanPreference(raw: string | null, defaultValue = false): boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return defaultValue;
}

export function readHideGroupLabelsPreference(storage?: Pick<Storage, 'getItem'> | null): boolean {
  try {
    const store = storage ?? (typeof window !== 'undefined' ? window.localStorage : null);
    if (!store) return false;
    return parseBooleanPreference(store.getItem(HIDE_GROUP_LABELS_STORAGE_KEY), false);
  } catch {
    return false;
  }
}

export function writeHideGroupLabelsPreference(
  value: boolean,
  storage?: Pick<Storage, 'setItem'> | null
): boolean {
  try {
    const store = storage ?? (typeof window !== 'undefined' ? window.localStorage : null);
    if (!store) return false;
    store.setItem(HIDE_GROUP_LABELS_STORAGE_KEY, value ? 'true' : 'false');
    return true;
  } catch {
    return false;
  }
}
