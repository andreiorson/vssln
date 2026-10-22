import * as path from 'path';
import { beforeAll, expect, test } from 'vitest';
import { buildTree, TreeNode } from '../../src/solution/model';
import { AppState } from '../../src/state/store';
import { projectRow } from '../../src/ui/viewModel';
import { loadFixtureState } from './helpers';

const ENGINE = path.join(__dirname, '..', '..', 'samples', 'Engine');

let s: AppState;
let rows: string[];

function describeTree(nodes: TreeNode[], state: AppState, depth = 0): string[] {
  return nodes.flatMap(n => {
    const row = projectRow(n, state);
    const line = `${'  '.repeat(depth)}${row.label}${row.description ? ` (${row.description})` : ''}`;
    return [line, ...describeTree(n.children, state, depth + 1)];
  });
}

beforeAll(async () => {
  s = await loadFixtureState({ folders: [ENGINE], solutions: [path.join(ENGINE, 'Engine.sln')] });
  rows = describeTree(buildTree(s.solution!), s);
});

test('samples/Engine loads with the expected defaults', () => {
  expect(s.phase).toBe('ready');
  expect(s.configuration!.name).toBe('Release|x64');
  expect(s.solution!.projects.find(p => p.guid === s.startupProjectGuid)!.name).toBe('Game');
  expect(s.problems).toEqual([]);
});

test('samples/Engine tree matches the sample README', () => {
  expect(rows).toEqual([
    'Core',
    '  Containers (lib · 4 files)',
    '  Math (lib · 3 files)',
    '  Platform (lib · 1 file)',
    'Graphics',
    '  Render (dll · 4 files)',
    '  Shaders (utility · 0 files)',
    'Tests',
    '  MathTests (exe · 1 file)',
    'Tools',
    '  AssetCooker (exe · 1 file)',
    '  Deps (utility · 0 files)',
    '  Editor (exe · 1 file)',
    '  Legacy (not in Release|x64)',
    'Audio (dll · 1 file)',
    'Game (exe · 1 file · startup)',
    'Missing (file not found)',
  ]);
});
