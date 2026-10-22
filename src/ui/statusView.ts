import * as vscode from 'vscode';
import { Store } from '../state/store';
import { coalesce } from './coalesce';
import { StatusRow, statusRows } from './viewModel';

export class StatusView implements vscode.TreeDataProvider<StatusRow>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscription: { dispose(): void };
  private ticker?: ReturnType<typeof setInterval>;

  constructor(private readonly store: Store) {
    const refresh = coalesce(() => this.changed.fire(), 50);
    this.subscription = store.onDidChange(s => {
      refresh();
      this.tick(s.build.status === 'running');
    });
  }

  /** The elapsed time of a running build moves even when no project finishes. */
  private tick(running: boolean): void {
    if (running && !this.ticker) this.ticker = setInterval(() => this.changed.fire(), 1000);
    if (!running && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
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
    this.tick(false);
    this.subscription.dispose();
    this.changed.dispose();
  }
}
