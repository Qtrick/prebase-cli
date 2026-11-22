export interface FileTypeInfo {
  id: string;
  name: string;
  color: string;
}

export const LANGUAGE_COLORS: Record<string, string> = {
  typescript: '#3178c6',
  javascript: '#f1e05a',
  rust: '#dea584',
  python: '#3572A5',
  tsx: '#22d3ee',
  jsx: '#38bdf8',
  css: '#a371f7',
  scss: '#c6538c',
  html: '#e34c26',
  json: '#8b8b8b',
  toml: '#9c4221',
  markdown: '#519aba',
  image: '#c678dd',
  config: '#6b7280',
  other: '#71717a',
};

const EXT_MAP: Record<string, FileTypeInfo> = {
  ts: { id: 'typescript', name: 'TypeScript', color: LANGUAGE_COLORS.typescript },
  tsx: { id: 'tsx', name: 'TSX', color: LANGUAGE_COLORS.tsx },
  mts: { id: 'typescript', name: 'TypeScript', color: LANGUAGE_COLORS.typescript },
  cts: { id: 'typescript', name: 'TypeScript', color: LANGUAGE_COLORS.typescript },
  js: { id: 'javascript', name: 'JavaScript', color: LANGUAGE_COLORS.javascript },
  jsx: { id: 'jsx', name: 'JSX', color: LANGUAGE_COLORS.jsx },
  mjs: { id: 'javascript', name: 'JavaScript', color: LANGUAGE_COLORS.javascript },
  cjs: { id: 'javascript', name: 'JavaScript', color: LANGUAGE_COLORS.javascript },
  rs: { id: 'rust', name: 'Rust', color: LANGUAGE_COLORS.rust },
  py: { id: 'python', name: 'Python', color: LANGUAGE_COLORS.python },
  pyi: { id: 'python', name: 'Python', color: LANGUAGE_COLORS.python },
  toml: { id: 'toml', name: 'TOML', color: LANGUAGE_COLORS.toml },
  css: { id: 'css', name: 'CSS/SCSS', color: LANGUAGE_COLORS.css },
  scss: { id: 'css', name: 'CSS/SCSS', color: LANGUAGE_COLORS.scss },
  html: { id: 'html', name: 'HTML', color: LANGUAGE_COLORS.html },
  json: { id: 'config', name: 'Config', color: LANGUAGE_COLORS.config },
  md: { id: 'markdown', name: 'Markdown', color: LANGUAGE_COLORS.markdown },
};

export const ENTRY_NODE_COLOR = '#e8b84a';
export const HIGHLIGHT_NODE_COLOR = '#2dd4bf';

export const AREA_PALETTE_DARK = [
  '#818cf8', // Electric Indigo
  '#2dd4bf', // Cyan / Teal
  '#38bdf8', // Sky Blue
  '#34d399', // Emerald
  '#fbbf24', // Amber
  '#fb7185', // Rose
  '#a78bfa', // Violet
  '#fb923c', // Tangerine
  '#e879f9', // Fuchsia
  '#a3e635', // Lime
  '#60a5fa', // Cobalt
  '#94a3b8', // Slate
];

export const AREA_PALETTE_LIGHT = [
  '#4f46e5', // Electric Indigo
  '#0d9488', // Cyan / Teal
  '#0284c7', // Sky Blue
  '#059669', // Emerald
  '#d97706', // Amber
  '#e11d48', // Rose
  '#7c3aed', // Violet
  '#ea580c', // Tangerine
  '#c026d3', // Fuchsia
  '#65a30d', // Lime
  '#2563eb', // Cobalt
  '#475569', // Slate
];

export function getAreaColor(areaId: string | undefined, theme: 'dark' | 'light' = 'dark'): string {
  if (!areaId) return theme === 'light' ? '#475569' : '#94a3b8';
  let hash = 0;
  for (let i = 0; i < areaId.length; i++) {
    hash = (hash * 31 + areaId.charCodeAt(i)) >>> 0;
  }
  const palette = theme === 'light' ? AREA_PALETTE_LIGHT : AREA_PALETTE_DARK;
  return palette[hash % palette.length];
}

export function getFileTypeInfo(path: string | undefined): FileTypeInfo {
  if (!path) {
    return { id: 'other', name: 'Other', color: LANGUAGE_COLORS.other };
  }
  const base = path.split(/[/\\]/).pop() ?? path;
  const ext = base.includes('.') ? (base.split('.').pop()?.toLowerCase() ?? '') : '';
  if (EXT_MAP[ext]) {
    return EXT_MAP[ext];
  }
  return { id: 'other', name: ext ? ext.toUpperCase() : 'Other', color: LANGUAGE_COLORS.other };
}

export function getFileTypeColor(path: string | undefined): string {
  return getFileTypeInfo(path).color;
}

