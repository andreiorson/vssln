import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { VsslnApi } from '../../src/extension';
import { projectUri } from '../../src/ui/viewModel';

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error(`condition not met in ${timeoutMs} ms`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

async function api(): Promise<VsslnApi> {
  const a = await vscode.extensions.getExtension<VsslnApi>('local.vssln')!.activate();
  await waitFor(() => a.getState().phase === 'ready', 30000);
  return a;
}

async function runTask(action: 'Build' | 'Rebuild' | 'Clean'): Promise<void> {
  const task = (await vscode.tasks.fetchTasks({ type: 'vssln' })).find(t => t.definition.action === action);
  assert.ok(task, `no vssln ${action} task`);
  await vscode.tasks.executeTask(task);
}

const finished = (a: VsslnApi) => () => !['idle', 'running'].includes(a.getState().build.status);
const guidOf = (a: VsslnApi, name: string) => a.getState().solution!.projects.find(p => p.name === name)!.guid;

suite('build samples/Engine', () => {
  const folder = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const settingsDir = path.join(folder, '.vscode');

  suiteTeardown(() => fs.rmSync(settingsDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  test('Build task builds the solution and reports every project', async function () {
    const a = await api();
    if (!a.getState().toolchain) this.skip();
    await runTask('Build');
    await waitFor(() => a.getState().build.status === 'running', 30000);
    await waitFor(finished(a), 240000);
    const b = a.getState().build;
    assert.strictEqual(b.status, 'succeeded', `build ended as ${b.status}`);
    assert.strictEqual(b.done, 10);
    assert.strictEqual(b.projects.get(guidOf(a, 'Render'))!.status, 'succeeded');
    assert.strictEqual(b.projects.get(guidOf(a, 'Math'))!.status, 'succeeded');
  });

  test('Stop during a rebuild cancels it and leaves nothing building', async function () {
    const a = await api();
    if (!a.getState().toolchain) this.skip();
    await runTask('Rebuild');
    await waitFor(() => a.getState().build.status === 'running', 30000);
    await vscode.commands.executeCommand('vssln.stop');
    await waitFor(finished(a), 60000);
    const b = a.getState().build;
    assert.strictEqual(b.status, 'cancelled');
    assert.ok([...b.projects.values()].every(p => p.status !== 'building' && p.status !== 'waiting'));
  });

  test('a broken build fails in Math and fills Problems', async function () {
    const a = await api();
    if (!a.getState().toolchain) this.skip();
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(path.join(settingsDir, 'vssln.json'), '{ "environment": { "CL": "/DENGINE_BREAK_BUILD" } }\n');
    await waitFor(() => a.getState().settings.environment?.CL === '/DENGINE_BREAK_BUILD', 30000);

    await runTask('Rebuild');
    await waitFor(() => a.getState().build.status === 'running', 30000);
    await waitFor(finished(a), 240000);
    const b = a.getState().build;
    assert.strictEqual(b.status, 'failed');
    assert.deepStrictEqual(
      { status: b.projects.get(guidOf(a, 'Math'))!.status, errors: b.projects.get(guidOf(a, 'Math'))!.errors },
      { status: 'failed', errors: 1 },
    );

    const vector = vscode.Uri.file(path.join(folder, 'Core', 'Math', 'vector.cpp'));
    await waitFor(() => vscode.languages.getDiagnostics(vector).some(d => String(d.code).includes('C1189') || d.message.includes('ENGINE_BREAK_BUILD')), 30000);

    const math = vscode.Uri.parse(projectUri(guidOf(a, 'Math')));
    const decoration = a.views.decorations.provideFileDecoration(math);
    assert.strictEqual(decoration?.badge, '1');
  });

  test('linker errors without a source position reach Problems on the project file', async function () {
    const a = await api();
    if (!a.getState().toolchain) this.skip();
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(path.join(settingsDir, 'vssln.json'), '{ "environment": { "LINK": "/INCLUDE:vssln_missing_symbol" } }\n');
    await waitFor(() => a.getState().settings.environment?.LINK !== undefined, 30000);

    await runTask('Rebuild');
    await waitFor(() => a.getState().build.status === 'running', 30000);
    await waitFor(finished(a), 240000);
    assert.strictEqual(a.getState().build.status, 'failed');
    // The first project to link (Audio.dll) reports it; MSBuild names the project in the [...] suffix.
    const onProject = () => vscode.languages.getDiagnostics().some(([uri, list]) =>
      uri.fsPath.toLowerCase().endsWith('.vcxproj') && list.some(d => d.message.includes('vssln_missing_symbol')));
    await waitFor(onProject, 30000);
  });

  test('a settings change during a build is applied after it', async function () {
    const a = await api();
    if (!a.getState().toolchain) this.skip();
    fs.rmSync(settingsDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await waitFor(() => a.getState().settings.environment === undefined && a.getState().configuration?.name === 'Release|x64', 30000);

    await runTask('Rebuild');
    await waitFor(() => a.getState().build.status === 'running', 30000);
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(path.join(settingsDir, 'vssln.json'), '{ "configuration": "Debug|x64" }\n');
    await new Promise(resolve => setTimeout(resolve, 1500));
    if (a.getState().build.status === 'running') assert.strictEqual(a.getState().configuration?.name, 'Release|x64');
    // The deferred reload runs when the build ends; the new configuration then also resets the build row.
    await waitFor(() => a.getState().configuration?.name === 'Debug|x64', 240000);
    assert.notStrictEqual(a.getState().build.status, 'running');
  });

  test('VS Code saves dirty editors before a build task', async function () {
    const a = await api();
    if (!a.getState().toolchain) this.skip();
    const doc = await vscode.workspace.openTextDocument(path.join(folder, 'Tools', 'Legacy', 'legacy.cpp'));
    const editor = await vscode.window.showTextDocument(doc);
    await editor.edit(e => e.insert(new vscode.Position(0, 0), '// probe\n'));
    assert.ok(doc.isDirty);
    try {
      await runTask('Build');
      await waitFor(() => a.getState().build.status === 'running' || !doc.isDirty, 30000);
      await waitFor(finished(a), 240000);
      assert.strictEqual(doc.isDirty, false);
    } finally {
      await editor.edit(e => e.delete(new vscode.Range(0, 0, 1, 0)));
      await doc.save();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });
});
