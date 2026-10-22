import { expect, test } from 'vitest';
import { parseSln, projectConfigFor } from '../../src/solution/slnParser';
import { readFixture } from './helpers';

const sln = parseSln(readFixture('workspace/Sample.sln'), 'C:\\src\\Sample.sln');

test('lists projects and folders in file order', () => {
  expect(sln.projects.map(p => p.name)).toEqual(['Game', 'Math', 'Render', 'Legacy', 'Docs', 'Missing']);
  expect(sln.folders.map(f => f.name)).toEqual(['Core', 'Graphics', 'Tools']);
});

test('classifies kinds and resolves paths', () => {
  expect(sln.projects.find(p => p.name === 'Docs')!.kind).toBe('other');
  expect(sln.projects.find(p => p.name === 'Math')!.kind).toBe('vcxproj');
  expect(sln.projects.find(p => p.name === 'Math')!.absPath).toBe('C:\\src\\Core\\Math\\Math.vcxproj');
  expect(sln.dir).toBe('C:\\src');
});

test('nests folders and projects', () => {
  expect(sln.folders.find(f => f.name === 'Graphics')!.parentGuid).toBe('{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}');
  expect(sln.projects.find(p => p.name === 'Render')!.parentGuid).toBe('{BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB}');
  expect(sln.projects.find(p => p.name === 'Game')!.parentGuid).toBeUndefined();
});

test('reads dependencies', () => {
  expect(sln.projects.find(p => p.name === 'Game')!.dependencies).toEqual(['{22222222-2222-2222-2222-222222222222}']);
  expect(sln.projects.find(p => p.name === 'Math')!.dependencies).toEqual([]);
});

test('reads solution configurations in order', () => {
  expect(sln.configurations.map(c => c.name)).toEqual(['Debug|Win32', 'Debug|x64', 'Release|Win32', 'Release|x64']);
  expect(sln.configurations[3]).toEqual({ name: 'Release|x64', configuration: 'Release', platform: 'x64' });
});

test('maps project configurations, Build.0 sets build', () => {
  expect(projectConfigFor(sln, '{33333333-3333-3333-3333-333333333333}', 'Release|x64')).toEqual({ configuration: 'Release', platform: 'x64', build: false });
  expect(projectConfigFor(sln, '{55555555-5555-5555-5555-555555555555}', 'Release|x64')).toEqual({ configuration: 'Release', platform: 'Any CPU', build: true });
  expect(projectConfigFor(sln, '{44444444-4444-4444-4444-444444444444}', 'Release|x64')).toBeUndefined();
});

test('a project GUID listed twice keeps the first entry and reports the second', () => {
  const CPP = '{8BC9CEB8-8B4A-11D0-8D11-00A0C91BC942}';
  const d = parseSln([
    'Microsoft Visual Studio Solution File, Format Version 12.00',
    `Project("${CPP}") = "A", "A.vcxproj", "{00000000-0000-0000-0000-000000000001}"`, 'EndProject',
    `Project("${CPP}") = "B", "B.vcxproj", "{00000000-0000-0000-0000-000000000001}"`, 'EndProject',
  ].join('\n'), 'C:\\x.sln');
  expect(d.projects.map(p => p.name)).toEqual(['A']);
  expect(d.warnings).toEqual(['Project "B" has the same GUID {00000000-0000-0000-0000-000000000001} as "A" and is not shown.']);
  expect(sln.warnings).toEqual([]);
});

test('handles dotted config names, lower-case guids, LF', () => {
  const d = parseSln(readFixture('sln/dotted-config.sln'), 'C:\\d\\x.sln');
  expect(d.configurations.map(c => c.name)).toEqual(['Release.Static|x64', 'Debug|x64']);
  expect(d.projects[0].guid).toBe('{AAAAAAAA-0000-0000-0000-000000000001}');
  expect(projectConfigFor(d, '{AAAAAAAA-0000-0000-0000-000000000001}', 'Release.Static|x64'))
    .toEqual({ configuration: 'Release Static', platform: 'x64', build: true });
});
