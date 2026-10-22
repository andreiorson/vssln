import * as vscode from 'vscode';
import { buildTree, ChildrenRegistry, TreeNode } from '../solution/model';
import { ParsedSolution } from '../solution/slnParser';
import { Store } from '../state/store';
import { coalesce } from './coalesce';
import { projectRow } from './viewModel';

export class ProjectsView implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscription: { dispose(): void };
  private cache?: { solution: ParsedSolution; roots: TreeNode[] };

  constructor(private readonly store: Store, private readonly registry: ChildrenRegistry) {
    this.subscription = store.onDidChange(coalesce(() => this.changed.fire(), 50));
  }

  private roots(): TreeNode[] {
    const solution = this.store.state.solution;
    if (!solution) return [];
    if (this.cache?.solution !== solution) this.cache = { solution, roots: buildTree(solution) };
    return this.cache.roots;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    return element ? this.registry.childrenOf(element) : this.roots();
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const row = projectRow(node, this.store.state);
    const collapsible = this.registry.hasChildren(node)
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(row.label, collapsible);
    item.id = node.id;
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
  }
}
