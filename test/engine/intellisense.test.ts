import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { VsslnApi } from '../../src/extension';
import { api, waitFor } from './helpers';

/** The 10 C++ projects of Release|x64 that exist on disk (Missing is skipped). */
const PROJECTS = 10;

async function settled(a: VsslnApi): Promise<void> {
  await waitFor(() => a.getState().intellisense.projects.size > 0 && !a.getState().intellisense.running, 240000);
}

suite('IntelliSense on samples/Engine', () => {
  const folder = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const file = (...p: string[]) => path.join(folder, ...p);

  test('every C++ project of Release|x64 gets its data', async function () {
    const a = await api();
    if (!a.getState().toolchain) this.skip();
    await settled(a);
    const projects = [...a.getState().intellisense.projects.values()];
    assert.strictEqual(projects.length, PROJECTS);
    assert.deepStrictEqual(projects.filter(p => p.status !== 'ready'), []);
  });

  test('sources, their headers and headers of shared folders get the flags of the build', async function () {
    const a = await api();
    if (!a.getState().toolchain) this.skip();
    await settled(a);
    const render = a.intellisense.configurationFor(file('Graphics', 'Render', 'render.cpp'))!;
    assert.ok(render, 'no configuration for render.cpp');
    const includes = render.includePath.map(p => p.toLowerCase());
    assert.ok(includes.includes(file('Core', 'include').toLowerCase()), includes.join('\n'));
    assert.ok(includes.includes(file('out', 'generated').toLowerCase()), includes.join('\n'));
    assert.ok(includes.some(p => /\\vc\\tools\\msvc\\[\d.]+\\include$/.test(p)), 'no MSVC include directory');
    assert.ok(render.defines.includes('RENDER_EXPORTS'));
    assert.strictEqual(render.standard, 'c++20');
    assert.strictEqual(render.intelliSenseMode, 'windows-msvc-x64');

    assert.deepStrictEqual(a.intellisense.configurationFor(file('Graphics', 'Render', 'pch.h'))!.defines, render.defines);
    const shared = a.intellisense.configurationFor(file('Core', 'include', 'engine', 'render.h'));
    assert.ok(shared?.includePath.some(p => p.toLowerCase() === file('Core', 'include').toLowerCase()));
    assert.strictEqual(a.intellisense.configurationFor(file('README.md')), undefined);
  });

  test('a reload with nothing changed takes every project from the cache', async function () {
    const a = await api();
    if (!a.getState().toolchain) this.skip();
    await settled(a);
    await vscode.commands.executeCommand('vssln.refresh');
    await waitFor(() => [...a.getState().intellisense.projects.values()].every(p => p.status === 'ready' && p.fromCache), 60000);
  });

  test('a change of a property sheet recomputes the projects that import it', async function () {
    const a = await api();
    if (!a.getState().toolchain) this.skip();
    await settled(a);
    const props = file('Build', 'Common.props');
    const original = fs.readFileSync(props, 'utf8');
    try {
      fs.writeFileSync(props, original.replace('<!-- Imported', '<!-- Changed by a test. Imported'));
      await waitFor(() => [...a.getState().intellisense.projects.values()].some(p => p.status === 'ready' && p.fromCache === false), 60000);
      await settled(a);
      // Every project imports Common.props.
      assert.deepStrictEqual([...a.getState().intellisense.projects.values()].filter(p => p.fromCache), []);
    } finally {
      fs.writeFileSync(props, original);
    }
    // The watcher and its debounce start a re-check of the restored file: wait for it, then for its end.
    await waitFor(() => a.getState().intellisense.running, 10000).catch(() => undefined);
    await settled(a);
  });

  test('cpptools shows real errors and resolves the includes of the solution', async function () {
    const a = await api();
    if (!a.getState().toolchain) this.skip();
    await settled(a);
    const probe = file('Graphics', 'Render', 'intellisense_probe.cpp');
    // Only headers in the repository: out\generated\shaders.h exists only after a build.
    fs.writeFileSync(probe, '#include <engine/render.h>\n#include <cstdio>\nint broken = "text";\n');
    try {
      const uri = vscode.Uri.file(probe);
      await vscode.window.showTextDocument(uri);
      const fromCpptools = () => vscode.languages.getDiagnostics(uri).filter(d => d.source === 'C/C++');
      await waitFor(() => fromCpptools().some(d => d.range.start.line === 2), 120000);
      assert.deepStrictEqual(fromCpptools().filter(d => d.range.start.line < 2).map(d => d.message), []);
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      fs.rmSync(probe, { force: true });
    }
  });

  test('a build pauses a pass, which finishes after it', async function () {
    const a = await api();
    if (!a.getState().toolchain) this.skip();
    await settled(a);
    a.intellisense.engine.recompute();
    const build = a.builds.run('Build');
    await waitFor(() => a.getState().build.status === 'running', 30000);
    // A small solution may finish its pass before the build starts; when it has not, nothing computes now.
    const s = a.getState();
    if (s.intellisense.running) assert.deepStrictEqual([...s.intellisense.projects.values()].filter(p => p.status === 'computing'), []);
    await build;
    await settled(a);
    assert.deepStrictEqual([...a.getState().intellisense.projects.values()].filter(p => p.status !== 'ready'), []);
  });
});
