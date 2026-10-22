import * as fs from 'fs';
import * as path from 'path';
import { expect, test } from 'vitest';
import { buildArgs, BuildCommandInput, solutionTargetName } from '../../src/build/args';
import { parseSln } from '../../src/solution/slnParser';
import { VsInstance } from '../../src/toolchain/vswhere';

const ENGINE_SLN = path.join(__dirname, '..', '..', 'samples', 'Engine', 'Engine.sln');
const engine = parseSln(fs.readFileSync(ENGINE_SLN, 'utf8'), 'C:\\src\\Engine\\Engine.sln');
const project = (name: string) => engine.projects.find(p => p.name === name)!;
const releaseX64 = engine.configurations.find(c => c.name === 'Release|x64')!;
const VS: VsInstance = {
  installationPath: 'C:\\VS', installationVersion: '18.0', displayName: 'VS',
  msbuildPath: 'C:\\VS\\MSBuild\\Current\\Bin\\MSBuild.exe', devEnvDir: 'C:\\VS\\Common7\\IDE\\',
};

function input(over: Partial<BuildCommandInput> = {}): BuildCommandInput {
  return { sln: engine, config: releaseX64, toolchain: VS, request: { action: 'Build' }, properties: {}, logFile: 'C:\\t\\build.log', ...over };
}

test('nested project target name', () => {
  expect(solutionTargetName(engine, project('Render'))).toBe('Graphics\\Render');
});

test('root project target name', () => {
  expect(solutionTargetName(engine, project('Game'))).toBe('Game');
});

test('special characters are cleansed', () => {
  const CPP = '{8BC9CEB8-8B4A-11D0-8D11-00A0C91BC942}';
  const FOLDER = '{2150E333-8FDC-42A3-9474-1A3956D46DE8}';
  const sln = parseSln([
    `Project("${FOLDER}") = "Third.Party (x)", "Third.Party (x)", "{F0000000-0000-0000-0000-000000000001}"`, 'EndProject',
    `Project("${CPP}") = "My.Lib", "My.Lib.vcxproj", "{00000000-0000-0000-0000-000000000001}"`, 'EndProject',
    'Global', '\tGlobalSection(NestedProjects) = preSolution',
    '\t\t{00000000-0000-0000-0000-000000000001} = {F0000000-0000-0000-0000-000000000001}',
    '\tEndGlobalSection', 'EndGlobal',
  ].join('\n'), 'C:\\x.sln');
  expect(solutionTargetName(sln, sln.projects[0])).toBe('Third_Party _x_\\My_Lib');
});

test('solution build arguments', () => {
  expect(buildArgs(input({ properties: { B: '2', A: '1' } }))).toEqual([
    'C:\\src\\Engine\\Engine.sln', '-t:Build', '-m', '-nologo', '-nr:false', '-v:normal',
    '-p:Configuration=Release', '-p:Platform=x64', '-p:DevEnvDir=C:\\VS\\Common7\\IDE\\',
    '-p:A=1', '-p:B=2', '-fl', '-flp:LogFile=C:\\t\\build.log;Verbosity=normal;Encoding=UTF-8',
  ]);
});

test('solution rebuild and clean targets', () => {
  expect(buildArgs(input({ request: { action: 'Rebuild' } }))[1]).toBe('-t:Rebuild');
  expect(buildArgs(input({ request: { action: 'Clean' } }))[1]).toBe('-t:Clean');
});

test('project build, rebuild and clean targets', () => {
  const render = project('Render');
  expect(buildArgs(input({ request: { action: 'Build', project: render } }))[1]).toBe('-t:Graphics\\Render');
  expect(buildArgs(input({ request: { action: 'Rebuild', project: render } }))[1]).toBe('-t:Graphics\\Render:Rebuild');
  expect(buildArgs(input({ request: { action: 'Clean', project: render } }))[1]).toBe('-t:Graphics\\Render:Clean');
});

test('no DevEnvDir argument when the toolchain has none', () => {
  expect(buildArgs(input({ toolchain: { ...VS, devEnvDir: '' } })).some(a => a.startsWith('-p:DevEnvDir'))).toBe(false);
});

test('platform with a space stays one argument', () => {
  const anyCpu = { name: 'Release|Any CPU', configuration: 'Release', platform: 'Any CPU' };
  expect(buildArgs(input({ config: anyCpu }))).toContain('-p:Platform=Any CPU');
});
