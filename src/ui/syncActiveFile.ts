import * as path from 'path';
import * as vscode from 'vscode';
import { findItemNode, projectsListing } from '../solution/locate';
import { TreeNode } from '../solution/model';
import { Store } from '../state/store';
import { ProjectsView } from './projectsView';

/** The file of the active editor, or of the active tab when that is not a text editor (an image, a diff). */
function activeFile(): string | undefined {
  const editorUri = vscode.window.activeTextEditor?.document.uri;
  if (editorUri?.scheme === 'file') return editorUri.fsPath;
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  const uri = input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom ? input.uri : input instanceof vscode.TabInputTextDiff ? input.modified : undefined;
  return uri?.scheme === 'file' ? uri.fsPath : undefined;
}

/** Sync with Active Document, as in Visual Studio: selects the active editor's file in the Projects tree. */
export function registerSyncActiveFile(store: Store, view: ProjectsView, treeView: vscode.TreeView<TreeNode>): vscode.Disposable[] {
  // Messages are not awaited: the command ends while a notification stays open.
  const inform = (message: string, ...actions: string[]) => vscode.window.showInformationMessage(message, ...actions);

  const reveal = async (file: string, guid: string): Promise<void> => {
    const project = view.findProjectNode(guid);
    if (!project) return;
    const node = findItemNode(view.getChildren(project), file);
    if (node) await treeView.reveal(node, { select: true, focus: true, expand: false });
  };

  const sync = async (): Promise<void> => {
    const s = store.state;
    const file = activeFile();
    if (!file) {
      void inform('No file is open.');
      return;
    }
    if (!s.solution) return;
    const name = path.win32.basename(file);
    const guids = projectsListing(s, file);
    if (guids.length === 0) {
      void inform(`${name} is not in any project of ${path.win32.basename(s.solution.path)}.`);
      return;
    }
    const shown = guids.find(guid => view.findProjectNode(guid));
    if (shown) {
      await reveal(file, shown);
      return;
    }
    const project = s.solution.projects.find(p => p.guid === guids[0])?.name ?? '';
    void inform(`${name} is in ${project}, which the filter hides.`, 'Clear filter').then(async choice => {
      if (choice !== 'Clear filter') return;
      view.setFilter('');
      await reveal(file, guids[0]);
    });
  };

  return [vscode.commands.registerCommand('vssln.syncActiveFile', sync)];
}
