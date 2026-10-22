import * as fs from 'fs';
import * as path from 'path';
import { expect, test } from 'vitest';
import { OutputParser } from '../../src/build/outputParser';
import { applyBuildEvent, BuildState, expectedProjects, finishBuild, idleBuild, startBuild } from '../../src/state/build';
import { parseSln } from '../../src/solution/slnParser';
import { ProjectEntry } from '../../src/state/store';
import { readFixture } from './helpers';

const engine = parseSln(fs.readFileSync(path.join(__dirname, '..', '..', 'samples', 'Engine', 'Engine.sln'), 'utf8'), 'C:\\src\\Engine\\Engine.sln');
const releaseX64 = engine.configurations.find(c => c.name === 'Release|x64')!;
const entries = new Map<string, ProjectEntry>(engine.projects.map(p => [p.guid, { exists: p.name !== 'Missing' }]));
const guid = (name: string) => engine.projects.find(p => p.name === name)!.guid;
const byPath = (p: string) => engine.projects.find(x => x.absPath.toLowerCase() === p.toLowerCase())?.guid;
const MATH = 'C:\\src\\Engine\\Core\\Math\\Math.vcxproj';

function replay(rel: string, b: BuildState): BuildState {
  const parser = new OutputParser();
  let t = 100;
  for (const line of readFixture(rel).split(/\r?\n/)) {
    for (const e of parser.push(line).events) b = applyBuildEvent(b, e, byPath, t++);
  }
  return b;
}

const solutionBuild = () => startBuild({ action: 'Rebuild' }, expectedProjects(engine, releaseX64, entries), 'C:\\t\\build.log', 0);

test('idle build', () => {
  expect(idleBuild).toMatchObject({ status: 'idle', total: 0, done: 0, errors: 0, warnings: 0 });
  expect(idleBuild.projects.size).toBe(0);
});

test('expected projects: built C++ projects with a file', () => {
  const names = expectedProjects(engine, releaseX64, entries).map(g => engine.projects.find(p => p.guid === g)!.name).sort();
  expect(names).toEqual(['AssetCooker', 'Audio', 'Containers', 'Editor', 'Game', 'Math', 'MathTests', 'Platform', 'Render', 'Shaders']);
});

test('start puts expected projects in waiting', () => {
  const b = solutionBuild();
  expect(b).toMatchObject({ status: 'running', action: 'Rebuild', startedAt: 0, total: 10, done: 0, logFile: 'C:\\t\\build.log' });
  expect(b.projectName).toBeUndefined();
  expect(b.projects.get(guid('Math'))).toEqual({ status: 'waiting', errors: 0, warnings: 0, messages: [] });
});

test('project build names the project', () => {
  const b = startBuild({ action: 'Build', project: engine.projects.find(p => p.name === 'Render')! }, [guid('Render')], 'l', 0);
  expect(b.projectName).toBe('Render');
  expect(b.total).toBe(1);
});

test('events move a project through building and finished', () => {
  let b = solutionBuild();
  b = applyBuildEvent(b, { kind: 'projectStarted', path: MATH, target: 'Rebuild' }, byPath, 5);
  expect(b.projects.get(guid('Math'))).toMatchObject({ status: 'building', startedAt: 5 });
  b = applyBuildEvent(b, { kind: 'projectFinished', path: MATH, target: 'Rebuild', failed: false }, byPath, 9);
  expect(b.projects.get(guid('Math'))).toMatchObject({ status: 'succeeded', finishedAt: 9 });
  expect(b.done).toBe(1);
});

test('a project that was not expected raises the total', () => {
  let b = startBuild({ action: 'Build', project: engine.projects.find(p => p.name === 'Render')! }, [guid('Render')], 'l', 0);
  b = applyBuildEvent(b, { kind: 'projectStarted', path: MATH, target: 'Build' }, byPath, 1);
  expect(b.total).toBe(2);
  expect(b.projects.get(guid('Math'))!.status).toBe('building');
});

test('diagnostics count per project and per build, at most five messages', () => {
  let b = solutionBuild();
  for (let i = 0; i < 7; i++) b = applyBuildEvent(b, { kind: 'diagnostic', severity: 'error', projectPath: MATH, text: `e${i}` }, byPath, 1);
  b = applyBuildEvent(b, { kind: 'diagnostic', severity: 'warning', projectPath: MATH, text: 'w' }, byPath, 1);
  b = applyBuildEvent(b, { kind: 'diagnostic', severity: 'warning', projectPath: 'C:\\src\\Engine\\Engine.sln', text: 'MSB4121' }, byPath, 1);
  expect(b.projects.get(guid('Math'))).toMatchObject({ errors: 7, warnings: 1, messages: ['e0', 'e1', 'e2', 'e3', 'e4'] });
  expect(b).toMatchObject({ errors: 7, warnings: 2 });
});

test('events of a target that does not match the action are ignored', () => {
  let b = solutionBuild();
  b = applyBuildEvent(b, { kind: 'projectStarted', path: MATH, target: 'Clean' }, byPath, 1);
  b = applyBuildEvent(b, { kind: 'projectFinished', path: MATH, target: 'Clean', failed: false }, byPath, 2);
  expect(b.projects.get(guid('Math'))!.status).toBe('waiting');
  let clean = startBuild({ action: 'Clean' }, [guid('Math')], 'l', 0);
  clean = applyBuildEvent(clean, { kind: 'projectFinished', path: MATH, target: 'Clean', failed: false }, byPath, 2);
  expect(clean.projects.get(guid('Math'))!.status).toBe('succeeded');
});

test('unknown paths are ignored', () => {
  const b = solutionBuild();
  expect(applyBuildEvent(b, { kind: 'projectStarted', path: 'C:\\elsewhere\\X.vcxproj', target: 'Build' }, byPath, 1).projects).toEqual(b.projects);
});

test('transitions do not mutate their input', () => {
  const b = solutionBuild();
  applyBuildEvent(b, { kind: 'projectStarted', path: MATH, target: 'Rebuild' }, byPath, 5);
  expect(b.projects.get(guid('Math'))!.status).toBe('waiting');
});

test('replaying a failed rebuild', () => {
  const b = finishBuild(replay('msbuild/rebuild-failed.log', solutionBuild()), { exitCode: 1, cancelled: false }, 999);
  expect(b).toMatchObject({ status: 'failed', finishedAt: 999, errors: 1 });
  expect(b.projects.get(guid('Math'))).toMatchObject({ status: 'failed', errors: 1 });
  expect(b.projects.get(guid('Game'))).toMatchObject({ status: 'failed', errors: 0 });
  expect(b.projects.get(guid('Render'))!.status).toBe('skipped');
  expect(b.projects.get(guid('Audio'))!.status).toBe('succeeded');
});

test('replaying an incremental build', () => {
  const b = finishBuild(replay('msbuild/build-incremental.log', solutionBuild()), { exitCode: 0, cancelled: false }, 999);
  expect(b).toMatchObject({ status: 'succeeded', done: 10, total: 10, errors: 0 });
  expect([...b.projects.values()].every(p => p.status === 'succeeded')).toBe(true);
});

test('cancel while building', () => {
  let b = applyBuildEvent(solutionBuild(), { kind: 'projectStarted', path: MATH, target: 'Rebuild' }, byPath, 1);
  b = finishBuild(b, { exitCode: null, cancelled: true }, 50);
  expect(b.status).toBe('cancelled');
  expect(b.projects.get(guid('Math'))!.status).toBe('skipped');
  expect([...b.projects.values()].some(p => p.status === 'building' || p.status === 'waiting')).toBe(false);
});
