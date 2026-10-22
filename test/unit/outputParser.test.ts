import { expect, test } from 'vitest';
import { BuildEvent, OutputParser } from '../../src/build/outputParser';
import { readFixture } from './helpers';

const E = 'C:\\src\\Engine\\';

function parseAll(rel: string): { events: BuildEvent[]; display: string[] } {
  const parser = new OutputParser();
  const events: BuildEvent[] = [];
  const display: string[] = [];
  for (const line of readFixture(rel).split(/\r?\n/)) {
    const r = parser.push(line);
    events.push(...r.events);
    if (r.display !== undefined) display.push(r.display);
  }
  return { events, display };
}

const started = (events: BuildEvent[]) => events.flatMap(e => (e.kind === 'projectStarted' ? [e.path] : []));
const finished = (events: BuildEvent[]) => events.flatMap(e => (e.kind === 'projectFinished' ? [{ path: e.path, failed: e.failed }] : []));

test('failed rebuild: starts, finishes and one counted error', () => {
  const { events } = parseAll('msbuild/rebuild-failed.log');
  expect(started(events)).toContain(`${E}Core\\Math\\Math.vcxproj`);
  expect(finished(events)).toContainEqual({ path: `${E}Core\\Math\\Math.vcxproj`, failed: true });
  expect(finished(events)).toContainEqual({ path: `${E}Audio\\Audio.vcxproj`, failed: false });
  expect(events.filter(e => e.kind === 'diagnostic' && e.severity === 'error')).toEqual([
    { kind: 'diagnostic', severity: 'error', projectPath: `${E}Core\\Math\\Math.vcxproj`, text: expect.stringContaining('C1189') },
  ]);
});

test('the solution itself is not a project event', () => {
  const { events } = parseAll('msbuild/rebuild-failed.log');
  expect([...started(events), ...finished(events).map(f => f.path)].every(p => p.endsWith('.vcxproj'))).toBe(true);
});

test('a project built through a reference is tracked', () => {
  const { events } = parseAll('msbuild/build-incremental.log');
  expect(started(events)).toContain(`${E}Graphics\\Render\\Render.vcxproj`);
  expect(finished(events)).toContainEqual({ path: `${E}Graphics\\Render\\Render.vcxproj`, failed: false });
  expect(new Set(started(events)).size).toBe(10);
});

test('metaproj lines are ignored and compound instance ids are read', () => {
  const { events } = parseAll('msbuild/project-rebuild.log');
  expect(started(events).some(p => p.endsWith('.metaproj'))).toBe(false);
  // Math is started by Render as instance "5:2".
  expect(started(events).filter(p => p.endsWith('Math.vcxproj'))).toHaveLength(1);
  expect(finished(events)).toContainEqual({ path: `${E}Graphics\\Render\\Render.vcxproj`, failed: false });
});

test('reference calls with other targets do not count', () => {
  const p = new OutputParser();
  expect(p.push('     5>Project "C:\\a\\Game.vcxproj" (5) is building "C:\\a\\Render.vcxproj" (12:3) on node 1 (GetTargetPath target(s)).').events).toEqual([]);
  expect(p.push('    12:3>Done Building Project "C:\\a\\Render.vcxproj" (GetTargetPath target(s)).').events).toEqual([]);
});

test('compound instance ids on finish lines', () => {
  expect(new OutputParser().push('5:2>Done Building Project "C:\\a\\B.vcxproj" (default targets).').events)
    .toEqual([{ kind: 'projectFinished', path: 'C:\\a\\B.vcxproj', failed: false }]);
});

test('display lines', () => {
  const p = new OutputParser();
  expect(p.push('     6>Done Building Project "C:\\a\\Math.vcxproj" (Rebuild target(s)) -- FAILED.').display).toBe('Math: FAILED');
  expect(p.push('     7>Done Building Project "C:\\a\\Platform.vcxproj" (Rebuild target(s)).').display).toBe('Platform: succeeded');
  expect(p.push('  Game.vcxproj -> C:\\out\\Game.exe').display).toBe('Game.vcxproj -> C:\\out\\Game.exe');
  expect(p.push('     1>Project "C:\\a\\E.sln" (1) is building "C:\\a\\Math.vcxproj" (6) on node 7 (Rebuild target(s)).').display).toBeUndefined();
  expect(p.push('     6>C:\\a\\v.cpp(4,1): error C1189: #error: boom [C:\\a\\Math.vcxproj]').display).toBe('C:\\a\\v.cpp(4,1): error C1189: #error: boom [C:\\a\\Math.vcxproj]');
  expect(p.push('  ClCompile:').display).toBeUndefined();
});

test('the final summary is displayed but its diagnostics are not counted again', () => {
  const { events, display } = parseAll('msbuild/rebuild-failed.log');
  expect(display).toContain('Build FAILED.');
  expect(display.filter(l => l.includes('C1189'))).toHaveLength(2);
  expect(events.filter(e => e.kind === 'diagnostic' && e.text.includes('C1189'))).toHaveLength(1);
  expect(display.some(l => l.startsWith('Time Elapsed'))).toBe(true);
});

test('warning MSB4121 is a warning of the solution', () => {
  const { events } = parseAll('msbuild/build-incremental.log');
  expect(events.filter(e => e.kind === 'diagnostic')).toEqual([
    { kind: 'diagnostic', severity: 'warning', projectPath: `${E}Engine.sln`, text: expect.stringContaining('MSB4121') },
  ]);
});
