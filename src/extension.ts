import * as vscode from 'vscode';
import { ChildrenRegistry } from './solution/model';
import { AppState, Store } from './state/store';
import { debounce } from './ui/coalesce';
import { Controller, registerCommands } from './ui/commands';
import { PROJECT_SCHEME, ProjectDecorations } from './ui/decorations';
import { ProjectsView } from './ui/projectsView';
import { StatusBar } from './ui/statusBar';
import { StatusView } from './ui/statusView';

export interface VsslnApi {
  getState(): AppState;
}

export function activate(context: vscode.ExtensionContext): VsslnApi {
  const log = vscode.window.createOutputChannel('VS Solution', { log: true });
  const store = new Store();
  const registry = new ChildrenRegistry();
  const controller = new Controller(store, log);

  const statusView = new StatusView(store);
  const projectsView = new ProjectsView(store, registry);
  const decorations = new ProjectDecorations(store);
  const reload = debounce(() => void controller.reload(), 300);

  const settingsWatcher = vscode.workspace.createFileSystemWatcher('**/.vscode/vssln.json');
  const slnWatcher = vscode.workspace.createFileSystemWatcher('**/*.sln');
  for (const watcher of [settingsWatcher, slnWatcher]) {
    watcher.onDidCreate(reload);
    watcher.onDidChange(reload);
    watcher.onDidDelete(reload);
  }

  const setPhase = (s: AppState) => void vscode.commands.executeCommand('setContext', 'vssln.phase', s.phase);
  setPhase(store.state);

  context.subscriptions.push(
    log,
    statusView,
    projectsView,
    decorations,
    new StatusBar(store),
    vscode.window.createTreeView('vssln.status', { treeDataProvider: statusView }),
    vscode.window.createTreeView('vssln.projects', { treeDataProvider: projectsView, showCollapseAll: true }),
    vscode.window.registerFileDecorationProvider(decorations),
    settingsWatcher,
    slnWatcher,
    vscode.workspace.onDidChangeWorkspaceFolders(reload),
    store.onDidChange(setPhase),
    ...registerCommands(store, controller, log),
  );

  void controller.reload();
  log.info(`Activated; project decorations use the ${PROJECT_SCHEME} scheme.`);

  return { getState: () => store.state };
}

export function deactivate(): void {}
