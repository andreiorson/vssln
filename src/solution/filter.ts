import { TreeNode } from './model';

export interface FilterResult {
  roots: TreeNode[];
  /** Projects that match. */
  matched: number;
  /** All projects in the tree. */
  total: number;
}

function countProjects(nodes: TreeNode[]): number {
  return nodes.reduce((n, node) => n + (node.kind === 'project' ? 1 : 0) + countProjects(node.children), 0);
}

/**
 * Keeps the projects whose tree path ("Core/Graphics/Render") contains every word of the query, ignoring case, together
 * with their folders. An empty query returns the tree unchanged.
 */
export function filterTree(roots: TreeNode[], query: string): FilterResult {
  const total = countProjects(roots);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { roots, matched: total, total };

  let matched = 0;
  const visit = (nodes: TreeNode[], prefix: string): TreeNode[] =>
    nodes.flatMap(node => {
      const nodePath = `${prefix}${node.label.toLowerCase()}`;
      if (node.kind === 'project') {
        if (!words.every(w => nodePath.includes(w))) return [];
        matched++;
        return [node];
      }
      const children = visit(node.children, `${nodePath}/`);
      return children.length > 0 ? [{ ...node, children }] : [];
    });

  const filtered = visit(roots, '');
  return { roots: filtered, matched, total };
}
