import { expect, test } from 'vitest';
import { itemsTree } from '../../src/solution/itemsTree';
import { TreeNode } from '../../src/solution/model';
import { ProjectItems } from '../../src/solution/projectItems';

const GUID = '{AAAAAAAA-0000-0000-0000-000000000001}';
const all = () => true;

function item(include: string, filter?: string, evaluated = true) {
  return { itemType: 'ClCompile', include, ...(evaluated ? { path: `C:\\s\\P\\${include}` } : {}), ...(filter ? { filter } : {}) };
}

const shape = (nodes: TreeNode[]): unknown[] => nodes.map(n => (n.kind === 'filter' ? { [n.label]: shape(n.children) } : n.label));

test('filters nest by their path and come before files', () => {
  const items: ProjectItems = {
    filters: ['Source Files', 'Source Files\\Sub', 'Empty'],
    items: [item('z.cpp'), item('a.cpp', 'Source Files'), item('src\\b.cpp', 'Source Files\\Sub'), item('x\\deep.h', 'Headers\\Deep\\')],
  };
  expect(shape(itemsTree(GUID, items, all))).toEqual([
    { Empty: [] },
    { Headers: [{ Deep: ['deep.h'] }] },
    { 'Source Files': [{ Sub: ['b.cpp'] }, 'a.cpp'] },
    'z.cpp',
  ]);
});

test('files sort by name ignoring case; same names stay apart', () => {
  const nodes = itemsTree(GUID, { filters: [], items: [item('main.cpp'), item('b\\Util.h'), item('a\\util.h'), item('Alpha.h')] }, all);
  expect(nodes.map(n => n.label)).toEqual(['Alpha.h', 'main.cpp', 'util.h', 'Util.h']);
  expect(new Set(nodes.map(n => n.id)).size).toBe(4);
});

test('ids are stable and lower case', () => {
  const items: ProjectItems = { filters: ['Source Files\\Sub'], items: [item('src\\A.cpp', 'Source Files\\Sub')] };
  const first = itemsTree(GUID, items, all);
  const sub = first[0].children[0];
  expect(first[0].id).toBe('{aaaaaaaa-0000-0000-0000-000000000001}/f/source files');
  expect(sub.id).toBe('{aaaaaaaa-0000-0000-0000-000000000001}/f/source files\\sub');
  expect(sub.children[0].id).toBe('{aaaaaaaa-0000-0000-0000-000000000001}/i/c:\\s\\p\\src\\a.cpp');
  expect(sub.children[0]).toMatchObject({ kind: 'file', projectGuid: GUID, item: { include: 'src\\A.cpp', path: 'C:\\s\\P\\src\\A.cpp', missing: false } });
  expect(JSON.stringify(itemsTree(GUID, items, all))).toBe(JSON.stringify(first));
});

test('missing and not evaluated items', () => {
  const nodes = itemsTree(GUID, { filters: [], items: [item('gone.cpp'), item('$(Other)\\q.h', undefined, false)] }, p => !p.endsWith('gone.cpp'));
  expect(nodes.map(n => [n.label, n.item])).toEqual([
    ['$(Other)\\q.h', { include: '$(Other)\\q.h', missing: false }],
    ['gone.cpp', { include: 'gone.cpp', path: 'C:\\s\\P\\gone.cpp', missing: true }],
  ]);
});
