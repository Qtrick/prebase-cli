export interface FileTypeInfo {
  id: string;
  name: string;
  color: string;
}

export const LANGUAGE_COLORS: Record<string, string> = {
  typescript: '#3178c6',
  javascript: '#f1e05a',
  tsx: '#22d3ee',
  jsx: '#38bdf8',
  css: '#a371f7',
  scss: '#c6538c',
  html: '#e34c26',
  json: '#8b8b8b',
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
  css: { id: 'css', name: 'CSS/SCSS', color: LANGUAGE_COLORS.css },
  scss: { id: 'css', name: 'CSS/SCSS', color: LANGUAGE_COLORS.scss },
  html: { id: 'html', name: 'HTML', color: LANGUAGE_COLORS.html },
  json: { id: 'config', name: 'Config', color: LANGUAGE_COLORS.config },
  md: { id: 'markdown', name: 'Markdown', color: LANGUAGE_COLORS.markdown },
};

export const ENTRY_NODE_COLOR = '#e8b84a';
export const HIGHLIGHT_NODE_COLOR = '#2dd4bf';

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

