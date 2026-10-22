import * as fs from 'fs';
import * as path from 'path';
import { expect, test } from 'vitest';
import { parseDebugProperties } from '../../src/debug/properties';
import { DEFAULT_CONSOLE, LaunchInput, resolveLaunch } from '../../src/debug/launchResolver';
import { parseSln } from '../../src/solution/slnParser';
import { readFixture } from './helpers';

const engine = parseSln(fs.readFileSync(path.join(__dirname, '..', '..', 'samples', 'Engine', 'Engine.sln'), 'utf8'), 'C:\\src\\Engine\\Engine.sln');
const project = (name: string) => engine.projects.find(p => p.name === name)!;
const releaseX64 = engine.configurations.find(c => c.name === 'Release|x64')!;
const gameProps = parseDebugProperties(readFixture('msbuild/debug-props-release.log'))!;
const audioProps = {
  ...gameProps,
  targetPath: 'C:\\src\\Engine\\out\\x64\\Release\\Audio.dll',
  command: 'C:\\src\\Engine\\out\\x64\\Release\\Audio.dll',
  arguments: '',
  environment: [],
  projectDir: 'C:\\src\\Engine\\Audio\\',
  configurationType: 'DynamicLibrary',
};

function input(over: Partial<LaunchInput> = {}): LaunchInput {
  return {
    project: project('Game'), config: releaseX64, settings: {}, properties: gameProps,
    workspaceFolder: 'C:\\src', solutionDir: 'C:\\src\\Engine\\', env: { Path: 'C:\\bin', HOME: 'C:\\h' }, noDebug: false, ...over,
  };
}

function resolved(over: Partial<LaunchInput> = {}) {
  const r = resolveLaunch(input(over));
  if (!('config' in r)) throw new Error(r.problem);
  return r;
}

const config = (over: Partial<LaunchInput> = {}) => resolved(over).config;

test('MSBuild values from the project and its .vcxproj.user', () => {
  expect(config()).toEqual({
    type: 'cppvsdbg',
    request: 'launch',
    name: 'Debug Game',
    program: 'C:\\src\\Engine\\out\\x64\\Release\\Game.exe',
    // The .vcxproj.user command line as written, like Visual Studio passes it.
    args: '--level "two words" --x=1',
    cwd: 'C:\\src\\Engine\\out\\x64\\Release',
    environment: [
      { name: 'GAME_MODE', value: 'sample' },
      // The inherited spelling of the name: cppvsdbg and Windows see one variable.
      { name: 'Path', value: 'C:\\src\\Engine\\tools;C:\\bin' },
      { name: 'EMPTY', value: '' },
      { name: 'NINJA', value: 'C:\\ninja\\bin;D:\\new' },
    ],
    console: DEFAULT_CONSOLE,
  });
  expect(DEFAULT_CONSOLE).toBe('internalConsole');
  expect(resolved().argv).toEqual(['--level', 'two words', '--x=1']);
});

test('run without debugging', () => {
  expect(config({ noDebug: true })).toMatchObject({ name: 'Run Game', noDebug: true });
});

test('settings override MSBuild, the configuration entry overrides the project entry', () => {
  const c = config({
    settings: {
      environment: { SDK: '${workspaceFolder}\\sdk', HOME: 'C:\\h' },
      projects: {
        game: {
          debug: {
            args: ['--fast', '${configuration}'],
            cwd: '${projectDir}data',
            env: { GAME_MODE: 'test' },
            console: 'externalTerminal',
            byConfiguration: { 'Release|x64': { args: ['--release'] } },
          },
        },
      },
    },
  });
  expect(c.args).toBe('--release');
  expect(c.cwd).toBe('C:\\src\\Engine\\Game\\data');
  expect(c.console).toBe('externalTerminal');
  // HOME equals the inherited value, so it is not listed; settings environment comes first, debug.env last.
  expect(c.environment).toEqual([
    { name: 'SDK', value: 'C:\\src\\sdk' },
    { name: 'GAME_MODE', value: 'test' },
    { name: 'Path', value: 'C:\\src\\Engine\\tools;C:\\bin' },
    { name: 'EMPTY', value: '' },
    { name: 'NINJA', value: 'C:\\ninja\\bin;D:\\new' },
  ]);
});

test('a program from the settings with variables', () => {
  expect(config({ settings: { projects: { Game: { debug: { program: '${targetPath}' } } } } }).program).toBe('C:\\src\\Engine\\out\\x64\\Release\\Game.exe');
});

test('launch.json values win over everything', () => {
  const c = config({
    settings: { projects: { Game: { debug: { args: ['--from-settings'] } } } },
    overrides: { args: ['x'], cwd: 'C:\\w', env: { GAME_MODE: 'json' }, console: 'integratedTerminal', program: 'C:\\other.exe' },
  });
  expect(c).toMatchObject({ args: 'x', cwd: 'C:\\w', console: 'integratedTerminal', program: 'C:\\other.exe' });
  expect(c.environment).toContainEqual({ name: 'GAME_MODE', value: 'json' });
});

test('listed arguments become one command line that keeps empty and quoted arguments', () => {
  const r = resolved({ overrides: { args: ['', 'a "b"', 'C:\\dir\\', 'x y'] } });
  expect(r.config.args).toBe('"" "a \\"b\\"" C:\\dir\\ "x y"');
  expect(r.argv).toEqual(['', 'a "b"', 'C:\\dir\\', 'x y']);
});

test('a library without a program to start is explained', () => {
  const r = resolveLaunch(input({ project: project('Audio'), properties: audioProps }));
  expect(r).toEqual({ problem: 'Audio is a DynamicLibrary and Audio.dll cannot be started; set "program" for it in vssln.json (projects.Audio.debug.program).', action: 'openSettings' });
});

test('a library with a host program starts the host', () => {
  const host = config({ project: project('Audio'), properties: audioProps, settings: { projects: { Audio: { debug: { program: 'C:\\host\\Host.exe' } } } } });
  expect(host.program).toBe('C:\\host\\Host.exe');
  const fromUserFile = config({ project: project('Audio'), properties: { ...audioProps, command: 'C:\\host\\Host.exe' } });
  expect(fromUserFile.program).toBe('C:\\host\\Host.exe');
});

test('relative paths: settings and launch.json from the workspace folder, MSBuild values from the project directory', () => {
  expect(config({ settings: { projects: { Game: { debug: { program: 'tools\\host.exe', cwd: 'data' } } } } })).toMatchObject({
    program: 'C:\\src\\tools\\host.exe', cwd: 'C:\\src\\data',
  });
  expect(config({ overrides: { program: 'bin\\x.exe', cwd: '.' } })).toMatchObject({ program: 'C:\\src\\bin\\x.exe', cwd: 'C:\\src' });
  expect(config({ properties: { ...gameProps, command: '..\\out\\Game.exe', workingDirectory: '..\\data' } })).toMatchObject({
    program: 'C:\\src\\Engine\\out\\Game.exe', cwd: 'C:\\src\\Engine\\data',
  });
});

test('empty launch.json strings count as not set', () => {
  expect(config({ overrides: { program: '', cwd: '' } })).toMatchObject({
    program: 'C:\\src\\Engine\\out\\x64\\Release\\Game.exe', cwd: 'C:\\src\\Engine\\out\\x64\\Release',
  });
});

test('whether a project can start depends on its program, not its type', () => {
  const makefile = { ...gameProps, configurationType: 'Makefile', targetPath: 'C:\\src\\out\\tool.exe', command: 'C:\\src\\out\\tool.exe' };
  expect(config({ properties: makefile }).program).toBe('C:\\src\\out\\tool.exe');
  const script = { ...gameProps, configurationType: 'Utility', targetPath: 'C:\\src\\gen.cmd', command: 'C:\\src\\gen.cmd' };
  expect(config({ properties: script }).program).toBe('C:\\src\\gen.cmd');
});

test('an empty working directory falls back to the project directory', () => {
  expect(config({ properties: { ...gameProps, workingDirectory: '' } }).cwd).toBe('C:\\src\\Engine\\Game');
});
