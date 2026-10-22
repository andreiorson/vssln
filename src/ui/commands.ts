import * as path from 'path';
import * as vscode from 'vscode';
import { addToExclude, isIgnored } from '../settings/gitExclude';
import { ensureObjectPath, keyOffset, SelectionKey } from '../settings/settings';
import { SETTINGS_RELATIVE_PATH, SettingsFile, SettingsSyntaxError, writeSolutionSelection } from '../settings/settingsFile';
import { TreeNode } from '../solution/model';
import { loadWorkspace } from '../state/loader';
import { carryBuild } from '../state/build';
import { failedState, Store } from '../state/store';
import { cachedToolchain } from '../toolchain/vswhere';
import { folderOf, samePath } from '../util/paths';
import { exec, findRealToolchain, loaderDeps, nodeFs, workspaceFolders } from './host';
import { configurationItems, PickItem, solutionItems, startupItems } from './pickItems';

/** Loads the workspace into the store and applies the user's selections to the settings file. */
export class Controller implements vscode.Disposable {
  private generation = 0;
  private readonly toolchain = cachedToolchain(findRealToolchain);
  private pendingReload?: { fresh: boolean };
  private readonly subscription: { dispose(): void };

  constructor(private readonly store: Store, private readonly log: vscode.LogOutputChannel) {
    // A reload asked for during a build runs when the build ends.
    this.subscription = store.onDidChange(s => {
      if (!this.pendingReload || s.build.status === 'running') return;
      const { fresh } = this.pendingReload;
      this.pendingReload = undefined;
      void this.reload(fresh);
    });
  }

  /**
   * Reloads the workspace; `fresh` also forgets the cached Visual Studio lookup (the Reload command). During a build
   * the reload waits: the solution, configuration and toolchain cannot change under a running build (spec 6).
   */
  async reload(fresh = false): Promise<void> {
    if (this.store.state.build.status === 'running') {
      this.pendingReload = { fresh: fresh || (this.pendingReload?.fresh ?? false) };
      this.log.info('Reload deferred until the build ends.');
      return;
    }
    if (fresh) this.toolchain.clear();
    const generation = ++this.generation;
    try {
      const state = await loadWorkspace(loaderDeps(opts => this.toolchain.find(opts)));
      if (generation !== this.generation) return;
      // The IntelliSense engine starts a new pass for the new state; until then the old progress stays visible.
      this.store.set({ ...state, build: carryBuild(this.store.state, state), intellisense: this.store.state.intellisense });
      const sln = state.solution ? `${path.basename(state.solution.path)}, ${state.configuration?.name ?? 'no configuration'}` : 'no solution';
      this.log.info(`Loaded: ${sln}; ${state.projects.size} C++ projects; toolchain ${state.toolchain?.displayName ?? 'not found'}.`);
      for (const p of state.problems) (p.severity === 'error' ? this.log.error : this.log.warn).call(this.log, p.message);
    } catch (e) {
      this.log.error(`Loading the workspace failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      if (generation === this.generation) {
        this.store.set({ ...failedState('Loading the workspace failed. See the log for details.'), build: this.store.state.build });
      }
    }
  }

  dispose(): void {
    this.subscription.dispose();
  }

  settingsFolder(): string | undefined {
    return this.store.state.folder ?? workspaceFolders()[0];
  }

  /** Writes one selection into the folder's vssln.json, offers the git exclude once, and reloads. */
  async writeSelection(key: SelectionKey, value: string): Promise<void> {
    const folder = this.settingsFolder();
    if (folder) await this.write(folder, [folder], () => new SettingsFile(folder, nodeFs).writeSelection(key, value));
  }

  /** Selects a solution: its folder's file gets it, the other folders' files lose theirs (spec 5, multi-root). */
  async writeSolution(folder: string, relPath: string): Promise<void> {
    const folders = workspaceFolders();
    await this.write(folder, folders, () => writeSolutionSelection(folders, folder, relPath, nodeFs));
  }

  private async write(folder: string, touched: string[], change: () => Promise<{ created: boolean }>): Promise<void> {
    const paths = touched.map(f => new SettingsFile(f, nodeFs).path);
    if (vscode.workspace.textDocuments.some(d => d.isDirty && d.uri.scheme === 'file' && paths.some(p => samePath(d.uri.fsPath, p)))) {
      void vscode.window.showWarningMessage('vssln.json has unsaved changes. Save or revert it before changing the selection.');
      return;
    }
    try {
      const { created } = await change();
      // The prompt stays pending until the notification is closed, so it must not hold up the reload.
      if (created) void this.offerGitExclude(folder);
    } catch (e) {
      if (!(e instanceof SettingsSyntaxError)) throw e;
      const open = 'Open settings';
      const choice = await vscode.window.showErrorMessage('vssln.json has a syntax error. Fix it before changing the selection.', open);
      if (choice === open) await this.openSettings();
      return;
    }
    await this.reload();
  }

  private async offerGitExclude(folder: string): Promise<void> {
    if ((await isIgnored(exec, folder, SETTINGS_RELATIVE_PATH)) !== false) return;
    const add = 'Add to exclude';
    const choice = await vscode.window.showInformationMessage(
      "Keep .vscode/vssln.json out of git? It's added to .git/info/exclude, not .gitignore.",
      add,
      'Not now',
    );
    if (choice !== add) return;
    try {
      await addToExclude(exec, nodeFs, folder, SETTINGS_RELATIVE_PATH);
    } catch (e) {
      this.log.error(`Adding vssln.json to .git/info/exclude failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Opens vssln.json, creating it when missing; optionally makes sure the objects of a key path exist and reveals it. */
  async openSettings(revealPath?: string[]): Promise<void> {
    const folder = this.settingsFolder();
    if (!folder) {
      void vscode.window.showInformationMessage('Open a folder to use VS Solution settings.');
      return;
    }
    const file = new SettingsFile(folder, nodeFs);
    const current = await nodeFs.readText(file.path);
    const parsed = await file.read();
    let text = current ?? '{\n}\n';
    if (revealPath && parsed.syntaxOk) text = ensureObjectPath(text, revealPath);
    if (text !== current) await nodeFs.writeText(file.path, text);

    const editor = await vscode.window.showTextDocument(vscode.Uri.file(file.path));
    // A document VS Code still holds from before the file changed on disk is reloaded, unless it has unsaved edits.
    if (!editor.document.isDirty && editor.document.getText() !== text.replace(/^﻿/, '')) {
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
    if (current === undefined) void this.offerGitExclude(folder);
    if (revealPath) {
      const offset = keyOffset(editor.document.getText(), revealPath);
      if (offset !== undefined) {
        const pos = editor.document.positionAt(offset);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    }
  }
}

async function pick<T>(items: PickItem<T>[], placeHolder: string): Promise<PickItem<T> | undefined> {
  return vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true });
}

function nodePath(node: TreeNode | undefined): string | undefined {
  return node?.project?.absPath ?? node?.item?.path;
}

export function registerCommands(store: Store, controller: Controller, log: vscode.LogOutputChannel): vscode.Disposable[] {
  const register = (id: string, fn: (...args: any[]) => unknown) => vscode.commands.registerCommand(id, fn);
  // The build uses the selection it started with, so it cannot change underneath it.
  const unlocked = (fn: (...args: any[]) => unknown) => (...args: any[]) => {
    if (store.state.build.status === 'running') {
      void vscode.window.showInformationMessage('Wait for the build to finish or stop it.');
      return;
    }
    return fn(...args);
  };
  const registerLocked = (id: string, fn: (...args: any[]) => unknown) => register(id, unlocked(fn));

  return [
    registerLocked('vssln.selectSolution', async () => {
      const s = store.state;
      if (s.solutions.length === 0) {
        void vscode.window.showInformationMessage('No .sln files found in this workspace.');
        return;
      }
      const folders = workspaceFolders();
      const choice = await pick(solutionItems(s.solutions, folders, s.solution?.path), 'Select a solution');
      if (!choice) return;
      const folder = folderOf(folders, choice.value) ?? controller.settingsFolder();
      if (!folder) return;
      await controller.writeSolution(folder, path.relative(folder, choice.value).replace(/\\/g, '/'));
    }),

    registerLocked('vssln.selectConfiguration', async () => {
      const choice = await pick(configurationItems(store.state), 'Select a solution configuration');
      if (choice) await controller.writeSelection('configuration', choice.value);
    }),

    registerLocked('vssln.selectStartupProject', async () => {
      let showAll = false;
      for (;;) {
        const choice = await pick(startupItems(store.state, showAll), 'Select the startup project');
        if (!choice) return;
        if (choice.value === 'showAll') {
          showAll = true;
          continue;
        }
        await controller.writeSelection('startupProject', choice.label);
        return;
      }
    }),

    registerLocked('vssln.setAsStartup', async (node?: TreeNode) => {
      if (node?.project) await controller.writeSelection('startupProject', node.project.name);
    }),

    register('vssln.openSettings', (path?: unknown) => controller.openSettings(Array.isArray(path) && path.every(k => typeof k === 'string') ? path : undefined)),
    register('vssln.configureToolchain', () => controller.openSettings(['toolchain'])),
    register('vssln.refresh', () => controller.reload(true)),
    register('vssln.showLog', () => log.show()),

    register('vssln.openProjectFile', async (node?: TreeNode) => {
      const p = nodePath(node);
      if (p) await vscode.window.showTextDocument(vscode.Uri.file(p));
    }),
    register('vssln.revealInExplorer', async (node?: TreeNode) => {
      const p = nodePath(node);
      if (p) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(p));
    }),
    register('vssln.copyPath', async (node?: TreeNode) => {
      const p = nodePath(node);
      if (p) await vscode.env.clipboard.writeText(p);
    }),
  ];
}
