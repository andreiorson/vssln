import { expect, test } from 'vitest';
import { intellisenseArgs, parseDump } from '../../src/intellisense/dump';
import { readFixture } from './helpers';

const R = 'D:\\visualizer\\samples\\Engine\\Graphics\\Render\\';

test('the Render spike output: one record per option set, standard library modules skipped', () => {
  const dump = parseDump(readFixture('msbuild/intellisense-render.log'))!;
  expect(dump.records.map(r => [r.files, r.projectDefault])).toEqual([
    [[`${R}pch.cpp`], false],
    [[`${R}render.cpp`, `${R}frame.cpp`], true],
  ]);
  expect(dump.records[0].commandLine).toMatch(/^\/c \/ID:\\visualizer\\samples\\Engine\\out\\generated .* \/Yc"pch.h" /);
  expect(dump.records[1].commandLine).toContain('/Yu"pch.h"');
});

test('system include directories from IncludePath and ExternalIncludePath, without gaps or repeats', () => {
  const dump = parseDump(readFixture('msbuild/intellisense-render.log'))!;
  expect(dump.systemIncludes.length).toBeGreaterThan(4);
  expect(dump.systemIncludes.every(d => d.trim() === d && d !== '')).toBe(true);
  expect(new Set(dump.systemIncludes.map(d => d.toLowerCase())).size).toBe(dump.systemIncludes.length);
  expect(dump.systemIncludes[0]).toMatch(/\\VC\\Tools\\MSVC\\[\d.]+\\include$/);
  expect(dump.systemIncludes.some(d => /\\ucrt$/.test(d))).toBe(true);
});

test('records keep "|" inside a command line; no VSSLN line means no dump', () => {
  const dump = parseDump('  VSSLN|CL|true|C:\\p\\a.cpp;;C:\\p\\b.cpp|/c /D "A=x|y"\n  VSSLN|IncludePath|C:\\inc;;C:\\INC\n')!;
  expect(dump.records).toEqual([{ files: ['C:\\p\\a.cpp', 'C:\\p\\b.cpp'], commandLine: '/c /D "A=x|y"', projectDefault: true }]);
  expect(dump.systemIncludes).toEqual(['C:\\inc']);
  expect(parseDump('error MSB1009: Project file does not exist.')).toBeUndefined();
});

test('arguments: the design-time properties and the build context of the project', () => {
  const args = intellisenseArgs({
    projectPath: 'C:\\s\\P\\P.vcxproj',
    config: { configuration: 'Release', platform: 'x64' },
    solutionPath: 'C:\\s\\S.sln',
    targetsFile: 'C:\\ext\\vssln-intellisense.targets',
    devEnvDir: 'C:\\VS\\Common7\\IDE\\',
    properties: { UseMultiToolTask: 'true', Extra: 'a;b' },
  });
  expect(args.slice(0, 4)).toEqual(['C:\\s\\P\\P.vcxproj', '-t:VsslnIntelliSense', '-nologo', '-v:minimal']);
  expect(args).toEqual(expect.arrayContaining([
    '-p:DesignTimeBuild=true',
    '-p:BuildingInsideVisualStudio=true',
    '-p:SkipCompilerExecution=true',
    '-p:ProvideCommandLineArgs=true',
    '-p:Configuration=Release',
    '-p:Platform=x64',
    '-p:SolutionDir=C:\\s\\',
    '-p:SolutionPath=C:\\s\\S.sln',
    '-p:SolutionName=S',
    '-p:DevEnvDir=C:\\VS\\Common7\\IDE\\',
    '-p:Extra=a%3Bb',
    '-p:CustomAfterMicrosoftCommonTargets=C:\\ext\\vssln-intellisense.targets',
  ]));
});
