import * as vscode from 'vscode';
import { FilterResult, filterTree } from '../solution/filter';
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

  getChildren(element?: TreeNode): TreeNode[] {
    return element ? this.registry.childrenOf(element) : this.result().roots;
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
    item.iconPath = new vscode.ThemeIcon(row.icon);
    item.contextValue = row.contextValue;
    item.resourceUri = vscode.Uri.parse(row.resourceUri);
    return item;
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
    this.filterChanged.dispose();
  }
}
