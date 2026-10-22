import * as path from 'path';
import * as vscode from 'vscode';
import { addToExclude, isIgnored } from '../settings/gitExclude';
import { ensureObjectKey, SelectionKey } from '../settings/settings';
import { SETTINGS_RELATIVE_PATH, SettingsFile, SettingsSyntaxError } from '../settings/settingsFile';
import { TreeNode } from '../solution/model';
import { loadWorkspace } from '../state/loader';
import { Store } from '../state/store';
import { folderOf, samePath } from '../util/paths';
import { exec, loaderDeps, nodeFs, workspaceFolders } from './host';
import { configurationItems, PickItem, solutionItems, startupItems } from './pickItems';

/** Loads the workspace into the store and applies the user's selections to the settings file. */
export class Controller {
  private generation = 0;

  constructor(private readonly store: Store, private readonly log: vscode.LogOutputChannel) {}

  async reload(): Promise<void> {
    const generation = ++this.generation;
    try {
      const state = await loadWorkspace(loaderDeps());
      if (generation !== this.generation) return;
      this.store.set(state);
      const sln = state.solution ? `${path.basename(state.solution.path)}, ${state.configuration?.name ?? 'no configuration'}` : 'no solution';
      this.log.info(`Loaded: ${sln}; ${state.projects.size} C++ projects; toolchain ${state.toolchain?.displayName ?? 'not found'}.`);
      for (const p of state.problems) (p.severity === 'error' ? this.log.error : this.log.warn).call(this.log, p.message);
    } catch (e) {
      this.log.error(`Loading the workspace failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    }
  }

  settingsFolder(): string | undefined {
    return this.store.state.folder ?? workspaceFolders()[0];
  }

  /** Writes one selection into the folder's vssln.json, offers the git exclude once, and reloads. */
  async writeSelection(key: SelectionKey, value: string, folder = this.settingsFolder()): Promise<void> {
    if (!folder) return;
    const file = new SettingsFile(folder, nodeFs);
    if (vscode.workspace.textDocuments.some(d => d.isDirty && d.uri.scheme === 'file' && samePath(d.uri.fsPath, file.path))) {
      void vscode.window.showWarningMessage('vssln.json has unsaved changes. Save or revert it before changing the selection.');
      return;
    }
    try {
      const { created } = await file.writeSelection(key, value);
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

  /** Opens vssln.json, creating it when missing; optionally makes sure a top-level object key exists and reveals it. */
  async openSettings(revealKey?: string): Promise<void> {
    const folder = this.settingsFolder();
    if (!folder) {
      void vscode.window.showInformationMessage('Open a folder to use VS Solution settings.');
      return;
    }
    const file = new SettingsFile(folder, nodeFs);
    const current = await nodeFs.readText(file.path);
    const parsed = await file.read();
    let text = current ?? '{\n}\n';
    if (revealKey && parsed.syntaxOk) text = ensureObjectKey(text, revealKey);
    if (text !== current) await nodeFs.writeText(file.path, text);

    const editor = await vscode.window.showTextDocument(vscode.Uri.file(file.path));
    if (current === undefined) void this.offerGitExclude(folder);
    if (revealKey) {
      const offset = editor.document.getText().indexOf(`"${revealKey}"`);
      if (offset >= 0) {
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
  return node?.project?.absPath;
}

export function registerCommands(store: Store, controller: Controller, log: vscode.LogOutputChannel): vscode.Disposable[] {
  const register = (id: string, fn: (...args: any[]) => unknown) => vscode.commands.registerCommand(id, fn);

  return [
    register('vssln.selectSolution', async () => {
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
      await controller.writeSelection('solution', path.relative(folder, choice.value).replace(/\\/g, '/'), folder);
    }),

    register('vssln.selectConfiguration', async () => {
      const choice = await pick(configurationItems(store.state), 'Select a solution configuration');
      if (choice) await controller.writeSelection('configuration', choice.value);
    }),

    register('vssln.selectStartupProject', async () => {
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

    register('vssln.setAsStartup', async (node?: TreeNode) => {
      if (node?.project) await controller.writeSelection('startupProject', node.project.name);
    }),

    register('vssln.openSettings', () => controller.openSettings()),
    register('vssln.configureToolchain', () => controller.openSettings('toolchain')),
    register('vssln.refresh', () => controller.reload()),
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
