import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { VsslnApi } from '../../src/extension';

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`condition not met in ${timeoutMs} ms`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/** Windows briefly refuses to recreate a folder that was just deleted while VS Code watched it. */
async function writeRetrying(file: string, text: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EPERM' || attempt >= 20) throw e;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

suite('activation', () => {
  test('loads the fixture solution', async () => {
    const ext = vscode.extensions.getExtension<VsslnApi>('local.vssln');
    assert.ok(ext, 'extension local.vssln is not installed in the test instance');
    const api = await ext.activate();
    await waitFor(() => api.getState().phase === 'ready', 10000);
    const s = api.getState();
    assert.strictEqual(s.configuration!.name, 'Release|x64');
    assert.deepStrictEqual(s.solution!.projects.map(p => p.name), ['Game', 'Math', 'Render', 'Legacy', 'Docs', 'Missing']);
    assert.strictEqual(s.solution!.projects.find(p => p.guid === s.startupProjectGuid)!.name, 'Game');
  });

  test('views are registered', async () => {
    await vscode.commands.executeCommand('vssln.projects.focus');
    await vscode.commands.executeCommand('vssln.status.focus');
  });

  suite('selection writes', () => {
    const folder = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const settingsPath = path.join(folder, '.vscode', 'vssln.json');
    const mathNode = { id: 'x', kind: 'project', label: 'Math', children: [], project: { name: 'Math' } };

    async function api(): Promise<VsslnApi> {
      return vscode.extensions.getExtension<VsslnApi>('local.vssln')!.activate();
    }

    teardown(async () => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      fs.rmSync(path.join(folder, '.vscode'), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await vscode.commands.executeCommand('vssln.refresh');
    });

    test('creating the settings file does not wait for the git exclude prompt', async () => {
      const done = vscode.commands.executeCommand('vssln.setAsStartup', mathNode);
      const result = await Promise.race([done.then(() => 'done'), new Promise(r => setTimeout(() => r('blocked'), 5000))]);
      assert.strictEqual(result, 'done');
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(settingsPath, 'utf8')), { startupProject: 'Math' });
      const s = (await api()).getState();
      assert.strictEqual(s.solution!.projects.find(p => p.guid === s.startupProjectGuid)!.name, 'Math');
    });

    test('a selection change does not write behind an unsaved vssln.json editor', async () => {
      await writeRetrying(settingsPath, '{}\n');
      const editor = await vscode.window.showTextDocument(vscode.Uri.file(settingsPath));
      await editor.edit(e => e.insert(new vscode.Position(0, 1), ' "configuration": "Debug|x64" '));
      assert.ok(editor.document.isDirty);
      await Promise.race([vscode.commands.executeCommand('vssln.setAsStartup', mathNode), new Promise(r => setTimeout(r, 3000))]);
      assert.strictEqual(fs.readFileSync(settingsPath, 'utf8'), '{}\n');
      await vscode.commands.executeCommand('workbench.action.files.revert');
    });

    test('Open settings with a key path creates the missing objects and puts the cursor on the last key', async () => {
      await writeRetrying(settingsPath, '{\n  // mine\n  "projects": { "game": {} }\n}\n');
      await vscode.commands.executeCommand('vssln.openSettings', ['projects', 'game', 'debug']);
      const editor = vscode.window.activeTextEditor!;
      assert.strictEqual(editor.document.uri.fsPath.toLowerCase(), settingsPath.toLowerCase());
      const text = editor.document.getText();
      assert.ok(text.includes('// mine'), text);
      assert.strictEqual(editor.document.offsetAt(editor.selection.active), text.indexOf('"debug"'));
      assert.deepStrictEqual(JSON.parse(text.replace('// mine', '')), { projects: { game: { debug: {} } } });
    });
  });

  test('a project shows its filters and files; a click opens a file', async () => {
    const api = await vscode.extensions.getExtension<VsslnApi>('local.vssln')!.activate();
    await waitFor(() => api.getState().phase === 'ready', 10000);
    const folder = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const view = api.views.projects;
    const game = view.getChildren().find(n => n.label === 'Game')!;
    assert.strictEqual(view.getTreeItem(game).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    const filters = view.getChildren(game);
    assert.deepStrictEqual(filters.map(n => n.label), ['Header Files', 'Resource Files', 'Source Files']);
    assert.strictEqual(view.getTreeItem(filters[1]).collapsibleState, vscode.TreeItemCollapsibleState.None);
    const sourceFiles = () => view.getChildren(view.getChildren(game).find(n => n.label === 'Source Files')!);
    assert.deepStrictEqual(sourceFiles().map(n => n.label), ['game.cpp', 'main.cpp']);
    const row = (label: string) => view.getTreeItem(sourceFiles().find(n => n.label === label)!);

    const main = row('main.cpp');
    assert.strictEqual(main.command?.command, 'vscode.open');
    assert.strictEqual((main.command!.arguments![0] as vscode.Uri).fsPath.toLowerCase(), path.join(folder, 'Game', 'main.cpp').toLowerCase());
    assert.strictEqual(main.resourceUri!.scheme, 'file');
    assert.strictEqual(main.contextValue, 'file');

    assert.strictEqual(row('game.cpp').description, 'file not found');
    assert.strictEqual(row('game.cpp').command, undefined);
    const src = path.join(folder, 'Game', 'src');
    try {
      await writeRetrying(path.join(src, 'game.cpp'), '// created by a test\n');
      await waitFor(() => row('game.cpp').description === undefined, 10000);
    } finally {
      fs.rmSync(src, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    // Deleting the folder is one event for the folder itself.
    await waitFor(() => row('game.cpp').description === 'file not found', 10000);
  });

  test('Sync with Active Document selects the open file', async () => {
    const api = await vscode.extensions.getExtension<VsslnApi>('local.vssln')!.activate();
    await waitFor(() => api.getState().phase === 'ready', 10000);
    const folder = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const { projects: view, projectsTree: tree } = api.views;
    try {
      await vscode.window.showTextDocument(vscode.Uri.file(path.join(folder, 'Game', 'main.cpp')));
      await vscode.commands.executeCommand('vssln.syncActiveFile');
      await waitFor(() => tree.selection[0]?.label === 'main.cpp', 5000);
      const chain: string[] = [];
      for (let n = view.getParent(tree.selection[0]); n; n = view.getParent(n)) chain.push(n.label);
      assert.deepStrictEqual(chain, ['Source Files', 'Game']);

      // A filter that hides Game: the command explains instead of changing the filter or the selection.
      view.setFilter('math');
      await vscode.commands.executeCommand('vssln.syncActiveFile');
      assert.strictEqual(view.filterText, 'math');
    } finally {
      view.setFilter('');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });

  test('the Projects view renders the fixture tree', async () => {
    const api = await vscode.extensions.getExtension<VsslnApi>('local.vssln')!.activate();
    await waitFor(() => api.getState().phase === 'ready', 10000);
    const roots = api.views.projects.getChildren();
    assert.deepStrictEqual(roots.map(n => n.label), ['Core', 'Tools', 'Docs', 'Game', 'Missing']);
    const game = api.views.projects.getTreeItem(roots[3]);
    assert.strictEqual(game.description, 'exe · 3 files · startup');
    assert.strictEqual(api.views.projects.getTreeItem(roots[4]).contextValue, 'project.missing');
    const statusLabels = api.views.status.getChildren().map(r => api.views.status.getTreeItem(r).label);
    assert.deepStrictEqual(statusLabels, ['Sample.sln', 'Release | x64', 'Game']);
  });

  test('the live filter shows matching projects with their folders expanded', async () => {
    const api = await vscode.extensions.getExtension<VsslnApi>('local.vssln')!.activate();
    await waitFor(() => api.getState().phase === 'ready', 10000);
    const view = api.views.projects;
    try {
      view.setFilter('gra ren');
      const [core] = view.getChildren();
      assert.deepStrictEqual(view.getChildren().map(n => n.label), ['Core']);
      assert.strictEqual(view.getTreeItem(core).collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
      const [graphics] = view.getChildren(core);
      assert.deepStrictEqual(view.getChildren(graphics).map(n => n.label), ['Render']);
      assert.strictEqual(view.filterSummary(), 'filter: gra ren · 1 of 6');

      view.setFilter('xyz');
      assert.deepStrictEqual(view.getChildren(), []);
      assert.strictEqual(view.emptyMessage(), 'No projects match "xyz".');
    } finally {
      view.setFilter('');
    }
    assert.deepStrictEqual(view.getChildren().map(n => n.label), ['Core', 'Tools', 'Docs', 'Game', 'Missing']);
    assert.strictEqual(view.filterSummary(), undefined);
  });

  test('creating a missing project file updates the tree without a manual reload', async () => {
    const api = await vscode.extensions.getExtension<VsslnApi>('local.vssln')!.activate();
    const folder = vscode.workspace.workspaceFolders![0].uri.fsPath;
    const missingDir = path.join(folder, 'Missing');
    const guid = '{66666666-6666-6666-6666-666666666666}';
    await waitFor(() => api.getState().phase === 'ready', 10000);
    assert.strictEqual(api.getState().projects.get(guid)?.exists, false);
    // VS Code starts watching asynchronously; files created right after activation are not reported.
    await new Promise(resolve => setTimeout(resolve, 3000));
    try {
      fs.mkdirSync(missingDir, { recursive: true });
      fs.copyFileSync(path.join(folder, 'Game', 'Game.vcxproj'), path.join(missingDir, 'Missing.vcxproj'));
      await waitFor(() => api.getState().projects.get(guid)?.exists === true, 5000);
    } finally {
      fs.rmSync(missingDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    await waitFor(() => api.getState().projects.get(guid)?.exists === false, 5000);
  });

  test('commands are registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of ['vssln.selectSolution', 'vssln.selectConfiguration', 'vssln.selectStartupProject', 'vssln.openSettings', 'vssln.refresh']) {
      assert.ok(commands.includes(id), `${id} is not registered`);
    }
  });
});
