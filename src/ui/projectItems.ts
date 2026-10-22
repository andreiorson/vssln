import * as path from 'path';
import { itemsTree } from '../solution/itemsTree';
import { ChildrenProvider, TreeNode } from '../solution/model';
import { ProjectItems } from '../solution/projectItems';
import { Store } from '../state/store';
import { pathKey } from '../util/paths';

interface Built {
  nodes: TreeNode[];
  /** Lower-case paths of the project's files and of every folder above them, to match file events against. */
  paths: Set<string>;
}

/** Folder events may carry a trailing separator. */
function key(p: string): string {
  return pathKey(p).replace(/\\+$/, '');
}

/** The files' paths and their folders: a folder created or deleted in one event affects the files inside it. */
function watchedPaths(items: ProjectItems): Set<string> {
  const paths = new Set<string>();
  for (const item of items.items) {
    if (!item.path) continue;
    let p = key(item.path);
    while (!paths.has(p)) {
      paths.add(p);
      const parent = path.win32.dirname(p);
      if (parent === p) break;
      p = parent;
    }
  }
  return paths;
}

/**
 * Gives C++ project nodes their filters and files. A project's nodes are built when it is expanded (that is when file
 * existence is checked) and kept until it is collapsed, the solution reloads, or a file it lists (or a folder above
 * one) is created or deleted.
 */
export class ProjectItemsProvider implements ChildrenProvider {
  /** Keyed by the loaded ProjectItems object, so a reload, which replaces them, starts afresh. */
  private readonly built = new Map<ProjectItems, Built>();
  private readonly listeners = new Set<() => void>();
  /**
   * Each filter's and file's parent: a filter, or the project node the nodes were given for. Kept after a collapse or
   * reload drops the nodes, since a reveal may still be resolving them; their ids lead VS Code to the current nodes.
   */
  private readonly parents = new WeakMap<TreeNode, TreeNode>();

  constructor(private readonly store: Store, private readonly exists: (p: string) => boolean) {}

  private itemsOf(node: TreeNode): ProjectItems | undefined {
    if (node.kind !== 'project' || !node.project) return undefined;
    const entry = this.store.state.projects.get(node.project.guid);
    const items = entry?.exists ? entry.items : undefined;
    return items && (items.items.length > 0 || items.filters.length > 0) ? items : undefined;
  }

  /** Drops what was built for projects of an earlier load. */
  private prune(): void {
    const loaded = new Set([...this.store.state.projects.values()].map(e => e.items));
    for (const items of this.built.keys()) if (!loaded.has(items)) this.built.delete(items);
  }

  appliesTo(node: TreeNode): boolean {
    return this.itemsOf(node) !== undefined;
  }

  children(node: TreeNode): TreeNode[] {
    const items = this.itemsOf(node);
    if (!items) return [];
    let built = this.built.get(items);
    if (!built) {
      this.prune();
      const nodes = itemsTree(node.project!.guid, items, this.exists);
      const visit = (parent: TreeNode, children: TreeNode[]) => {
        for (const child of children) {
          this.parents.set(child, parent);
          visit(child, child.children);
        }
      };
      visit(node, nodes);
      built = { nodes, paths: watchedPaths(items) };
      this.built.set(items, built);
    }
    return built.nodes;
  }

  parentOf(node: TreeNode): TreeNode | undefined {
    return this.parents.get(node);
  }

  /** A collapsed project checks its files again when it is expanded next, for files no watcher sees (outside the workspace). */
  collapsed(node: TreeNode): void {
    const items = this.itemsOf(node);
    if (items) this.built.delete(items);
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** A created or deleted file or folder: refreshes the expanded projects that list it or files inside it. */
  fileChanged(changed: string): void {
    // Builds create and delete thousands of files; with nothing expanded there is nothing to look up.
    if (this.built.size === 0) return;
    const k = key(changed);
    let hit = false;
    for (const [items, built] of [...this.built]) {
      if (built.paths.has(k)) {
        this.built.delete(items);
        hit = true;
      }
    }
    if (hit) for (const listener of [...this.listeners]) listener();
  }
}
