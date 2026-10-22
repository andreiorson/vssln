import * as vscode from 'vscode';
import { Store } from '../state/store';
import { coalesce } from './coalesce';
import { StatusRow, statusRows } from './viewModel';

export class StatusView implements vscode.TreeDataProvider<StatusRow>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscription: { dispose(): void };

  constructor(private readonly store: Store) {
    this.subscription = store.onDidChange(coalesce(() => this.changed.fire(), 50));
  }

  getChildren(element?: StatusRow): StatusRow[] {
    return element ? [] : statusRows(this.store.state);
  }

  getTreeItem(row: StatusRow): vscode.TreeItem {
    const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
    item.id = row.id;
    item.description = row.description;
    item.tooltip = row.tooltip;
    item.iconPath = new vscode.ThemeIcon(row.icon);
    item.contextValue = row.contextValue;
    if (row.command) item.command = { command: row.command, title: row.label };
    return item;
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}
