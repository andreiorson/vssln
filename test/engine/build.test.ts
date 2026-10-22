import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { VsslnApi } from '../../src/extension';
import { api, guidOf, waitFor, writeSettings } from './helpers';
import { projectUri } from '../../src/ui/viewModel';

/** Starts a build without the confirmation dialog and returns once it is running. */
async function startBuild(a: VsslnApi, action: 'Build' | 'Rebuild' | 'Clean'): Promise<{ done: Promise<unknown> }> {
  const done = a.builds.run(action);
  // A refused build ends at once: report its reason instead of waiting for a timeout.
  const early = await Promise.race([done, waitFor(() => a.getState().build.status === 'running', 30000).then(() => undefined)]);
  if (early && (early as { started: boolean }).started === false) assert.fail(`build refused: ${(early as { reason: string }).reason}`);
  // Wrapped: an async function would otherwise wait for the returned promise.
  return { done };
}

const finished = (a: VsslnApi) => () => !['idle', 'running'].includes(a.getState().build.status);

suite('build samples/Engine', () => {
  const folder = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const settingsDir = path.join(folder, '.vscode');

  suiteTeardown(() => fs.rmSync(settingsDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  test('Build builds the solution, reports every project and opens no terminal', async function () {
    const a = await api();
    if (!a.getState().toolchain) this.skip();
    const terminals = vscode.window.terminals.length;
    await (await startBuild(a, 'Build')).done;
    const b = a.getState().build;
    assert.strictEqual(b.status, 'succeeded', `build ended as ${b.status}`);
    assert.strictEqual(vscode.window.terminals.length, terminals);
    assert.strictEqual(b.done, 11);
    assert.strictEqual(b.projects.get(guidOf(a, 'Render'))!.status, 'succeeded');
    assert.strictEqual(b.projects.get(guidOf(a, 'Math'))!.status, 'succeeded');
  });

  test('a project that imports what another project produces builds from a clean state, in waves', async function () {
    const a = await api();
    if (!a.getState().toolchain) this.skip();
    // Platform imports out\generated\deps.props, which only building Deps (listed last in the .sln) writes.
    await (await startBuild(a, 'Clean')).done;
    fs.rmSync(path.join(folder, 'out', 'generated', 'deps.props'), { force: true });
    await (await startBuild(a, 'Build')).done;
    const b = a.getState().build;
    assert.strictEqual(b.status, 'succeeded', `build ended as ${b.status}`);
    const deps = b.projects.get(guidOf(a, 'Deps'))!;
    const platform = b.projects.get(guidOf(a, 'Platform'))!;
    assert.strictEqual(platform.status, 'succeeded');
    assert.ok(deps.finishedAt! <= platform.startedAt!, 'Platform started before Deps finished');
  });

  test('Stop during a rebuild cancels it and leaves nothing building', async function () {
    const a = await api();
    if (!a.getState().toolchain) this.skip();
    const { done } = await startBuild(a, 'Rebuild');
    await vscode.commands.executeCommand('vssln.stop');
    await done;
    const b = a.getState().build;
    assert.strictEqual(b.status, 'cancelled');
    assert.ok([...b.projects.values()].every(p => p.status !== 'building' && p.status !== 'waiting'));
  });

  test('a broken build fails in Math and fills Problems', async function () {
    const a = await api();
    if (!a.getState().toolchain) this.skip();
    await writeSettings(settingsDir, '{ "environment": { "CL": "/DENGINE_BREAK_BUILD" } }\n');
    await waitFor(() => a.getState().settings.environment?.CL === '/DENGINE_BREAK_BUILD', 30000);

    await (await startBuild(a, 'Rebuild')).done;
    const b = a.getState().build;
    assert.strictEqual(b.status, 'failed');
    assert.deepStrictEqual(
      { status: b.projects.get(guidOf(a, 'Math'))!.status, errors: b.projects.get(guidOf(a, 'Math'))!.errors },
      { status: 'failed', errors: 1 },
    );

    const vector = vscode.Uri.file(path.join(folder, 'Core', 'Math', 'vector.cpp'));
    await waitFor(() => vscode.languages.getDiagnostics(vector).some(d => String(d.code).includes('C1189')), 30000);
    const c1189 = vscode.languages.getDiagnostics(vector).find(d => String(d.code).includes('C1189'))!;
    assert.strictEqual(c1189.range.start.line, 3);
    assert.strictEqual(c1189.source, 'MSBuild');

    const math = vscode.Uri.parse(projectUri(guidOf(a, 'Math')));
    const decoration = a.views.decorations.provideFileDecoration(math);
    assert.strictEqual(decoration?.badge, '1');
  });

  test('a successful build after a failed one clears Problems', async function () {
    const a = await api();
    if (!a.getState().toolchain) this.skip();
    fs.rmSync(settingsDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await waitFor(() => a.getState().settings.environment === undefined, 30000);
    await (await startBuild(a, 'Rebuild')).done;
    assert.strictEqual(a.getState().build.status, 'succeeded');
    const vector = vscode.Uri.file(path.join(folder, 'Core', 'Math', 'vector.cpp'));
    assert.deepStrictEqual(vscode.languages.getDiagnostics(vector), []);
  });

  test('an unsaved vssln.json edit is applied to the build', async function () {
    const a = await api();
    if (!a.getState().toolchain) this.skip();
    const settingsPath = path.join(settingsDir, 'vssln.json');
    await writeSettings(settingsDir, '{}\n');
    await waitFor(() => a.getState().settings.environment === undefined, 30000);
    const doc = await vscode.workspace.openTextDocument(settingsPath);
    const editor = await vscode.window.showTextDocument(doc);
    await editor.edit(e => e.replace(new vscode.Range(0, 0, doc.lineCount, 0), '{ "environment": { "CL": "/DENGINE_BREAK_BUILD" } }\n'));
    assert.ok(doc.isDirty);
    try {
      await (await startBuild(a, 'Rebuild')).done;
      assert.strictEqual(a.getState().build.status, 'failed');
      assert.strictEqual(a.getState().build.projects.get(guidOf(a, 'Math'))!.errors, 1);
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      fs.rmSync(settingsDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  test('linker errors without a source position reach Problems on the project file', async function () {
    const a = await api();
    if (!a.getState().toolchain) this.skip();
    await writeSettings(settingsDir, '{ "environment": { "LINK": "/INCLUDE:vssln_missing_symbol" } }\n');
    await waitFor(() => a.getState().settings.environment?.LINK !== undefined, 30000);

    await (await startBuild(a, 'Rebuild')).done;
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

    const { done } = await startBuild(a, 'Rebuild');
    await writeSettings(settingsDir, '{ "configuration": "Debug|x64" }\n');
    await new Promise(resolve => setTimeout(resolve, 1500));
    if (a.getState().build.status === 'running') assert.strictEqual(a.getState().configuration?.name, 'Release|x64');
    // The deferred reload runs when the build ends; the new configuration then also resets the build row.
    await waitFor(() => a.getState().configuration?.name === 'Debug|x64', 240000);
    assert.notStrictEqual(a.getState().build.status, 'running');
    await done;
  });

  test('dirty editors are saved before a build', async function () {
    const a = await api();
    if (!a.getState().toolchain) this.skip();
    const doc = await vscode.workspace.openTextDocument(path.join(folder, 'Tools', 'Legacy', 'legacy.cpp'));
    const editor = await vscode.window.showTextDocument(doc);
    await editor.edit(e => e.insert(new vscode.Position(0, 0), '// probe\n'));
    assert.ok(doc.isDirty);
    try {
      await vscode.commands.executeCommand('vssln.build');
      await waitFor(finished(a), 240000);
      assert.strictEqual(doc.isDirty, false);
    } finally {
      await editor.edit(e => e.delete(new vscode.Range(0, 0, 1, 0)));
      await doc.save();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });
});
