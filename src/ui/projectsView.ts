import * as vscode from 'vscode';
import { FilterResult, filterTree } from '../solution/filter';
import { parentsOf } from '../solution/locate';
import { buildTree, ChildrenRegistry, TreeNode } from '../solution/model';
import { ParsedSolution } from '../solution/slnParser';
import { Store } from '../state/store';
import { coalesce } from './coalesce';
import { projectRow } from './viewModel';

export class ProjectsView implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly filterChanged = new vscode.EventEmitter<void>();
  /** Fires when the filter text changes, for the view's title and context key. */
  readonly onDidChangeFilter = this.filterChanged.event;
  private readonly subscription: { dispose(): void };
  private cache?: { solution: ParsedSolution; roots: TreeNode[] };
  private filter = '';
  private filtered?: { roots: TreeNode[]; query: string; result: FilterResult };
  private parents?: { roots: TreeNode[]; map: Map<TreeNode, TreeNode> };
  /** Parents of every folder and project node handed out, kept for reveals that resolve after the tree changed. */
  private readonly earlierParents = new WeakMap<TreeNode, TreeNode>();

  constructor(private readonly store: Store, private readonly registry: ChildrenRegistry) {
    this.subscription = store.onDidChange(coalesce(() => this.changed.fire(), 50));
  }

  get filterText(): string {
    return this.filter;
  }

  setFilter(text: string): void {
    const next = text.trim();
    if (next === this.filter) return;
    this.filter = next;
    this.changed.fire();
    this.filterChanged.fire();
  }

  private allRoots(): TreeNode[] {
    const solution = this.store.state.solution;
    if (!solution) return [];
    if (this.cache?.solution !== solution) this.cache = { solution, roots: buildTree(solution) };
    return this.cache.roots;
  }

  private result(): FilterResult {
    const roots = this.allRoots();
    if (this.filtered?.roots !== roots || this.filtered.query !== this.filter) {
      this.filtered = { roots, query: this.filter, result: filterTree(roots, this.filter) };
    }
    return this.filtered.result;
  }

  /** "filter: gra ren · 1 of 6" while a filter is set. */
  filterSummary(): string | undefined {
    if (!this.filter) return undefined;
    const { matched, total } = this.result();
    return `filter: ${this.filter} · ${matched} of ${total}`;
  }

  /** The message shown in place of an empty filtered tree. */
  emptyMessage(): string | undefined {
    return this.filter && this.result().matched === 0 ? `No projects match "${this.filter}".` : undefined;
  }

  /** Redraws the tree, for changes that do not go through the store (files created or deleted on disk). */
  refresh(): void {
    this.changed.fire();
  }

  getChildren(element?: TreeNode): TreeNode[] {
    return element ? this.registry.childrenOf(element) : this.result().roots;
  }

  /** Parents of the nodes the view shows now (filtered folders are copies), for TreeView.reveal. */
  getParent(node: TreeNode): TreeNode | undefined {
    return this.registry.parentOf(node) ?? this.parentMap().get(node) ?? this.earlierParents.get(node);
  }

  private parentMap(): Map<TreeNode, TreeNode> {
    const roots = this.result().roots;
    if (this.parents?.roots !== roots) {
      this.parents = { roots, map: parentsOf(roots) };
      for (const [child, parent] of this.parents.map) this.earlierParents.set(child, parent);
    }
    return this.parents.map;
  }

  /** A project's node in the tree as shown now; undefined when the filter hides it. */
  findProjectNode(guid: string): TreeNode | undefined {
    for (const node of [...this.result().roots, ...this.parentMap().keys()]) {
      if (node.kind === 'project' && node.project?.guid === guid) return node;
    }
    return undefined;
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const row = projectRow(node, this.store.state);
    const hasChildren = this.registry.hasChildren(node);
    // While filtering, folders open to show the matches; their own ids keep the unfiltered expansion state apart.
    const collapsible = !hasChildren
      ? vscode.TreeItemCollapsibleState.None
      : this.filter && node.kind === 'folder'
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed;
    const item = new vscode.TreeItem(row.label, collapsible);
    item.id = this.filter ? `${node.id}#filtered` : node.id;
    item.description = row.description;
    item.tooltip = row.tooltip;
    item.iconPath =
      row.themeIcon === 'file'
        ? vscode.ThemeIcon.File
        : row.themeIcon === 'folder'
          ? vscode.ThemeIcon.Folder
          : new vscode.ThemeIcon(row.icon, row.iconColor ? new vscode.ThemeColor(row.iconColor) : undefined);
    item.contextValue = row.contextValue;
    // A file row's real URI gives the file icon theme and the Explorer's decorations (git status, problems).
    item.resourceUri = row.openPath ? vscode.Uri.file(row.openPath) : vscode.Uri.parse(row.resourceUri);
    if (row.openPath) item.command = { command: 'vscode.open', title: 'Open', arguments: [item.resourceUri] };
    return item;
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
    this.filterChanged.dispose();
  }
}
