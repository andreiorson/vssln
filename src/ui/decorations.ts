import * as vscode from 'vscode';
import { Store } from '../state/store';
import { coalesce } from './coalesce';
import { projectDecoration } from './viewModel';

export const PROJECT_SCHEME = 'vssln-project';

/** Greys out inactive projects and marks failed builds (colour and error-count badge), the way the Explorer decorates files. */
export class ProjectDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this.changed.event;
  private readonly subscription: { dispose(): void };

  constructor(private readonly store: Store) {
    this.subscription = store.onDidChange(coalesce(() => this.changed.fire(undefined), 50));
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== PROJECT_SCHEME) return undefined;
    const d = projectDecoration(uri.toString(), this.store.state);
    if (!d) return undefined;
    const decoration = new vscode.FileDecoration(d.badge, d.tooltip, d.color ? new vscode.ThemeColor(d.color) : undefined);
    decoration.propagate = false;
    return decoration;
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}
