import { expect, test } from 'vitest';
import { filterTree } from '../../src/solution/filter';
import { buildTree, TreeNode } from '../../src/solution/model';
import { parseSln } from '../../src/solution/slnParser';
import { readFixture } from './helpers';

const roots = buildTree(parseSln(readFixture('workspace/Sample.sln'), 'C:\\src\\Sample.sln'));

/** "Core/Graphics/Render"-style lines for every node of a tree, depth first. */
function paths(nodes: TreeNode[], prefix = ''): string[] {
  return nodes.flatMap(n => [prefix + n.label, ...paths(n.children, `${prefix}${n.label}/`)]);
}

test('an empty query keeps the tree', () => {
  const r = filterTree(roots, '   ');
  expect(r.roots).toBe(roots);
  expect(r).toMatchObject({ matched: 6, total: 6 });
});

test('a project name keeps the project and its folders only', () => {
  expect(paths(filterTree(roots, 'math').roots)).toEqual(['Core', 'Core/Math']);
});

test('every word must match somewhere in the folder path and name', () => {
  const r = filterTree(roots, 'gra ren');
  expect(paths(r.roots)).toEqual(['Core', 'Core/Graphics', 'Core/Graphics/Render']);
  expect(r).toMatchObject({ matched: 1, total: 6 });
});

test('a folder name keeps every project inside it', () => {
  expect(paths(filterTree(roots, 'core').roots)).toEqual(['Core', 'Core/Graphics', 'Core/Graphics/Render', 'Core/Math']);
});

test('matching ignores case', () => {
  expect(paths(filterTree(roots, 'GAME').roots)).toEqual(['Game']);
});

test('no match gives an empty tree', () => {
  expect(filterTree(roots, 'xyz')).toEqual({ roots: [], matched: 0, total: 6 });
});

test('filtering does not change the original tree', () => {
  filterTree(roots, 'math');
  expect(roots[0].children.map(n => n.label)).toEqual(['Graphics', 'Math']);
});
