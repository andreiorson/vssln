import { expect, test } from 'vitest';
import { buildTree, ChildrenRegistry } from '../../src/solution/model';
import { parseSln } from '../../src/solution/slnParser';
import { readFixture } from './helpers';

const roots = buildTree(parseSln(readFixture('workspace/Sample.sln'), 'C:\\src\\Sample.sln'));

function sln(...lines: string[]): string {
  return ['Microsoft Visual Studio Solution File, Format Version 12.00', ...lines].join('\n');
}

const CPP = '{8BC9CEB8-8B4A-11D0-8D11-00A0C91BC942}';

test('root order: folders first, then projects, alphabetical', () => {
  expect(roots.map(n => n.label)).toEqual(['Core', 'Tools', 'Docs', 'Game', 'Missing']);
  expect(roots[0].kind).toBe('folder');
  expect(roots[3].kind).toBe('project');
  expect(roots[3].id).toBe('{11111111-1111-1111-1111-111111111111}');
});

test('nested order', () => {
  const core = roots[0];
  expect(core.children.map(n => n.label)).toEqual(['Graphics', 'Math']);
  expect(core.children[0].children.map(n => n.label)).toEqual(['Render']);
});

test('alphabetical is case-insensitive', () => {
  const tree = buildTree(parseSln(sln(
    `Project("${CPP}") = "beta", "b.vcxproj", "{00000000-0000-0000-0000-000000000001}"`, 'EndProject',
    `Project("${CPP}") = "Alpha", "a.vcxproj", "{00000000-0000-0000-0000-000000000002}"`, 'EndProject',
  ), 'C:\\x.sln'));
  expect(tree.map(n => n.label)).toEqual(['Alpha', 'beta']);
});

test('a project whose parent guid is unknown goes to the root', () => {
  const tree = buildTree(parseSln(sln(
    `Project("${CPP}") = "Orphan", "o.vcxproj", "{00000000-0000-0000-0000-000000000001}"`, 'EndProject',
    'Global',
    '\tGlobalSection(NestedProjects) = preSolution',
    '\t\t{00000000-0000-0000-0000-000000000001} = {99999999-9999-9999-9999-999999999999}',
    '\tEndGlobalSection',
    'EndGlobal',
  ), 'C:\\x.sln'));
  expect(tree.map(n => n.label)).toEqual(['Orphan']);
});

test('registry adds provider children and makes projects expandable', () => {
  const reg = new ChildrenRegistry();
  const game = roots.find(n => n.label === 'Game')!;
  expect(reg.hasChildren(game)).toBe(false);
  expect(reg.hasChildren(roots[0])).toBe(true);
  reg.register({ appliesTo: n => n.kind === 'project', children: () => [{ id: 'x', kind: 'folder', label: 'X', children: [] }] });
  expect(reg.childrenOf(game).map(n => n.label)).toEqual(['X']);
  expect(reg.hasChildren(game)).toBe(true);
});

test('registry asks providers for parents', () => {
  const reg = new ChildrenRegistry();
  const game = roots.find(n => n.label === 'Game')!;
  const child = { id: 'x', kind: 'file' as const, label: 'x', children: [] };
  expect(reg.parentOf(child)).toBeUndefined();
  reg.register({ appliesTo: () => false, children: () => [] });
  reg.register({ appliesTo: () => false, children: () => [], parentOf: n => (n === child ? game : undefined) });
  expect(reg.parentOf(child)).toBe(game);
  expect(reg.parentOf(game)).toBeUndefined();
});
