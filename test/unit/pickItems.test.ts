import * as path from 'path';
import { beforeAll, expect, test } from 'vitest';
import { AppState } from '../../src/state/store';
import { configurationItems, solutionItems, startupItems } from '../../src/ui/pickItems';
import { loadFixtureState, WORKSPACE } from './helpers';

let s: AppState;
beforeAll(async () => {
  s = await loadFixtureState();
});

test('solution items: file name and path relative to its folder, current marked', () => {
  const items = solutionItems(['C:\\w\\src\\A.sln', 'C:\\x\\B.sln'], ['C:\\w', 'C:\\x'], 'C:\\w\\src\\A.sln');
  expect(items).toEqual([
    { label: 'A.sln', description: 'src\\A.sln · current', picked: true, value: 'C:\\w\\src\\A.sln' },
    { label: 'B.sln', description: 'B.sln', picked: false, value: 'C:\\x\\B.sln' },
  ]);
});

test('configuration items in file order, current marked', () => {
  expect(configurationItems(s).map(i => [i.label, i.description, i.picked])).toEqual([
    ['Debug|Win32', undefined, false], ['Debug|x64', undefined, false], ['Release|Win32', undefined, false], ['Release|x64', 'current', true],
  ]);
});

test('startup items: applications plus show all', () => {
  const items = startupItems(s, false);
  expect(items.map(i => i.label)).toEqual(['Game', 'Show all projects…']);
  expect(items[0]).toMatchObject({ picked: true, description: 'current', value: '{11111111-1111-1111-1111-111111111111}' });
  expect(items[1].value).toBe('showAll');
});

test('startup items with show all: every C++ project in tree order', () => {
  expect(startupItems(s, true).map(i => i.label)).toEqual(['Render', 'Math', 'Legacy', 'Game', 'Missing']);
});

test('fixture workspace path is used for the fixture solution', () => {
  expect(solutionItems(s.solutions, [WORKSPACE], s.solution!.path)[0].description).toBe('Sample.sln · current');
  expect(path.isAbsolute(s.solutions[0])).toBe(true);
});
