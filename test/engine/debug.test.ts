import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { api, removeSettings, waitFor, writeSettings } from './helpers';

/** Arguments that a shell or naive quoting would break. */
const TRICKY = ['', 'a "b"', 'C:\\dir\\', 'x y'];
const TRICKY_LINES = ['argc=4', 'arg[1]=', 'arg[2]=a "b"', 'arg[3]=C:\\dir\\', 'arg[4]=x y'];

suite('run and debug samples/Engine', () => {
  const folder = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const settingsDir = path.join(folder, '.vscode');
  const cooked = path.join(folder, 'Tools', 'AssetCooker', 'cooked.txt');

  async function cookedLines(): Promise<string[]> {
    await waitFor(() => fs.existsSync(cooked) && fs.readFileSync(cooked, 'utf8').includes('COOK_MODE='), 120000);
    return fs.readFileSync(cooked, 'utf8').split(/\r?\n/).filter(Boolean);
  }

  async function cookerSettings(args: string[]): Promise<void> {
    await writeSettings(settingsDir, JSON.stringify({
      projects: { AssetCooker: { debug: { args, env: { COOK_MODE: 'test' }, cwd: '${projectDir}' } } },
    }));
  }

  setup(() => {
    removeSettings(settingsDir);
    fs.rmSync(cooked, { force: true });
  });
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
    assert.strictEqual(r.config.args, '--windowed');
    assert.deepStrictEqual(r.argv, ['--windowed']);
    assert.deepStrictEqual(r.config.environment, [{ name: 'GAME_MODE', value: 'sample' }]);
    assert.strictEqual(r.config.cwd.toLowerCase(), path.join(folder, 'Game').toLowerCase());
    assert.strictEqual(r.config.console, 'internalConsole');
  });

  test('Run starts AssetCooker with exact arguments, the environment of vssln.json and no terminal', async function () {
    const a = await api();
    if (!a.getState().toolchain) this.skip();
    await cookerSettings(TRICKY);
    await waitFor(() => a.getState().settings.projects?.AssetCooker !== undefined, 30000);
    const terminals = vscode.window.terminals.length;

    assert.strictEqual(await a.debugging.launch('AssetCooker', true), true);
    const lines = await cookedLines();
    assert.deepStrictEqual(lines, ['assets=3', ...TRICKY_LINES, 'COOK_MODE=test']);
    assert.strictEqual(vscode.window.terminals.length, terminals);
  });

  test('Debug starts AssetCooker under cppvsdbg with the same arguments', async function () {
    const a = await api();
    if (!a.getState().toolchain) this.skip();
    await cookerSettings(TRICKY);
    await waitFor(() => a.getState().settings.projects?.AssetCooker !== undefined, 30000);

    assert.strictEqual(await a.debugging.launch('AssetCooker', false), true);
    assert.deepStrictEqual(await cookedLines(), ['assets=3', ...TRICKY_LINES, 'COOK_MODE=test']);
  });

  test('a launch.json entry of type vssln wins with its own values', async function () {
    const a = await api();
    if (!a.getState().toolchain) this.skip();
    await cookerSettings(['--from-settings']);
    await waitFor(() => a.getState().settings.projects?.AssetCooker !== undefined, 30000);

    const started = await vscode.debug.startDebugging(vscode.workspace.workspaceFolders![0], {
      type: 'vssln', request: 'launch', name: 'cook', project: 'AssetCooker', args: ['from-launch-json'],
    });
    assert.strictEqual(started, true);
    assert.deepStrictEqual(await cookedLines(), ['assets=3', 'argc=1', 'arg[1]=from-launch-json', 'COOK_MODE=test']);
  });

  test('a failed build does not start the debugger', async function () {
    const a = await api();
    if (!a.getState().toolchain) this.skip();
    await writeSettings(settingsDir, '{ "environment": { "CL": "/DENGINE_BREAK_BUILD" } }\n');
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

  test('a library without a program to start is explained before anything is built', async function () {
    const a = await api();
    if (!a.getState().toolchain) this.skip();
    const r = await a.debugging.resolve('Audio');
    assert.ok('problem' in r);
    assert.match(r.problem, /set "program" for it in vssln\.json/);
  });
});
