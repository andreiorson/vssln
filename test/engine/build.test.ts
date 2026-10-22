import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { VsslnApi } from '../../src/extension';

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
  });
});
