import { beforeAll, describe, expect, test } from 'vitest';
import { buildTree, TreeNode } from '../../src/solution/model';
import { AppState, failedState } from '../../src/state/store';
import { projectDecoration, projectRow, projectUri, statusBarItems, statusRows } from '../../src/ui/viewModel';
import { loadFixtureState } from './helpers';

let s: AppState;
let nodes: Map<string, TreeNode>;

function index(list: TreeNode[], into: Map<string, TreeNode>): Map<string, TreeNode> {
  for (const n of list) {
    into.set(n.label, n);
    index(n.children, into);
  }
  return into;
}

const node = (label: string) => nodes.get(label)!;

beforeAll(async () => {
  s = await loadFixtureState();
  nodes = index(buildTree(s.solution!), new Map());
});

test('status rows for the fixture', () => {
  expect(statusRows(s).map(r => [r.id, r.label, r.description])).toEqual([
    ['solution', 'Sample.sln', '.'],
    ['configuration', 'Release | x64', undefined],
    ['startup', 'Game', 'startup'],
  ]);
});

test('status rows carry icons, commands and context values', () => {
  expect(statusRows(s).map(r => [r.icon, r.command, r.contextValue])).toEqual([
    ['file-code', 'vssln.selectSolution', 'status.solution'],
    ['settings-gear', 'vssln.selectConfiguration', 'status.configuration'],
    ['rocket', 'vssln.selectStartupProject', 'status.startup'],
  ]);
});

test('no startup project', () => {
  const rows = statusRows({ ...s, startupProjectGuid: undefined });
  expect(rows[2]).toMatchObject({ label: 'None', description: 'no application project' });
});

test('problem rows carry their command', async () => {
  const broken = await loadFixtureState({ toolchain: { problem: 'vswhere.exe not found' } });
  const last = statusRows(broken).at(-1)!;
  expect(last).toMatchObject({ id: 'problem:0', label: 'vswhere.exe not found', icon: 'error', command: 'vssln.configureToolchain', contextValue: 'status.problem' });
});

test('warning problem rows', async () => {
  const stale = await loadFixtureState({ settings: '{"startupProject": "Gone"}' });
  expect(statusRows(stale).at(-1)).toMatchObject({ icon: 'warning', command: 'vssln.openSettings' });
});

test('no solution: a solution row that selects one, plus problems', () => {
  const rows = statusRows({ ...s, phase: 'noSolution', solution: undefined, configuration: undefined, startupProjectGuid: undefined });
  expect(rows.map(r => [r.id, r.label, r.command])).toEqual([['solution', 'No solution', 'vssln.selectSolution']]);
});

test('a failed load shows its problem with a link to the log', () => {
  const failed = failedState('Loading the workspace failed: boom');
  expect(failed.phase).toBe('failed');
  expect(statusRows(failed).map(r => [r.label, r.icon, r.command])).toEqual([['Loading the workspace failed: boom', 'error', 'vssln.showLog']]);
});

test('loading: no rows', () => {
  expect(statusRows({ ...s, phase: 'loading' })).toEqual([]);
});

test('folder row', () => {
  expect(projectRow(node('Core'), s)).toMatchObject({ label: 'Core', icon: 'folder', contextValue: 'folder', inactive: false });
  expect(projectRow(node('Core'), s).description).toBeUndefined();
});

test('a project mapped without Build.0 is shown as not built', () => {
  // Render has only ActiveCfg for Release|x64 in the fixture solution.
  expect(projectRow(node('Render'), s)).toMatchObject({ description: 'not built in Release|x64', icon: 'circle-slash', inactive: true, contextValue: 'project.inactive' });
});

test('inactive reasons', () => {
  expect(projectRow(node('Legacy'), s)).toMatchObject({ description: 'not in Release|x64', icon: 'circle-slash', inactive: true, contextValue: 'project.inactive' });
  expect(projectRow(node('Missing'), s)).toMatchObject({ description: 'file not found', inactive: true, contextValue: 'project.missing' });
  expect(projectRow(node('Docs'), s)).toMatchObject({ description: 'not a C++ project', inactive: true });
});

test('active project description', () => {
  expect(projectRow(node('Game'), s)).toMatchObject({ label: 'Game', description: 'exe · 3 files · startup', icon: 'window', contextValue: 'project.app', inactive: false });
  expect(projectRow(node('Math'), s)).toMatchObject({ description: 'lib · 5 files', icon: 'library', contextValue: 'project.lib' });
});

test('unknown type has no short name and a generic icon', () => {
  const guid = '{11111111-1111-1111-1111-111111111111}';
  const unknown = { ...s, startupProjectGuid: undefined, projects: new Map(s.projects).set(guid, { exists: true, scan: { types: {}, sources: 1, headers: 0 } }) };
  expect(projectRow(node('Game'), unknown)).toMatchObject({ description: '1 file', icon: 'file-code', contextValue: 'project.lib' });
});

test('startup marker follows the selection', async () => {
  const st = await loadFixtureState({ settings: '{"configuration": "Debug|x64", "startupProject": "Math"}' });
  expect(projectRow(node('Math'), st).description).toBe('lib · 5 files · startup');
  expect(projectRow(node('Game'), st).description).toBe('exe · 3 files');
});

test('resource uri and tooltip', () => {
  expect(projectUri('{11111111-1111-1111-1111-111111111111}')).toBe('vssln-project:/11111111-1111-1111-1111-111111111111');
  expect(projectRow(node('Game'), s).resourceUri).toBe(projectUri('{11111111-1111-1111-1111-111111111111}'));
  expect(projectRow(node('Game'), s).tooltip).toBe(node('Game').project!.absPath);
});

test('decoration greys inactive projects only', () => {
  expect(projectDecoration(projectUri('{44444444-4444-4444-4444-444444444444}'), s)).toEqual({ color: 'disabledForeground', tooltip: 'not in Release|x64' });
  expect(projectDecoration(projectUri('{11111111-1111-1111-1111-111111111111}'), s)).toBeUndefined();
  expect(projectDecoration(projectUri('{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}'), s)).toBeUndefined();
  expect(projectDecoration('vssln-project:/nope', s)).toBeUndefined();
});

test('status bar items', () => {
  expect(statusBarItems(s)).toEqual([
    { id: 'configuration', text: '$(settings-gear) Release|x64', tooltip: 'Solution configuration', command: 'vssln.selectConfiguration' },
    { id: 'startup', text: '$(rocket) Game', tooltip: 'Startup project', command: 'vssln.selectStartupProject' },
  ]);
  expect(statusBarItems({ ...s, phase: 'noSolution' })).toEqual([]);
});

describe('filter and file rows', () => {
  const guid = '{AAAAAAAA-0000-0000-0000-000000000001}';
  const file = (item: TreeNode['item']): TreeNode => ({ id: `${guid}/i/x`, kind: 'file', label: 'a.cpp', children: [], projectGuid: guid, item });

  test('a present file opens and takes its icon from the theme', () => {
    const row = projectRow(file({ include: 'a.cpp', path: 'C:\s\a.cpp', missing: false }), s);
    expect(row).toMatchObject({ label: 'a.cpp', tooltip: 'C:\s\a.cpp', icon: 'file', themeIcon: 'file', openPath: 'C:\s\a.cpp', contextValue: 'file', inactive: false });
    expect(row.description).toBeUndefined();
  });

  test('a missing file is greyed out and cannot be opened', () => {
    const row = projectRow(file({ include: 'a.cpp', path: 'C:\s\a.cpp', missing: true }), s);
    expect(row).toMatchObject({ description: 'file not found', icon: 'circle-slash', contextValue: 'file.missing', inactive: true });
    expect(row.openPath).toBeUndefined();
    expect(projectDecoration(row.resourceUri, s)).toEqual({ color: 'disabledForeground', tooltip: 'file not found' });
  });

  test('an item that needs MSBuild is shown as text', () => {
    const row = projectRow(file({ include: '$(X)\a.cpp', missing: false }), s);
    expect(row).toMatchObject({ description: 'not evaluated', tooltip: '$(X)\a.cpp', icon: 'circle-slash', contextValue: 'file.unevaluated', inactive: true });
    expect(projectDecoration(row.resourceUri, s)).toEqual({ color: 'disabledForeground', tooltip: 'not evaluated' });
  });

  test('a filter is a folder from the theme', () => {
    const row = projectRow({ id: `${guid}/f/source files`, kind: 'filter', label: 'Source Files', children: [], projectGuid: guid }, s);
    expect(row).toMatchObject({ label: 'Source Files', icon: 'folder', themeIcon: 'folder', contextValue: 'filter', inactive: false });
    expect(projectDecoration(row.resourceUri, s)).toBeUndefined();
  });
});
