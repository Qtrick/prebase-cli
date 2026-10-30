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
  python: '#3572A5',
  rust: '#dea584',
  go: '#00ADD8',
  java: '#b07219',
  c: '#555555',
  cpp: '#f34b7d',
  csharp: '#178600',
  ruby: '#701516',
  php: '#4F5D95',
  kotlin: '#A97BFF',
  swift: '#F05138',
  lua: '#000080',
  scala: '#c22d40',
  elixir: '#6e4a7e',
  haskell: '#5e5086',
  r: '#198CE7',
  shell: '#89e051',
  html: '#e34c26',
  css: '#a371f7',
  scss: '#c6538c',
  json: '#8b8b8b',
  toml: '#9c4221',
  yaml: '#cb171e',
  markdown: '#519aba',
  sql: '#e38c00',
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
  py: { id: 'python', name: 'Python', color: LANGUAGE_COLORS.python },
  pyi: { id: 'python', name: 'Python', color: LANGUAGE_COLORS.python },
  rs: { id: 'rust', name: 'Rust', color: LANGUAGE_COLORS.rust },
  go: { id: 'go', name: 'Go', color: LANGUAGE_COLORS.go },
  java: { id: 'java', name: 'Java', color: LANGUAGE_COLORS.java },
  c: { id: 'c', name: 'C', color: LANGUAGE_COLORS.c },
  h: { id: 'c', name: 'C/C++ Header', color: LANGUAGE_COLORS.c },
  cpp: { id: 'cpp', name: 'C++', color: LANGUAGE_COLORS.cpp },
  hpp: { id: 'cpp', name: 'C++', color: LANGUAGE_COLORS.cpp },
  cc: { id: 'cpp', name: 'C++', color: LANGUAGE_COLORS.cpp },
  cxx: { id: 'cpp', name: 'C++', color: LANGUAGE_COLORS.cpp },
  hh: { id: 'cpp', name: 'C++', color: LANGUAGE_COLORS.cpp },
  cs: { id: 'csharp', name: 'C#', color: LANGUAGE_COLORS.csharp },
  rb: { id: 'ruby', name: 'Ruby', color: LANGUAGE_COLORS.ruby },
  rake: { id: 'ruby', name: 'Ruby', color: LANGUAGE_COLORS.ruby },
  php: { id: 'php', name: 'PHP', color: LANGUAGE_COLORS.php },
  phtml: { id: 'php', name: 'PHP', color: LANGUAGE_COLORS.php },
  kt: { id: 'kotlin', name: 'Kotlin', color: LANGUAGE_COLORS.kotlin },
  kts: { id: 'kotlin', name: 'Kotlin', color: LANGUAGE_COLORS.kotlin },
  swift: { id: 'swift', name: 'Swift', color: LANGUAGE_COLORS.swift },
  lua: { id: 'lua', name: 'Lua', color: LANGUAGE_COLORS.lua },
  scala: { id: 'scala', name: 'Scala', color: LANGUAGE_COLORS.scala },
  sc: { id: 'scala', name: 'Scala', color: LANGUAGE_COLORS.scala },
  ex: { id: 'elixir', name: 'Elixir', color: LANGUAGE_COLORS.elixir },
  exs: { id: 'elixir', name: 'Elixir', color: LANGUAGE_COLORS.elixir },
  hs: { id: 'haskell', name: 'Haskell', color: LANGUAGE_COLORS.haskell },
  lhs: { id: 'haskell', name: 'Haskell', color: LANGUAGE_COLORS.haskell },
  r: { id: 'r', name: 'R', color: LANGUAGE_COLORS.r },
  sh: { id: 'shell', name: 'Shell', color: LANGUAGE_COLORS.shell },
  bash: { id: 'shell', name: 'Shell', color: LANGUAGE_COLORS.shell },
  zsh: { id: 'shell', name: 'Shell', color: LANGUAGE_COLORS.shell },
  css: { id: 'css', name: 'CSS', color: LANGUAGE_COLORS.css },
  scss: { id: 'scss', name: 'SCSS', color: LANGUAGE_COLORS.scss },
  sass: { id: 'scss', name: 'SCSS', color: LANGUAGE_COLORS.scss },
  html: { id: 'html', name: 'HTML', color: LANGUAGE_COLORS.html },
  htm: { id: 'html', name: 'HTML', color: LANGUAGE_COLORS.html },
  json: { id: 'json', name: 'JSON', color: LANGUAGE_COLORS.json },
  toml: { id: 'toml', name: 'TOML', color: LANGUAGE_COLORS.toml },
  yaml: { id: 'yaml', name: 'YAML', color: LANGUAGE_COLORS.yaml },
  yml: { id: 'yaml', name: 'YAML', color: LANGUAGE_COLORS.yaml },
  md: { id: 'markdown', name: 'Markdown', color: LANGUAGE_COLORS.markdown },
  markdown: { id: 'markdown', name: 'Markdown', color: LANGUAGE_COLORS.markdown },
  sql: { id: 'sql', name: 'SQL', color: LANGUAGE_COLORS.sql },
};

export const ENTRY_NODE_COLOR = '#e8b84a';
export const HIGHLIGHT_NODE_COLOR = '#2dd4bf';

export function getFileTypeInfo(path: string | undefined, backendLanguage?: string): FileTypeInfo {
  if (backendLanguage && LANGUAGE_COLORS[backendLanguage]) {
    return {
      id: backendLanguage,
      name: backendLanguage.charAt(0).toUpperCase() + backendLanguage.slice(1),
      color: LANGUAGE_COLORS[backendLanguage],
    };
  }
  if (!path) {
    return { id: 'other', name: 'Other', color: LANGUAGE_COLORS.other };
  }
  const base = path.split(/[/\\]/).pop() ?? path;
  if (base.toLowerCase() === 'rakefile' || base.toLowerCase() === 'gemfile') {
    return { id: 'ruby', name: 'Ruby', color: LANGUAGE_COLORS.ruby };
  }
  const ext = base.includes('.') ? (base.split('.').pop()?.toLowerCase() ?? '') : '';
  if (EXT_MAP[ext]) {
    return EXT_MAP[ext];
  }
  return { id: 'other', name: ext ? ext.toUpperCase() : 'Other', color: LANGUAGE_COLORS.other };
}

export function getFileTypeColor(path: string | undefined, backendLanguage?: string): string {
  return getFileTypeInfo(path, backendLanguage).color;
}
