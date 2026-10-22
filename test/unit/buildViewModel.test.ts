import { beforeAll, expect, test } from 'vitest';
import { BuildEvent } from '../../src/build/outputParser';
import { applyBuildEvent, BuildState, finishBuild, startBuild } from '../../src/state/build';
import { buildTree, TreeNode } from '../../src/solution/model';
import { AppState } from '../../src/state/store';
import { clock, duration, projectDecoration, projectRow, projectUri, statusBarItems, statusDecoration, statusRows } from '../../src/ui/viewModel';
import { loadFixtureState } from './helpers';

let s: AppState;
let nodes: Map<string, TreeNode>;
const node = (label: string) => nodes.get(label)!;
const project = (name: string) => s.solution!.projects.find(p => p.name === name)!;
const byPath = (p: string) => s.solution!.projects.find(x => x.absPath.toLowerCase() === p.toLowerCase())?.guid;

function index(list: TreeNode[], into: Map<string, TreeNode>): Map<string, TreeNode> {
  for (const n of list) {
    into.set(n.label, n);
    index(n.children, into);
  }
  return into;
}

/** A Build of Game, Math and Render; `steps` are applied in order with increasing times. */
function build(steps: BuildEvent[], finish?: { exitCode: number | null; cancelled: boolean }): BuildState {
  let b = startBuild({ action: 'Build' }, ['Game', 'Math', 'Render'].map(n => project(n).guid), 'C:\\t\\build.log', 1_000);
  steps.forEach((e, i) => (b = applyBuildEvent(b, e, byPath, 2_000 + i * 1_000)));
  return finish ? finishBuild(b, finish, 66_000) : b;
}

const started = (name: string): BuildEvent => ({ kind: 'projectStarted', path: project(name).absPath, target: 'Build' });
const finished = (name: string, failed = false): BuildEvent => ({ kind: 'projectFinished', path: project(name).absPath, target: 'Build', failed });
const error = (name: string, text = 'boom'): BuildEvent => ({ kind: 'diagnostic', severity: 'error', projectPath: project(name).absPath, text });
const warning = (name: string): BuildEvent => ({ kind: 'diagnostic', severity: 'warning', projectPath: project(name).absPath, text: 'careful' });
const withBuild = (b: BuildState): AppState => ({ ...s, build: b });
const buildRow = (st: AppState, now?: number) => statusRows(st, now).find(r => r.id === 'build');

beforeAll(async () => {
  s = await loadFixtureState();
  nodes = index(buildTree(s.solution!), new Map());
});

test('duration and clock', () => {
  expect(duration(65_000)).toBe('1:05');
  expect(duration(4_000)).toBe('0:04');
  const t = new Date(2026, 9, 22, 7, 5).getTime();
  expect(clock(t)).toBe('07:05');
});

test('no build row while idle', () => {
  expect(buildRow(s)).toBeUndefined();
});

test('running build row', () => {
  const st = withBuild(build([started('Math'), finished('Math'), started('Game'), error('Game')]));
  expect(buildRow(st, 13_000)).toMatchObject({
    label: 'Build', icon: 'loading~spin', description: '1/3 · 0:12 · 1 error', contextValue: 'status.build.running', command: 'vssln.showBuildOutput',
  });
  expect(statusRows(st, 13_000).map(r => r.id).slice(0, 4)).toEqual(['solution', 'configuration', 'startup', 'build']);
});

test('finished build rows', () => {
  const ok = withBuild(build([started('Math'), finished('Math')], { exitCode: 0, cancelled: false }));
  expect(buildRow(ok)).toMatchObject({ icon: 'pass', description: `succeeded · ${clock(66_000)} · 1:05`, contextValue: 'status.build' });
  const failed = withBuild(build([error('Math'), error('Math')], { exitCode: 1, cancelled: false }));
  expect(buildRow(failed)).toMatchObject({ icon: 'error', description: `failed · 2 errors · ${clock(66_000)} · 1:05` });
  const stopped = withBuild(build([], { exitCode: null, cancelled: true }));
  expect(buildRow(stopped)).toMatchObject({ icon: 'circle-slash', description: `stopped · ${clock(66_000)}` });
});

test('project build row label', () => {
  const b = startBuild({ action: 'Rebuild', project: project('Render') }, [project('Render').guid], 'l', 0);
  expect(buildRow(withBuild(b), 0)!.label).toBe('Rebuild Render');
});

test('solution and configuration rows are locked while building', () => {
  const rows = statusRows(withBuild(build([])), 1_000);
  expect(rows[0].description).toBe('locked during build');
  expect(rows[1].description).toBe('locked during build');
  expect(rows[0].tooltip).toBe(s.solution!.path);
});

test('project descriptions during and after a build', () => {
  const running = withBuild(build([started('Math')]));
  expect(projectRow(node('Math'), running)).toMatchObject({ description: 'building', icon: 'loading~spin' });
  expect(projectRow(node('Game'), running)).toMatchObject({ description: 'waiting', icon: 'window' });
  const done = withBuild(build([started('Math'), finished('Math'), started('Game'), error('Game'), error('Game'), finished('Game', true), started('Render'), finished('Render', true)], { exitCode: 1, cancelled: false }));
  expect(projectRow(node('Math'), done).description).toBe('built · 1s');
  expect(projectRow(node('Game'), done).description).toBe('2 errors');
  expect(projectRow(node('Render'), done).description).toBe('failed');
  const one = withBuild(build([error('Math'), finished('Math', true)], { exitCode: 1, cancelled: false }));
  expect(projectRow(node('Math'), one).description).toBe('1 error');
  const skipped = withBuild(build([], { exitCode: null, cancelled: true }));
  expect(projectRow(node('Math'), skipped).description).toBe('skipped');
});

test('a project the configuration does not build shows its build status when a reference builds it', () => {
  const st = withBuild(build([started('Render'), finished('Render')], { exitCode: 0, cancelled: false }));
  expect(projectRow(node('Render'), st)).toMatchObject({ description: 'built · 1s', icon: 'extensions', contextValue: 'project.lib', inactive: false });
  expect(projectDecoration(projectUri(project('Render').guid), st)).toBeUndefined();
  const notInBuild = withBuild(startBuild({ action: 'Build' }, [project('Math').guid], 'l', 0));
  expect(projectRow(node('Render'), notInBuild).description).toBe('not built in Release|x64');
});

test('a cleaned project says cleaned', () => {
  let b = startBuild({ action: 'Clean' }, [project('Math').guid], 'l', 0);
  b = applyBuildEvent(b, { kind: 'projectFinished', path: project('Math').absPath, target: 'Clean', failed: false }, byPath, 10);
  expect(projectRow(node('Math'), withBuild(finishBuild(b, { exitCode: 0, cancelled: false }, 20))).description).toBe('cleaned');
});

test('projects outside the build keep their usual description', () => {
  expect(projectRow(node('Legacy'), withBuild(build([]))).description).toBe('not in Release|x64');
});

test('folder summaries', () => {
  expect(projectRow(node('Core'), withBuild(build([started('Math'), started('Render')]))).description).toBe('building 2');
  expect(projectRow(node('Core'), withBuild(build([error('Math'), error('Render')], { exitCode: 1, cancelled: false }))).description).toBe('2 errors');
  expect(projectRow(node('Core'), withBuild(build([started('Math'), finished('Math')], { exitCode: 0, cancelled: false }))).description).toBeUndefined();
});

test('decorations for failed and warning projects', () => {
  const st = withBuild(build([error('Math', 'first'), error('Math'), finished('Math', true), finished('Render', true), warning('Game'), finished('Game')], { exitCode: 1, cancelled: false }));
  expect(projectDecoration(projectUri(project('Math').guid), st)).toEqual({ color: 'list.errorForeground', badge: '2', tooltip: 'first' });
  expect(projectDecoration(projectUri(project('Render').guid), st)).toEqual({ color: 'list.errorForeground', badge: '!', tooltip: 'failed' });
  expect(projectDecoration(projectUri(project('Game').guid), st)).toEqual({ color: 'list.warningForeground' });
  expect(projectDecoration(projectUri(project('Legacy').guid), st)).toEqual({ color: 'disabledForeground', tooltip: 'not in Release|x64' });
});

test('error badges are capped at two characters', () => {
  const many = Array.from({ length: 120 }, () => error('Math'));
  const st = withBuild(build([...many, finished('Math', true)], { exitCode: 1, cancelled: false }));
  expect(projectDecoration(projectUri(project('Math').guid), st)!.badge).toBe('99');
});

test('status bar build entry', () => {
  const running = withBuild(build([started('Math'), finished('Math')]));
  expect(statusBarItems(running).find(i => i.id === 'build')).toEqual({ id: 'build', text: '$(sync~spin) Building 1/3', tooltip: 'Build in progress', command: 'vssln.showBuildOutput' });
  const runningWithErrors = withBuild(build([started('Math'), error('Math'), error('Math')]));
  expect(statusBarItems(runningWithErrors).find(i => i.id === 'build')!.text).toBe('$(sync~spin) Building 0/3 · $(error) 2');
  const failed = withBuild(build([error('Math'), error('Game')], { exitCode: 1, cancelled: false }));
  expect(statusBarItems(failed).find(i => i.id === 'build')).toEqual({
    id: 'build', text: '$(error) 2 errors', tooltip: 'Build failed: 2 errors', command: 'workbench.actions.view.problems', background: 'statusBarItem.errorBackground',
  });
  const ok = withBuild(build([], { exitCode: 0, cancelled: false }));
  expect(statusBarItems(ok).find(i => i.id === 'build')).toEqual({
    id: 'build', text: '$(check) Built 1:05', tooltip: `Build succeeded at ${clock(66_000)}`, command: 'vssln.showBuildOutput',
  });
  expect(statusBarItems(withBuild(build([], { exitCode: null, cancelled: true }))).find(i => i.id === 'build')).toBeUndefined();
});

test('status bar wording follows the action and the result', () => {
  const ok = withBuild(build([], { exitCode: 0, cancelled: false }));
  expect(statusBarItems(ok).find(i => i.id === 'build')!.color).toBeUndefined();
  expect(statusBarItems({ ...ok, build: { ...ok.build, action: 'Rebuild' } }).find(i => i.id === 'build')!.text).toBe('$(check) Rebuilt 1:05');
  expect(statusBarItems({ ...ok, build: { ...ok.build, action: 'Clean' } }).find(i => i.id === 'build')!.text).toBe('$(check) Cleaned 1:05');
  const noErrors = withBuild(build([], { exitCode: 1, cancelled: false }));
  expect(statusBarItems(noErrors).find(i => i.id === 'build')!.text).toBe('$(error) Build failed');
  expect(buildRow(noErrors)!.description).toBe(`failed · ${clock(66_000)} · 1:05`);
});

test('a success with warnings is yellow', () => {
  const st = withBuild(build([started('Math'), warning('Math'), warning('Math'), finished('Math')], { exitCode: 0, cancelled: false }));
  expect(buildRow(st)).toMatchObject({ icon: 'warning', iconColor: 'list.warningForeground', description: `succeeded · 2 warnings · ${clock(66_000)} · 1:05` });
  expect(statusDecoration('vssln-status:/build', st)).toEqual({ color: 'list.warningForeground' });
  expect(statusBarItems(st).find(i => i.id === 'build')!.text).toBe('$(warning) Built 1:05 · 2 warnings');
});

test('build row colors', () => {
  expect(buildRow(withBuild(build([])), 1_000)).toMatchObject({ iconColor: 'charts.blue' });
  const ok = withBuild(build([], { exitCode: 0, cancelled: false }));
  expect(buildRow(ok)).toMatchObject({ iconColor: 'testing.iconPassed', resourceUri: 'vssln-status:/build' });
  expect(statusDecoration('vssln-status:/build', ok)).toEqual({ color: 'testing.iconPassed' });
  const failed = withBuild(build([error('Math')], { exitCode: 1, cancelled: false }));
  expect(buildRow(failed)).toMatchObject({ iconColor: 'testing.iconFailed' });
  expect(statusDecoration('vssln-status:/build', failed)).toEqual({ color: 'list.errorForeground' });
  expect(statusDecoration('vssln-status:/build', withBuild(build([])))).toBeUndefined();
  expect(statusDecoration('vssln-status:/other', ok)).toBeUndefined();
});

test('project colors follow the build result', () => {
  const st = withBuild(build([
    started('Math'), finished('Math'),
    started('Game'), warning('Game'), finished('Game'),
    error('Render'), finished('Render', true),
  ], { exitCode: 1, cancelled: false }));
  expect(projectRow(node('Math'), st).iconColor).toBe('testing.iconPassed');
  expect(projectRow(node('Game'), st).iconColor).toBe('list.warningForeground');
  expect(projectRow(node('Render'), st).iconColor).toBe('testing.iconFailed');
  expect(projectRow(node('Math'), withBuild(build([started('Math')]))).iconColor).toBe('charts.blue');
  expect(projectRow(node('Math'), withBuild(build([]))).iconColor).toBeUndefined();
  expect(projectRow(node('Math'), s).iconColor).toBeUndefined();
});

test('skipped projects are greyed', () => {
  const st = withBuild(build([], { exitCode: null, cancelled: true }));
  expect(projectDecoration(projectUri(project('Math').guid), st)).toEqual({ color: 'disabledForeground', tooltip: 'skipped' });
});
