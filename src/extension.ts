import * as vscode from 'vscode';
import { ChildrenRegistry } from './solution/model';
import { AppState, Store } from './state/store';
import { BuildTasks, registerBuildCommands } from './ui/buildTasks';
import { debounce } from './ui/coalesce';
import { Controller, registerCommands } from './ui/commands';
import { PROJECT_SCHEME, ProjectDecorations } from './ui/decorations';
import { registerProjectsFilter } from './ui/projectsFilter';
import { ProjectsView } from './ui/projectsView';
import { StatusBar } from './ui/statusBar';
import { StatusView } from './ui/statusView';
import { deletionAffects } from './util/paths';

export interface VsslnApi {
  getState(): AppState;
  /** The tree data providers behind the side bar, for tests and other extensions. */
  views: { status: StatusView; projects: ProjectsView; decorations: ProjectDecorations };
}

export function activate(context: vscode.ExtensionContext): VsslnApi {
  const log = vscode.window.createOutputChannel('VS Solution', { log: true });
  const store = new Store();
  const registry = new ChildrenRegistry();
  const controller = new Controller(store, log);
  const builds = new BuildTasks(store, context.logUri.fsPath, log);

  const statusView = new StatusView(store);
  const projectsView = new ProjectsView(store, registry);
  const decorations = new ProjectDecorations(store);
  const projectsTree = vscode.window.createTreeView('vssln.projects', { treeDataProvider: projectsView, showCollapseAll: true });
  const reload = debounce(() => void controller.reload(), 300);

  // Project files matter too: a created Missing project or added sources change the tree.
  const watchers = ['**/.vscode/vssln.json', '**/*.sln', '**/*.vcxproj'].map(glob => vscode.workspace.createFileSystemWatcher(glob));
  for (const watcher of watchers) {
    watcher.onDidCreate(reload);
    watcher.onDidChange(reload);
    watcher.onDidDelete(reload);
  }
  // A deleted folder is reported once for the folder itself, which the globs above do not match.
  const deletions = vscode.workspace.createFileSystemWatcher('**/*', true, true, false);
  deletions.onDidDelete(uri => {
    if (deletionAffects(uri.fsPath, store.state)) reload();
  });
  watchers.push(deletions);

  let building = false;
  const setContext = (s: AppState) => {
    void vscode.commands.executeCommand('setContext', 'vssln.phase', s.phase);
    if (building !== (s.build.status === 'running')) {
      building = s.build.status === 'running';
      void vscode.commands.executeCommand('setContext', 'vssln.building', building);
    }
  };
  setContext(store.state);

  context.subscriptions.push(
    log,
    statusView,
    projectsView,
    decorations,
    new StatusBar(store),
    vscode.window.createTreeView('vssln.status', { treeDataProvider: statusView }),
    projectsTree,
    ...registerProjectsFilter(projectsView, projectsTree),
    vscode.window.registerFileDecorationProvider(decorations),
    ...watchers,
    { dispose: () => reload.cancel() },
    vscode.workspace.onDidChangeWorkspaceFolders(reload),
    store.onDidChange(setContext),
    builds,
    controller,
    ...registerCommands(store, controller, log),
    ...registerBuildCommands(builds),
  );

  void controller.reload();
  log.info(`Activated; project decorations use the ${PROJECT_SCHEME} scheme.`);

  return { getState: () => store.state, views: { status: statusView, projects: projectsView, decorations } };
}

export function deactivate(): void {}
