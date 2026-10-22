import * as path from 'path';
import { beforeAll, expect, test } from 'vitest';
import { itemsTree } from '../../src/solution/itemsTree';
import { findItemNode, parentsOf, projectsListing } from '../../src/solution/locate';
import { buildTree } from '../../src/solution/model';
import { AppState } from '../../src/state/store';
import { loadFixtureState, WORKSPACE } from './helpers';

const GAME = '{11111111-1111-1111-1111-111111111111}';
const MATH = '{22222222-2222-2222-2222-222222222222}';
const mainCpp = path.join(WORKSPACE, 'Game', 'main.cpp');
let s: AppState;

beforeAll(async () => {
  s = await loadFixtureState();
});

/** The fixture state with main.cpp listed by Math too. */
function shared(startupProjectGuid: string | undefined): AppState {
  const projects = new Map(s.projects);
  const math = projects.get(MATH)!;
  projects.set(MATH, { ...math, items: { ...math.items!, items: [...math.items!.items, { itemType: 'ClCompile', include: '..\\..\\Game\\main.cpp', path: mainCpp }] } });
  return { ...s, projects, ...(startupProjectGuid ? { startupProjectGuid } : { startupProjectGuid: undefined }) };
}

test('the projects that list a file, whatever the case and separators of its path', () => {
  expect(projectsListing(s, mainCpp)).toEqual([GAME]);
  expect(projectsListing(s, mainCpp.toUpperCase().replace(/\\/g, '/'))).toEqual([GAME]);
  expect(projectsListing(s, path.join(WORKSPACE, 'nowhere.cpp'))).toEqual([]);
});

test('the startup project comes first when it lists the file, then solution order', () => {
  expect(projectsListing(shared(MATH), mainCpp)).toEqual([MATH, GAME]);
  expect(projectsListing(shared(GAME), mainCpp)).toEqual([GAME, MATH]);
  expect(projectsListing(shared(undefined), mainCpp)).toEqual([GAME, MATH]);
});

test('the file node under filters, ignoring case; items that need MSBuild are not found', () => {
  const items = s.projects.get(GAME)!.items!;
  const nodes = itemsTree(GAME, { ...items, items: [...items.items, { itemType: 'None', include: '$(X)\\y.txt' }] }, () => true);
  expect(findItemNode(nodes, mainCpp.toUpperCase())?.label).toBe('main.cpp');
  expect(findItemNode(nodes, path.join(WORKSPACE, 'Game', 'src', 'game.h'))?.label).toBe('game.h');
  expect(findItemNode(nodes, '$(X)\\y.txt')).toBeUndefined();
});

test('parents of folders and projects', () => {
  const roots = buildTree(s.solution!);
  const parents = parentsOf(roots);
  const core = roots.find(n => n.label === 'Core')!;
  const math = core.children.find(n => n.label === 'Math')!;
  expect(parents.get(math)).toBe(core);
  expect(parents.has(core)).toBe(false);
});
