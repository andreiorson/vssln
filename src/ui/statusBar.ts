import * as vscode from 'vscode';
import { Store } from '../state/store';
import { statusBarItems } from './viewModel';

const NAMES: Record<string, string> = {
  configuration: 'VS Solution configuration',
  startup: 'VS Solution startup project',
  build: 'VS Solution build',
};

export class StatusBar implements vscode.Disposable {
  private readonly items = new Map<string, vscode.StatusBarItem>();
  private readonly subscription: { dispose(): void };

  constructor(private readonly store: Store) {
    this.subscription = store.onDidChange(() => this.update());
    this.update();
  }

  private item(id: string, priority: number): vscode.StatusBarItem {
    let item = this.items.get(id);
    if (!item) {
      item = vscode.window.createStatusBarItem(`vssln.${id}`, vscode.StatusBarAlignment.Left, priority);
      item.name = NAMES[id] ?? 'VS Solution';
      this.items.set(id, item);
    }
    return item;
  }

  private update(): void {
    const entries = statusBarItems(this.store.state);
    const shown = new Set<string>(entries.map(e => e.id));
    entries.forEach((entry, i) => {
      const item = this.item(entry.id, 10 - i);
      item.text = entry.text;
      item.tooltip = entry.tooltip;
      item.command = entry.command;
      item.show();
    });
    for (const [id, item] of this.items) if (!shown.has(id)) item.hide();
  }

  dispose(): void {
    this.subscription.dispose();
    for (const item of this.items.values()) item.dispose();
  }
}
