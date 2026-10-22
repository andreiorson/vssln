import { expect, test } from 'vitest';
import { parsePreprocess, preprocessArgs } from '../../src/intellisense/preprocess';
import { readFixture } from './helpers';

const ctx = { projectPath: 'D:\\visualizer\\samples\\Engine\\Graphics\\Render\\Render.vcxproj', solutionDir: 'D:\\visualizer\\samples\\Engine\\' };
const banner = (path: string) => `  <!--\n${'='.repeat(40)}\n  <Import Project="x">\n\n${path}\n${'='.repeat(40)}\n-->`;

test('the files of the Render evaluation: every banner once, the project and the solution sheet included', () => {
  const { inputs } = parsePreprocess(readFixture('msbuild/preprocess-render.xml'), ctx, () => true);
  expect(inputs).toHaveLength(78);
  expect(inputs.every(p => /^[A-Za-z]:\\/.test(p))).toBe(true);
  expect(inputs[0]).toBe(ctx.projectPath);
  expect(inputs).toContain('D:\\visualizer\\samples\\Engine\\Build\\Common.props');
  expect(new Set(inputs.map(p => p.toLowerCase())).size).toBe(inputs.length);
});

test('documentation blocks of targets files use "=" rules too: their text is no file, an odd rule changes nothing', () => {
  const xml = [
    banner('C:\\VS\\Microsoft.Common.targets'),
    '  <!--',
    `  ${'='.repeat(60)}`,
    '                                      Build',
    '  The main build entry point.',
    `  ${'='.repeat(60)}`,
    '  -->',
    `  <!-- ${'='.repeat(30)} a lone rule -->`,
    `  ${'='.repeat(25)}`,
    banner('C:\\VS\\Microsoft.Cpp.targets'),
  ].join('\n');
  expect(parsePreprocess(xml, ctx, () => true).inputs).toEqual(['C:\\VS\\Microsoft.Common.targets', 'C:\\VS\\Microsoft.Cpp.targets']);
});

test('commented-out imports: awaited only when they resolve to a file that does not exist', () => {
  const xml = [
    banner('C:\\VS\\Microsoft.Cpp.props'),
    '  <!--<Import Project="Imports.props" Condition="false" />-->',
    '  <!--<Import Project="Existing.props" Condition="false" />-->',
    '  <!--<Import Project="$(MSBuildThisFileDirectory)Later.props" />-->',
    '  <!--<Import Project="$(SolutionDir)Directory.Solution.props" Condition="exists(\'x\')" />-->',
    '  <!--<Import Project="$(UserRootDir)\\Microsoft.Cpp.x64.user.props" />-->',
    '  <!--<Import Project="ImportBefore\\*.props" />-->',
  ].join('\n');
  const { inputs, awaited } = parsePreprocess(xml, ctx, p => p.endsWith('Existing.props'));
  expect(inputs).toEqual(['C:\\VS\\Microsoft.Cpp.props']);
  expect(awaited.filter(p => !/Directory\.Build\./.test(p))).toEqual(['C:\\VS\\Imports.props', 'C:\\VS\\Later.props', 'D:\\visualizer\\samples\\Engine\\Directory.Solution.props']);
});

test('Directory.Build.props and .targets in the project folder or above are awaited while they do not exist', () => {
  // The common targets import them through $(DirectoryBuildPropsPath), which -preprocess leaves unexpanded.
  const existing = 'D:\\visualizer\\samples\\Directory.Build.props';
  const { awaited } = parsePreprocess(banner('C:\\VS\\Microsoft.Common.props'), ctx, p => p === existing);
  expect(awaited).toEqual([
    'D:\\visualizer\\samples\\Engine\\Graphics\\Render\\Directory.Build.props',
    'D:\\visualizer\\samples\\Engine\\Graphics\\Render\\Directory.Build.targets',
    'D:\\visualizer\\samples\\Engine\\Graphics\\Directory.Build.props',
    'D:\\visualizer\\samples\\Engine\\Graphics\\Directory.Build.targets',
    'D:\\visualizer\\samples\\Engine\\Directory.Build.props',
    'D:\\visualizer\\samples\\Engine\\Directory.Build.targets',
    'D:\\visualizer\\samples\\Directory.Build.targets',
    'D:\\visualizer\\Directory.Build.props',
    'D:\\visualizer\\Directory.Build.targets',
    'D:\\Directory.Build.props',
    'D:\\Directory.Build.targets',
  ]);
});

test('arguments: evaluation only, into a file', () => {
  const args = preprocessArgs({
    projectPath: 'C:\\s\\P\\P.vcxproj',
    config: { configuration: 'Release', platform: 'x64' },
    solutionPath: 'C:\\s\\S.sln',
    targetsFile: 'C:\\ext\\vssln-intellisense.targets',
    devEnvDir: '',
    properties: {},
  }, 'C:\\tmp\\p.xml');
  expect(args.slice(0, 3)).toEqual(['C:\\s\\P\\P.vcxproj', '-nologo', '-preprocess:C:\\tmp\\p.xml']);
  expect(args).toContain('-p:SolutionDir=C:\\s\\');
  expect(args).toContain('-p:DesignTimeBuild=true');
});
