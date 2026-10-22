import * as fs from 'fs';
import * as vscode from 'vscode';
import { ChildrenRegistry, TreeNode } from './solution/model';
import { AppState, Store } from './state/store';
import { Builds, registerBuildCommands } from './ui/builds';
import { coalesce, debounce } from './ui/coalesce';
import { Debugging, registerDebugging } from './ui/debugging';
import { Controller, registerCommands } from './ui/commands';
import { IntelliSenseApi, registerIntelliSense } from './ui/intellisense';
import { PROJECT_SCHEME, ProjectDecorations } from './ui/decorations';
import { registerProjectsFilter } from './ui/projectsFilter';
import { ProjectItemsProvider } from './ui/projectItems';
import { ProjectsView } from './ui/projectsView';
import { StatusBar } from './ui/statusBar';
import { StatusView } from './ui/statusView';
import { registerSyncActiveFile } from './ui/syncActiveFile';
import { deletionAffects } from './util/paths';

export interface VsslnApi {
  getState(): AppState;
  /** The tree data providers behind the side bar, for tests and other extensions. */
  views: { status: StatusView; projects: ProjectsView; projectsTree: vscode.TreeView<TreeNode>; decorations: ProjectDecorations };
  /** Builds without the confirmation dialogs, for tests and other extensions. */
  builds: Pick<Builds, 'run' | 'stop'>;
  /** Launch configurations without building or starting, for tests and other extensions. */
  debugging: Pick<Debugging, 'resolve' | 'launch' | 'evaluate'>;
  /** The IntelliSense engine and the configuration cpptools gets for a file, for tests. */
  intellisense: IntelliSenseApi;
}

export function activate(context: vscode.ExtensionContext): VsslnApi {
  const log = vscode.window.createOutputChannel('VS Solution', { log: true });
  const store = new Store();
  const registry = new ChildrenRegistry();
  const items = new ProjectItemsProvider(store, p => fs.existsSync(p));
  registry.register(items);
  const controller = new Controller(store, log);
  const builds = new Builds(store, context.logUri.fsPath, log, () => controller.reload());
  const debugging = new Debugging(store, builds, context.asAbsolutePath('resources/vssln-debug.targets'), log);

  const intellisense = registerIntelliSense(context, store, log);
  const statusView = new StatusView(store);
  const projectsView = new ProjectsView(store, registry);
  // A checkout touches many files at once: one redraw for the burst.
  const itemsChanged = items.onDidChange(coalesce(() => projectsView.refresh(), 50));
  const decorations = new ProjectDecorations(store);
  const projectsTree = vscode.window.createTreeView('vssln.projects', { treeDataProvider: projectsView, showCollapseAll: true });
  const reload = debounce(() => void controller.reload(), 300);

  // Project files matter too: a created Missing project or added sources change the tree.
  const watchers = ['**/.vscode/vssln.json', '**/*.sln', '**/*.vcxproj', '**/*.vcxproj.filters'].map(glob => vscode.workspace.createFileSystemWatcher(glob));
  for (const watcher of watchers) {
    watcher.onDidCreate(reload);
    watcher.onDidChange(reload);
    watcher.onDidDelete(reload);
  }
  // A deleted folder is reported once for the folder itself, which the globs above do not match. Created and deleted
  // files also refresh the projects that list them (greyed out while missing).
  const files = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
  files.onDidCreate(uri => items.fileChanged(uri.fsPath));
  files.onDidDelete(uri => {
    if (deletionAffects(uri.fsPath, store.state)) reload();
    items.fileChanged(uri.fsPath);
  });
  watchers.push(files);

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
    itemsChanged,
    decorations,
    new StatusBar(store),
    vscode.window.createTreeView('vssln.status', { treeDataProvider: statusView }),
    projectsTree,
    projectsTree.onDidCollapseElement(e => items.collapsed(e.element)),
    ...registerProjectsFilter(projectsView, projectsTree),
    ...registerSyncActiveFile(store, projectsView, projectsTree),
    vscode.window.registerFileDecorationProvider(decorations),
    ...watchers,
    { dispose: () => reload.cancel() },
    vscode.workspace.onDidChangeWorkspaceFolders(reload),
    store.onDidChange(setContext),
    builds,
    controller,
    ...registerCommands(store, controller, log),
    ...registerBuildCommands(builds),
    ...registerDebugging(debugging, store),
    ...intellisense.disposables,
  );

  void controller.reload();
  log.info(`Activated; project decorations use the ${PROJECT_SCHEME} scheme.`);

  return { getState: () => store.state, views: { status: statusView, projects: projectsView, projectsTree, decorations }, builds, debugging, intellisense: intellisense.api };
}

export function deactivate(): void {}
