import { expect, test } from 'vitest';
import { applySelectionEdit, ensureObjectKey, parseSettings } from '../../src/settings/settings';
import { SettingsFile, SettingsSyntaxError } from '../../src/settings/settingsFile';
import { memoryFs, readFixture } from './helpers';
import schema from '../../schemas/vssln.schema.json';

test('reads jsonc with comments and trailing commas', () => {
  const r = parseSettings(readFixture('settings/commented.json'));
  expect(r.syntaxOk).toBe(true);
  expect(r.problems).toEqual([]);
  expect(r.settings.configuration).toBe('Release|x64');
  expect(r.settings.toolchain).toEqual({ vsVersion: '[16,17)', msbuildPath: null });
  expect(r.settings.projects!.Game.debug!.byConfiguration!['Debug|x64'].args).toEqual(['--windowed', '--validate']);
});

test('syntax error yields empty settings and a problem with a line number', () => {
  const r = parseSettings(readFixture('settings/broken.json'));
  expect(r.syntaxOk).toBe(false);
  expect(r.settings).toEqual({});
  expect(r.problems[0]).toMatch(/line 1/);
});

test('wrong-typed values are dropped with a problem each, valid ones kept', () => {
  const r = parseSettings(readFixture('settings/wrong-types.json'));
  expect(r.syntaxOk).toBe(true);
  expect(r.settings).toEqual({ environment: { B: 'x' }, startupProject: 'Game', msbuild: {} });
  expect(r.problems).toHaveLength(3);
});

test('a UTF-8 BOM is not a syntax error', () => {
  const r = parseSettings('﻿{ "configuration": "Debug|x64" }');
  expect(r).toEqual({ settings: { configuration: 'Debug|x64' }, syntaxOk: true, problems: [] });
});

test('selection edit on a file with a BOM stays valid', () => {
  const out = applySelectionEdit('﻿{ "configuration": "Debug|x64" }', 'startupProject', 'Game');
  expect(parseSettings(out).settings).toEqual({ configuration: 'Debug|x64', startupProject: 'Game' });
});

test('empty text is an empty, valid settings object', () => {
  expect(parseSettings('')).toEqual({ settings: {}, syntaxOk: true, problems: [] });
});

test('selection edit keeps comments', () => {
  const out = applySelectionEdit(readFixture('settings/commented.json'), 'configuration', 'Debug|x64');
  expect(out).toContain('// current selection');
  expect(parseSettings(out).settings.configuration).toBe('Debug|x64');
});

test('selection edit on empty text creates an object', () => {
  expect(JSON.parse(applySelectionEdit('', 'solution', 'src/A.sln'))).toEqual({ solution: 'src/A.sln' });
});

test('ensureObjectKey adds an empty object once and keeps comments', () => {
  const out = ensureObjectKey('{\n  // keep\n  "configuration": "Release|x64"\n}', 'toolchain');
  expect(out).toContain('// keep');
  expect(parseSettings(out).settings).toEqual({ configuration: 'Release|x64', toolchain: {} });
  expect(ensureObjectKey(out, 'toolchain')).toBe(out);
  expect(JSON.parse(ensureObjectKey('', 'toolchain'))).toEqual({ toolchain: {} });
});

test('writeSelection refuses to overwrite a broken file', async () => {
  const fs = memoryFs({ 'C:\\w\\.vscode\\vssln.json': readFixture('settings/broken.json') });
  await expect(new SettingsFile('C:\\w', fs).writeSelection('configuration', 'Debug|x64')).rejects.toBeInstanceOf(SettingsSyntaxError);
  expect(fs.files['C:\\w\\.vscode\\vssln.json']).toBe(readFixture('settings/broken.json'));
});

test('writeSelection creates the file and reports it', async () => {
  const fs = memoryFs({});
  const file = new SettingsFile('C:\\w', fs);
  expect(await file.writeSelection('startupProject', 'Game')).toEqual({ created: true });
  expect(JSON.parse(fs.files['C:\\w\\.vscode\\vssln.json'])).toEqual({ startupProject: 'Game' });
  expect(await file.writeSelection('configuration', 'Debug|x64')).toEqual({ created: false });
  expect((await file.read()).settings).toEqual({ startupProject: 'Game', configuration: 'Debug|x64' });
});

test('read reports a missing file', async () => {
  expect(await new SettingsFile('C:\\w', memoryFs({})).read()).toEqual({ settings: {}, syntaxOk: true, problems: [], exists: false });
});

test('schema top-level keys match the settings model', () => {
  expect(Object.keys(schema.properties)).toEqual(['solution', 'configuration', 'startupProject', 'toolchain', 'environment', 'build', 'msbuild', 'projects']);
});
