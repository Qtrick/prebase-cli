/**
 * Minimal Unique Path Suffix Disambiguation
 *
 * Efficiently computes clean, disambiguated display labels for code nodes.
 * Unique filenames are displayed as just the filename.
 * Duplicate filenames are disambiguated with the minimum necessary path context,
 * avoiding ambiguous labels (e.g. apps/web/src/components/index.ts vs apps/admin/src/components/index.ts).
 */

export interface PathDisambiguationNode {
  id: string;
  relative_path: string;
  filename: string;
}

export function computeDisambiguatedLabels(
  nodes: readonly PathDisambiguationNode[]
): Map<string, string> {
  const result = new Map<string, string>();
  if (!nodes || nodes.length === 0) return result;

  // 1. Group nodes by filename
  const byFilename = new Map<string, PathDisambiguationNode[]>();
  for (const node of nodes) {
    let group = byFilename.get(node.filename);
    if (!group) {
      group = [];
      byFilename.set(node.filename, group);
    }
    group.push(node);
  }

  // 2. Process each group
  for (const [, group] of byFilename.entries()) {
    if (group.length === 1) {
      result.set(group[0].id, group[0].filename);
      continue;
    }

    // Duplicate filename group: split each path into segments
    const nodeSegments = group.map((node) => ({
      node,
      segments: node.relative_path.split('/').filter(Boolean),
    }));

    for (let i = 0; i < nodeSegments.length; i++) {
      const current = nodeSegments[i];
      const maxDepth = current.segments.length;

      // Find minimum depth k >= 2 such that current's suffix of length k is unique among all other nodes in the group
      let chosenDepth = 2;
      for (let depth = 2; depth <= maxDepth; depth++) {
        const currentSuffix = current.segments.slice(-depth).join('/');
        let hasCollision = false;

        for (let j = 0; j < nodeSegments.length; j++) {
          if (i === j) continue;
          const other = nodeSegments[j];
          const otherSuffix = other.segments.slice(-depth).join('/');
          if (currentSuffix === otherSuffix) {
            hasCollision = true;
            break;
          }
        }

        if (!hasCollision) {
          chosenDepth = depth;
          break;
        }
        chosenDepth = depth;
      }

      // Format label cleanly:
      // If depth <= 3: e.g. "Header/index.ts" or "components/Header/index.ts"
      // If depth > 3: e.g. "web/.../index.ts" or "web/.../components/index.ts"
      if (chosenDepth <= 3) {
        result.set(current.node.id, current.segments.slice(-chosenDepth).join('/'));
      } else {
        const firstDiffSegment = current.segments[current.segments.length - chosenDepth];
        const lastSegment = current.segments[current.segments.length - 1];
        result.set(current.node.id, `${firstDiffSegment}/.../${lastSegment}`);
      }
    }
  }

  return result;
}

