import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { api, removeSettings, waitFor, writeSettings } from './helpers';

suite('run and debug samples/Engine', () => {
  const folder = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const settingsDir = path.join(folder, '.vscode');
  const cooked = path.join(folder, 'Tools', 'AssetCooker', 'cooked.txt');

  setup(() => removeSettings(settingsDir));
  suiteTeardown(() => {
    removeSettings(settingsDir);
    fs.rmSync(cooked, { force: true });
  });

  test('Game gets its arguments and environment from Game.vcxproj.user', async function () {
    const a = await api();
    if (!a.getState().toolchain) this.skip();
    await waitFor(() => a.getState().configuration?.name === 'Release|x64' && a.getState().settings.projects === undefined, 30000);
    const r = await a.debugging.resolve('Game');
    assert.ok('config' in r, 'problem' in r ? r.problem : '');
    assert.ok(r.config.program.toLowerCase().endsWith('\\out\\x64\\release\\game.exe'), r.config.program);
    assert.deepStrictEqual(r.config.args, ['--windowed']);
    assert.deepStrictEqual(r.config.environment, [{ name: 'GAME_MODE', value: 'sample' }]);
    assert.strictEqual(r.config.cwd.toLowerCase(), path.join(folder, 'Game').toLowerCase() + '\\');
    assert.strictEqual(r.config.console, 'internalConsole');
  });

  test('Run starts AssetCooker with the settings of vssln.json', async function () {
    const a = await api();
    if (!a.getState().toolchain) this.skip();
    fs.rmSync(cooked, { force: true });
    await writeSettings(settingsDir, JSON.stringify({
      projects: { AssetCooker: { debug: { args: ['--fast', 'x y'], env: { COOK_MODE: 'test' }, cwd: '${projectDir}' } } },
    }));
    await waitFor(() => a.getState().settings.projects?.AssetCooker !== undefined, 30000);

    const started = await a.debugging.launch('AssetCooker', true);
    assert.strictEqual(started, true);
    await waitFor(() => fs.existsSync(cooked), 120000);
    await waitFor(() => fs.readFileSync(cooked, 'utf8').includes('COOK_MODE='), 10000);
    const text = fs.readFileSync(cooked, 'utf8');
    assert.ok(text.includes('assets=3'), text);
    assert.ok(text.includes('args=--fast x y'), text);
    assert.ok(text.includes('COOK_MODE=test'), text);
  });

  test('a failed build does not start the debugger', async function () {
    const a = await api();
    if (!a.getState().toolchain) this.skip();
    await writeSettings(settingsDir, '{ "environment": { "CL": "/DENGINE_BREAK_BUILD" }, "build": { } }\n');
    await waitFor(() => a.getState().settings.environment?.CL !== undefined, 30000);
    // Math must really be compiled again: CL is not part of MSBuild's incremental checks.
    await a.builds.run('Clean');
    let sessions = 0;
    const listener = vscode.debug.onDidStartDebugSession(() => sessions++);
    try {
      assert.strictEqual(await a.debugging.launch('Game', false), false);
      assert.strictEqual(a.getState().build.status, 'failed');
      assert.strictEqual(sessions, 0);
    } finally {
      listener.dispose();
      removeSettings(settingsDir);
      await waitFor(() => a.getState().settings.environment === undefined, 30000);
      await a.builds.run('Build');
    }
  });

  test('a library without a program to start is explained', async function () {
    const a = await api();
    if (!a.getState().toolchain) this.skip();
    const r = await a.debugging.resolve('Audio');
    assert.ok('problem' in r);
    assert.match(r.problem, /set "program" for it in vssln\.json/);
  });
});
