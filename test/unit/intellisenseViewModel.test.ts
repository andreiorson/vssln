import { beforeAll, expect, test } from 'vitest';
import { buildTree, TreeNode } from '../../src/solution/model';
import { startBuild } from '../../src/state/build';
import { AppState, ProjectIntelliSense } from '../../src/state/store';
import { projectRow, statusBarItems, statusRows } from '../../src/ui/viewModel';
import { loadFixtureState } from './helpers';

const GAME = '{11111111-1111-1111-1111-111111111111}';
const MATH = '{22222222-2222-2222-2222-222222222222}';
const RENDER = '{33333333-3333-3333-3333-333333333333}';
let s: AppState;
let nodes: TreeNode[];

beforeAll(async () => {
  s = await loadFixtureState();
  const visit = (list: TreeNode[]): TreeNode[] => list.flatMap(n => [n, ...visit(n.children)]);
  nodes = visit(buildTree(s.solution!));
});

const node = (label: string) => nodes.find(n => n.label === label)!;
function withIntelliSense(running: boolean, projects: Record<string, ProjectIntelliSense>): AppState {
  return { ...s, intellisense: { running, projects: new Map(Object.entries(projects)) } };
}
const row = (st: AppState) => statusRows(st).find(r => r.id === 'intellisense');
const bar = (st: AppState) => statusBarItems(st).find(i => i.id === 'intellisense');

test('no IntelliSense row before a pass', () => {
  expect(row(s)).toBeUndefined();
  expect(bar(s)).toBeUndefined();
});

test('computing: spinner, counts, after the startup row; the status bar counts too', () => {
  const st = withIntelliSense(true, { [GAME]: { status: 'ready' }, [MATH]: { status: 'computing' }, [RENDER]: { status: 'waiting' } });
  expect(row(st)).toEqual({
    id: 'intellisense', label: 'IntelliSense', description: 'computing 1 · 1 / 3 ready', tooltip: 'IntelliSense data from MSBuild. Click for the log.',
    icon: 'sync~spin', iconColor: 'charts.blue', command: 'vssln.showLog', contextValue: 'status.intellisense',
  });
  expect(statusRows(st).map(r => r.id).slice(0, 4)).toEqual(['solution', 'configuration', 'startup', 'intellisense']);
  expect(bar(st)).toEqual({ id: 'intellisense', text: '$(sync~spin) IntelliSense 1/3', tooltip: 'Computing IntelliSense data: 1 of 3 projects ready', command: 'vssln.showLog' });
});

test('paused for a build', () => {
  const st = { ...withIntelliSense(true, { [GAME]: { status: 'waiting' } }), build: startBuild({ action: 'Build' }, [GAME], 'C:\\b.log', 0) };
  expect(row(st)!.description).toBe('paused for the build · 0 / 1 ready');
});

test('all ready: a green check, no status bar item', () => {
  const st = withIntelliSense(false, { [GAME]: { status: 'ready' }, [MATH]: { status: 'ready', fromCache: true } });
  expect(row(st)).toMatchObject({ description: '2 / 2 ready', icon: 'check', iconColor: 'testing.iconPassed' });
  expect(bar(st)).toBeUndefined();
});

test('failures: a warning in the row and the status bar', () => {
  const st = withIntelliSense(false, { [GAME]: { status: 'ready' }, [MATH]: { status: 'failed', message: 'error MSB4019' } });
  expect(row(st)).toMatchObject({ description: '1 failed · 1 / 2 ready', icon: 'warning', iconColor: 'list.warningForeground' });
  expect(bar(st)).toEqual({ id: 'intellisense', text: '$(warning) IntelliSense: 1 failed', tooltip: 'IntelliSense data of 1 project could not be computed. Click for the log.', command: 'vssln.showLog' });
});

test('project rows tell their IntelliSense state while a pass runs; a failure stays with its output', () => {
  const running = withIntelliSense(true, { [GAME]: { status: 'computing' }, [MATH]: { status: 'waiting' }, [RENDER]: { status: 'ready' } });
  expect(projectRow(node('Game'), running).description).toBe('exe · 3 files · startup · IntelliSense: computing');
  expect(projectRow(node('Math'), running).description).toMatch(/ · IntelliSense: waiting$/);
  expect(projectRow(node('Render'), running).description).not.toContain('IntelliSense');
  const failed = withIntelliSense(false, { [MATH]: { status: 'failed', message: 'error MSB4019: not found' } });
  expect(projectRow(node('Math'), failed).description).toMatch(/ · IntelliSense failed$/);
  expect(projectRow(node('Math'), failed).tooltip).toContain('error MSB4019: not found');
  // A waiting project after the pass ended (no longer running) shows nothing.
  expect(projectRow(node('Math'), withIntelliSense(false, { [MATH]: { status: 'waiting' } })).description).not.toContain('IntelliSense');
});

test('the build state wins over IntelliSense in the description', () => {
  const st = { ...withIntelliSense(true, { [GAME]: { status: 'computing' } }), build: startBuild({ action: 'Build' }, [GAME], 'C:\\b.log', 0) };
  expect(projectRow(node('Game'), st).description).toBe('waiting');
});
