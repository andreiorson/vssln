import * as vscode from 'vscode';
import { debounce } from './coalesce';
import { ProjectsView } from './projectsView';

/** The live filter of the Projects view: an input that filters the tree as you type. */
export function registerProjectsFilter(view: ProjectsView, treeView: vscode.TreeView<unknown>): vscode.Disposable[] {
  const show = () => {
    treeView.description = view.filterSummary();
    treeView.message = view.emptyMessage();
    void vscode.commands.executeCommand('setContext', 'vssln.filtered', view.filterText !== '');
  };

  const open = () => {
    const before = view.filterText;
    const input = vscode.window.createInputBox();
    input.title = 'Filter projects';
    input.placeholder = 'Words to find in the folder path and project name, for example: gra ren';
    input.value = before;
    let accepted = false;
    const apply = debounce(() => view.setFilter(input.value), 100);
    input.onDidChangeValue(() => apply());
    input.onDidAccept(() => {
      accepted = true;
      apply.cancel();
      view.setFilter(input.value);
      input.hide();
    });
    input.onDidHide(() => {
      apply.cancel();
      // Escape gives the previous filter back.
      if (!accepted) view.setFilter(before);
      input.dispose();
    });
    input.show();
  };

  show();
  return [
    view.onDidChangeFilter(show),
    // The tree changes with reloads and builds; the counts and the empty message follow.
    view.onDidChangeTreeData(show),
    vscode.commands.registerCommand('vssln.filterProjects', open),
    vscode.commands.registerCommand('vssln.clearProjectsFilter', () => view.setFilter('')),
  ];
}
