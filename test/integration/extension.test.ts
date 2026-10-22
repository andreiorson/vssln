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
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, '{}\n');
      const editor = await vscode.window.showTextDocument(vscode.Uri.file(settingsPath));
      await editor.edit(e => e.insert(new vscode.Position(0, 1), ' "configuration": "Debug|x64" '));
      assert.ok(editor.document.isDirty);
      await Promise.race([vscode.commands.executeCommand('vssln.setAsStartup', mathNode), new Promise(r => setTimeout(r, 3000))]);
      assert.strictEqual(fs.readFileSync(settingsPath, 'utf8'), '{}\n');
      await vscode.commands.executeCommand('workbench.action.files.revert');
    });
  });

  test('commands are registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of ['vssln.selectSolution', 'vssln.selectConfiguration', 'vssln.selectStartupProject', 'vssln.openSettings', 'vssln.refresh']) {
      assert.ok(commands.includes(id), `${id} is not registered`);
    }
  });
});
