import * as path from 'path';
import { AppState } from '../state/store';
import { TreeNode } from './model';

function key(p: string): string {
  return path.win32.normalize(p).toLowerCase();
}

/** Guids of the projects that list a file: the startup project first when it does, then solution order. */
export function projectsListing(s: Pick<AppState, 'solution' | 'projects' | 'startupProjectGuid'>, filePath: string): string[] {
  const wanted = key(filePath);
  const listing = (s.solution?.projects ?? [])
    .map(p => p.guid)
    .filter(guid => s.projects.get(guid)?.items?.items.some(i => i.path !== undefined && key(i.path) === wanted));
  const startup = listing.indexOf(s.startupProjectGuid ?? '');
  return startup > 0 ? [listing[startup], ...listing.filter((_, i) => i !== startup)] : listing;
}

/** The file node for a path among a project's filter and file nodes. */
export function findItemNode(nodes: TreeNode[], filePath: string): TreeNode | undefined {
  const wanted = key(filePath);
  for (const node of nodes) {
    if (node.kind === 'file' && node.item?.path !== undefined && key(node.item.path) === wanted) return node;
    const inside = node.kind === 'filter' ? findItemNode(node.children, filePath) : undefined;
    if (inside) return inside;
  }
  return undefined;
}

/** Each solution folder's and project's parent in a tree of folders and projects; roots have none. */
export function parentsOf(roots: TreeNode[]): Map<TreeNode, TreeNode> {
  const parents = new Map<TreeNode, TreeNode>();
  const visit = (node: TreeNode) => {
    for (const child of node.children) {
      parents.set(child, node);
      visit(child);
    }
  };
  roots.forEach(visit);
  return parents;
}
