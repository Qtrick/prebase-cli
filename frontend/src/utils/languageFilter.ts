import { FileNode } from '../types/graph';

export type LanguageFilterType = 'all' | 'typescript' | 'rust' | 'python';

/**
 * Determines whether a given node matches the specified language filter.
 * 
 * Supports:
 * - 'typescript': TypeScript and JavaScript (.ts, .tsx, .mts, .cts, .js, .jsx, .mjs, .cjs)
 * - 'rust': Rust crates and modules (.rs)
 * - 'python': Python modules and packages (.py, .pyi)
 * - 'all': Unconditional match
 * 
 * Matches against both node.language metadata and file extension for robust polyglot coverage.
 */
export function matchesLanguageFilter(
  node?: Pick<FileNode, 'language' | 'relative_path'> | null,
  filter?: LanguageFilterType | null
): boolean {
  if (!filter || filter === 'all') return true;
  if (!node) return false;

  const lang = (node.language || '').toLowerCase().trim();
  const path = node.relative_path || '';
  const lastDot = path.lastIndexOf('.');
  const ext = lastDot >= 0 ? path.slice(lastDot + 1).toLowerCase().trim() : '';

  if (filter === 'typescript') {
    return (
      lang === 'typescript' ||
      lang === 'javascript' ||
      ext === 'ts' ||
      ext === 'tsx' ||
      ext === 'mts' ||
      ext === 'cts' ||
      ext === 'js' ||
      ext === 'jsx' ||
      ext === 'mjs' ||
      ext === 'cjs'
    );
  }

  if (filter === 'rust') {
    return lang === 'rust' || ext === 'rs';
  }

  if (filter === 'python') {
    return lang === 'python' || ext === 'py' || ext === 'pyi';
  }

  return true;
}

/**
 * Partitions a list of nodes into matching and non-matching subsets for a given language filter.
 */
export function partitionNodesByLanguage(
  nodes: readonly FileNode[],
  filter?: LanguageFilterType | null
): { matching: FileNode[]; nonMatching: FileNode[] } {
  const matching: FileNode[] = [];
  const nonMatching: FileNode[] = [];

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (matchesLanguageFilter(node, filter)) {
      matching.push(node);
    } else {
      nonMatching.push(node);
    }
  }

  return { matching, nonMatching };
}

/**
 * Computes visual dimming opacity for nodes based on active language filter.
 * In both 3D and 2D views, matching nodes have full opacity (1.0),
 * while non-matching nodes are dimmed to 0.2 to preserve context without visual clutter.
 */
export function getLanguageFilterOpacity(
  node: Pick<FileNode, 'language' | 'relative_path'>,
  filter?: LanguageFilterType | null
): number {
  if (!filter || filter === 'all') return 1.0;
  return matchesLanguageFilter(node, filter) ? 1.0 : 0.2;
}
