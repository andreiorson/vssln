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
    .toEqual([{ kind: 'projectFinished', path: 'C:\\a\\B.vcxproj', target: 'Build', failed: false }]);
});

test('events carry their target', () => {
  const p = new OutputParser();
  expect(p.push('5>Project "C:\\a\\G.vcxproj" (5) is building "C:\\a\\R.vcxproj" (12) on node 1 (Clean target(s)).').events)
    .toEqual([{ kind: 'projectStarted', path: 'C:\\a\\R.vcxproj', target: 'Clean' }]);
  expect(p.push('6>Done Building Project "C:\\a\\M.vcxproj" (Rebuild target(s)) -- FAILED.').events)
    .toEqual([{ kind: 'projectFinished', path: 'C:\\a\\M.vcxproj', target: 'Rebuild', failed: true }]);
});

test('fatal, code-less and categorized diagnostics are recognised and displayed', () => {
  const cases: [string, 'error' | 'warning', string | undefined][] = [
    ['     5>C:\\out\\Audio.dll : fatal error LNK1120: 1 unresolved externals [C:\\a\\Audio.vcxproj]', 'error', 'C:\\a\\Audio.vcxproj'],
    ['     5>LINK : fatal error LNK1104: cannot open file \'x.lib\' [C:\\a\\Game.vcxproj]', 'error', 'C:\\a\\Game.vcxproj'],
    ['     5>LINK : error LNK2001: unresolved external symbol foo [C:\\a\\Audio.vcxproj]', 'error', 'C:\\a\\Audio.vcxproj'],
    ['     6>cl : command line error D8016: \'/ZI\' and \'/Gy-\' command-line options are incompatible [C:\\a\\Math.vcxproj]', 'error', 'C:\\a\\Math.vcxproj'],
    ['     6>EXEC : error : the tool failed [C:\\a\\Shaders.vcxproj]', 'error', 'C:\\a\\Shaders.vcxproj'],
    ['     6>C:\\a\\m.cpp(3): warning C4100: unused [C:\\a\\Math.vcxproj]', 'warning', 'C:\\a\\Math.vcxproj'],
  ];
  for (const [line, severity, projectPath] of cases) {
    const r = new OutputParser().push(line);
    expect(r.events).toEqual([{ kind: 'diagnostic', severity, projectPath, text: line.replace(/^\s*\d+>/, '') }]);
    expect(r.display).toBe(line.replace(/^\s*\d+>/, ''));
  }
});

test('ordinary messages that mention errors are not diagnostics', () => {
  const p = new OutputParser();
  expect(p.push('         Structured output is enabled. The formatting of compiler diagnostics will reflect the error hierarchy. See https://aka.ms/cpp/structured-output for more details.').events).toEqual([]);
});

test('display lines', () => {
  const p = new OutputParser({ configurationOf: path => (path.endsWith('Math.vcxproj') ? 'Release x64' : undefined) });
  // Finish lines are shown by the session, which knows whether the target counts for the build.
  expect(p.push('     6>Done Building Project "C:\\a\\Math.vcxproj" (Rebuild target(s)) -- FAILED.').display).toBeUndefined();
  // Lines of no known project carry no number.
  expect(p.push('  Game.vcxproj -> C:\\out\\Game.exe').display).toBe('Game.vcxproj -> C:\\out\\Game.exe');
  // A project that starts real work gets the next number and a header, as in Visual Studio.
  expect(p.push('     1>Project "C:\\a\\E.sln" (1) is building "C:\\a\\Math.vcxproj" (6) on node 7 (Rebuild target(s)).').display)
    .toBe('1>------ Rebuild All started: Project: Math, Configuration: Release x64 ------');
  expect(p.push('     6>C:\\a\\v.cpp(4,1): error C1189: #error: boom [C:\\a\\Math.vcxproj]').display).toBe('1>C:\\a\\v.cpp(4,1): error C1189: #error: boom [C:\\a\\Math.vcxproj]');
  // Unprefixed lines belong to the project of the last prefix.
  expect(p.push('         vector.cpp').display).toBe('1>vector.cpp');
  expect(p.push('       ClCompile:').display).toBeUndefined();
  expect(p.numberOf('C:\\a\\math.vcxproj')).toBe(1);
  // A second request for the same instance (5:2 after 5) is no new project.
  expect(p.push('     1>Project "C:\\a\\E.sln" (1) is building "C:\\a\\Math.vcxproj" (6:2) on node 7 (Build target(s)).').display).toBeUndefined();
  // Headers for the other actions.
  expect(p.push('     1>Project "C:\\a\\E.sln" (1) is building "C:\\a\\Game.vcxproj" (7) on node 7 (default targets).').display).toBe('2>------ Build started: Project: Game ------');
  expect(p.push('     1>Project "C:\\a\\E.sln" (1) is building "C:\\a\\Tool.vcxproj" (8) on node 7 (Clean target(s)).').display).toBe('3>------ Clean started: Project: Tool ------');
});

test('more bookkeeping is hidden: relative object files, the solution start, the batch wrapper of build events', () => {
  const p = new OutputParser();
  expect(p.push('     1>Project "C:\\a\\E.sln" on node 1 (Rebuild target(s)).').display).toBeUndefined();
  p.push('     1>Project "C:\\a\\E.sln" (1) is building "C:\\a\\P.vcxproj" (5) on node 1 (default targets).');
  p.push('     5>PostBuildEvent:');
  for (const line of [
    '         P\\x64\\Release\\b.obj',
    '         x64\\Release\\P.res',
    '         setlocal',
    '         :VCEnd',
    '         if %errorlevel% neq 0 goto :VCEnd',
    '         endlocal & call :cmErrorLevel %errorlevel% & goto :cmDone',
    '         :cmEnd',
    '         :cmErrorLevel',
    '         exit /b %1',
    '         :cmDone',
  ]) {
    expect(p.push(line).display, line).toBeUndefined();
  }
  expect(p.push('         copied assets').display).toBe('1>copied assets');
  expect(p.push('         Note: including file: x.h').display).toBe('1>Note: including file: x.h');
});

test('projects of any MSBuild type get numbers and results; solution metaprojects do not', () => {
  const p = new OutputParser();
  expect(p.push('     1>Project "C:\\a\\E.sln" (1) is building "C:\\a\\Tool\\Tool.csproj" (2) on node 1 (default targets).')).toEqual({
    events: [{ kind: 'projectStarted', path: 'C:\\a\\Tool\\Tool.csproj', target: 'Build' }],
    display: '1>------ Build started: Project: Tool.csproj ------',
  });
  expect(p.push('     2>Done Building Project "C:\\a\\Tool\\Tool.csproj" (default targets) -- FAILED.').events).toEqual([
    { kind: 'projectFinished', path: 'C:\\a\\Tool\\Tool.csproj', target: 'Build', failed: true },
  ]);
  expect(p.push('     1>Project "C:\\a\\E.sln" (1) is building "C:\\a\\R.vcxproj.metaproj" (3) on node 1 (default targets).').events).toEqual([]);
});

test('only the work of the action gets a number and a header: a Clean that a Rebuild calls on the side does not', () => {
  const p = new OutputParser({ counts: target => target === 'Rebuild' });
  expect(p.push('     4>Project "C:\\a\\G.vcxproj" (4) is building "C:\\a\\R.vcxproj" (10) on node 1 (Clean target(s)).').display).toBeUndefined();
  expect(p.push('         Deleting nothing').display).toBe('Deleting nothing');
  expect(p.push('     1>Project "C:\\a\\E.sln" (1) is building "C:\\a\\R.vcxproj" (10:2) on node 1 (Rebuild target(s)).').display).toBe('1>------ Rebuild All started: Project: R ------');
  expect(p.numberOf('C:\\a\\R.vcxproj')).toBe(1);
});

test('the output reads like Visual Studio: progress kept, MSBuild bookkeeping hidden', () => {
  const parser = new OutputParser({ configurationOf: () => 'Release x64' });
  const display = readFixture('msbuild/project-rebuild.log').split(/\r?\n/).flatMap(l => parser.push(l).display ?? []);
  expect(display).toEqual(expect.arrayContaining([
    '1>------ Rebuild All started: Project: Shaders, Configuration: Release x64 ------',
    '1>Generating shaders.h',
    '2>------ Rebuild All started: Project: Render, Configuration: Release x64 ------',
    '3>------ Build started: Project: Math, Configuration: Release x64 ------',
    '3>vector.cpp',
    '3>matrix.cpp',
    `3>Math.vcxproj -> ${E}out\\x64\\Release\\Math.lib`,
    '2>render.cpp',
    `2>Creating library ${E}out\\x64\\Release\\Render.lib and object ${E}out\\x64\\Release\\Render.exp`,
    '2>Generating code',
    `2>Render.vcxproj -> ${E}out\\x64\\Release\\Render.dll`,
    'Build succeeded.',
  ]));
  const hidden = /CL\.exe|Lib\.exe|link\.exe|Touching|Deleting file|Creating "|Structured output|Adding module source|Reading library manifest|Building solution configuration|is not selected for building|\.obj$|^\d*>?[A-Za-z_]\w*:$|Build started \d/i;
  expect(display.filter(l => hidden.test(l))).toEqual([]);
  expect(display.filter(l => l.trim() === '')).toEqual([]);
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
