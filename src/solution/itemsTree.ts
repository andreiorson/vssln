import * as path from 'path';
import { TreeNode } from './model';
import { ProjectItems } from './projectItems';

function byLabel(a: TreeNode, b: TreeNode): number {
  return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);
}

function sortLevel(nodes: TreeNode[]): TreeNode[] {
  const filters = nodes.filter(n => n.kind === 'filter').sort(byLabel);
  const files = nodes.filter(n => n.kind !== 'filter').sort(byLabel);
  for (const n of filters) n.children = sortLevel(n.children);
  return [...filters, ...files];
}

function segments(filter: string): string[] {
  return filter.split(/[\\/]/).map(s => s.trim()).filter(Boolean);
}

/**
 * The filters and files under a project, as Solution Explorer shows them: filters first, then files, each sorted by
 * name ignoring case. Ids depend only on the project and the paths, so expanded nodes stay expanded across reloads.
 */
export function itemsTree(projectGuid: string, items: ProjectItems, exists: (path: string) => boolean): TreeNode[] {
  const prefix = projectGuid.toLowerCase();
  const roots: TreeNode[] = [];
  const filters = new Map<string, TreeNode>();

  const filterNode = (filter: string | undefined): TreeNode[] => {
    let children = roots;
    const parts = segments(filter ?? '');
    for (let i = 0; i < parts.length; i++) {
      const key = parts.slice(0, i + 1).join('\\').toLowerCase();
      let node = filters.get(key);
      if (!node) {
        node = { id: `${prefix}/f/${key}`, kind: 'filter', label: parts[i], children: [], projectGuid };
        filters.set(key, node);
        children.push(node);
      }
      children = node.children;
    }
    return children;
  };

  for (const filter of items.filters) filterNode(filter);
  for (const item of items.items) {
    const missing = item.path !== undefined && !exists(item.path);
    filterNode(item.filter).push({
      id: `${prefix}/i/${(item.path ?? item.include).toLowerCase()}`,
      kind: 'file',
      label: item.path ? path.win32.basename(item.path) : item.include,
      children: [],
      projectGuid,
      item: { include: item.include, ...(item.path ? { path: item.path } : {}), missing },
    });
  }
  return sortLevel(roots);
}
