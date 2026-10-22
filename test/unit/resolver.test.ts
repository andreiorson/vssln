import { expect, test } from 'vitest';
import { expandVariables, resolveConfiguration, resolveSolutionPath, resolveStartupProject } from '../../src/settings/resolver';
import { parseSln } from '../../src/solution/slnParser';
import { loadSample, readFixture } from './helpers';

const { sample, scans } = loadSample();
const releaseX64 = sample.configurations.find(c => c.name === 'Release|x64')!;

test('expands known variables, keeps unknown', () => {
  const r = expandVariables('${workspaceFolder}\\sdk;${env:SDK};${nope}', { workspaceFolder: 'C:\\w', env: { SDK: 'D:\\s' } });
  expect(r).toEqual({ value: 'C:\\w\\sdk;D:\\s;${nope}', unknown: ['nope'] });
});

test('expands every context variable', () => {
  const r = expandVariables('${solutionDir}|${projectDir}|${targetPath}|${configuration}|${platform}', {
    workspaceFolder: 'C:\\w', solutionDir: 'C:\\w\\src', projectDir: 'C:\\w\\src\\Game', targetPath: 'C:\\out\\Game.exe',
    configuration: 'Release', platform: 'x64', env: {},
  });
  expect(r).toEqual({ value: 'C:\\w\\src|C:\\w\\src\\Game|C:\\out\\Game.exe|Release|x64', unknown: [] });
});

test('missing env variable expands to empty string', () => {
  expect(expandVariables('a${env:NONE}b', { workspaceFolder: 'C:\\w', env: {} })).toEqual({ value: 'ab', unknown: [] });
});

test('a context variable without a value stays literal and is reported', () => {
  expect(expandVariables('${projectDir}', { workspaceFolder: 'C:\\w', env: {} })).toEqual({ value: '${projectDir}', unknown: ['projectDir'] });
});

test('solution from settings, relative to folder', () => {
  expect(resolveSolutionPath({ solution: 'src/A.sln' }, 'C:\\w', ['C:\\w\\src\\A.sln', 'C:\\w\\B.sln']))
    .toEqual({ value: 'C:\\w\\src\\A.sln', source: 'settings' });
});

test('solution from settings matches case-insensitively and keeps the discovered spelling', () => {
  expect(resolveSolutionPath({ solution: 'SRC/a.sln' }, 'C:\\w', ['C:\\w\\src\\A.sln']).value).toBe('C:\\w\\src\\A.sln');
});

test('several solutions without settings: shallowest, then alphabetical', () => {
  expect(resolveSolutionPath({}, 'C:\\w', ['C:\\w\\x\\A.sln', 'C:\\w\\Z.sln', 'C:\\w\\B.sln']))
    .toEqual({ value: 'C:\\w\\B.sln', source: 'default' });
});

test('no solutions at all', () => {
  expect(resolveSolutionPath({}, 'C:\\w', [])).toEqual({ source: 'default' });
});

test('settings solution that no longer exists falls back with a problem', () => {
  const r = resolveSolutionPath({ solution: 'gone.sln' }, 'C:\\w', ['C:\\w\\B.sln']);
  expect(r.value).toBe('C:\\w\\B.sln');
  expect(r.source).toBe('default');
  expect(r.problem).toMatch(/gone\.sln/);
});

test('configuration default prefers Release|x64 over the first entry', () => {
  expect(resolveConfiguration({}, sample)).toEqual({ value: releaseX64, source: 'default' });
});

test('configuration default without Release|x64 is the first', () => {
  const dotted = parseSln(readFixture('sln/dotted-config.sln'), 'C:\\d\\x.sln');
  expect(resolveConfiguration({}, dotted).value!.name).toBe('Release.Static|x64');
});

test('configuration from settings', () => {
  expect(resolveConfiguration({ configuration: 'Debug|x64' }, sample)).toMatchObject({ value: { name: 'Debug|x64' }, source: 'settings' });
});

test('unknown configuration in settings falls back with a problem', () => {
  const r = resolveConfiguration({ configuration: 'Profile|x64' }, sample);
  expect(r.value!.name).toBe('Release|x64');
  expect(r.source).toBe('default');
  expect(r.problem).toMatch(/Profile\|x64/);
});

test('startup default is the first Application project in sln order', () => {
  expect(resolveStartupProject({}, sample, releaseX64, scans)).toMatchObject({ value: { name: 'Game' }, source: 'default' });
});

test('startup from settings matches case-insensitively', () => {
  expect(resolveStartupProject({ startupProject: 'game' }, sample, releaseX64, scans)).toMatchObject({ value: { name: 'Game' }, source: 'settings' });
});

test('startup from settings may be a non-application project', () => {
  expect(resolveStartupProject({ startupProject: 'Math' }, sample, releaseX64, scans).value!.name).toBe('Math');
});

test('unknown startup project falls back with a problem', () => {
  const r = resolveStartupProject({ startupProject: 'Gone' }, sample, releaseX64, scans);
  expect(r.value!.name).toBe('Game');
  expect(r.problem).toMatch(/Gone/);
});

test('no application project in the configuration: no startup project, no problem', () => {
  const debugWin32 = sample.configurations.find(c => c.name === 'Debug|Win32')!;
  expect(resolveStartupProject({}, sample, debugWin32, scans)).toEqual({ source: 'default' });
});
