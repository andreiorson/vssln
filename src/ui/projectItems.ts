import * as path from 'path';
import { itemsTree } from '../solution/itemsTree';
import { ChildrenProvider, TreeNode } from '../solution/model';
import { ProjectItems } from '../solution/projectItems';
import { Store } from '../state/store';

interface Built {
  nodes: TreeNode[];
  /** Lower-case paths of the project's files, to match file events against. */
  paths: Set<string>;
}

/**
 * Gives C++ project nodes their filters and files. A project's nodes are built when it is first expanded (that is when
 * file existence is checked) and kept until the solution reloads or a file the project lists is created or deleted.
 */
export class ProjectItemsProvider implements ChildrenProvider {
  /** Keyed by the loaded ProjectItems object, so a reload, which replaces them, starts afresh. */
  private readonly built = new Map<ProjectItems, Built>();
  private readonly listeners = new Set<() => void>();

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
      const paths = new Set(items.items.flatMap(i => (i.path ? [i.path.toLowerCase()] : [])));
      built = { nodes: itemsTree(node.project!.guid, items, this.exists), paths };
      this.built.set(items, built);
    }
    return built.nodes;
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /**
   * A created or deleted path: refreshes the projects that list it. A deleted folder arrives as one event for the
   * folder, so `folderMayBeGone` also matches the files inside it.
   */
  fileChanged(changed: string, folderMayBeGone = false): void {
    this.prune();
    const lower = path.win32.normalize(changed).toLowerCase();
    const inside = lower.endsWith('\\') ? lower : `${lower}\\`;
    let hit = false;
    for (const [items, built] of [...this.built]) {
      if (built.paths.has(lower) || (folderMayBeGone && [...built.paths].some(p => p.startsWith(inside)))) {
        this.built.delete(items);
        hit = true;
      }
    }
    if (hit) for (const listener of [...this.listeners]) listener();
  }
}
