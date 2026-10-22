import * as assert from 'assert';
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

  test('commands are registered', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of ['vssln.selectSolution', 'vssln.selectConfiguration', 'vssln.selectStartupProject', 'vssln.openSettings', 'vssln.refresh']) {
      assert.ok(commands.includes(id), `${id} is not registered`);
    }
  });
});
