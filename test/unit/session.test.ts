import * as fs from 'fs';
import * as path from 'path';
import { expect, test } from 'vitest';
import { BuildRunner, Spawn } from '../../src/build/runner';
import { runBuild, SessionDeps } from '../../src/build/session';
import { parseSln } from '../../src/solution/slnParser';
import { AppState, initialState, ProjectEntry, Store } from '../../src/state/store';
import { VsInstance } from '../../src/toolchain/vswhere';
import { readFixture } from './helpers';

const engine = parseSln(fs.readFileSync(path.join(__dirname, '..', '..', 'samples', 'Engine', 'Engine.sln'), 'utf8'), 'C:\\src\\Engine\\Engine.sln');
const VS: VsInstance = {
  installationPath: 'C:\\VS', installationVersion: '18.0', displayName: 'VS',
  msbuildPath: 'C:\\VS\\MSBuild\\Current\\Bin\\MSBuild.exe', devEnvDir: 'C:\\VS\\Common7\\IDE\\',
};
const guid = (name: string) => engine.projects.find(p => p.name === name)!.guid;

function readyState(over: Partial<AppState> = {}): AppState {
  return {
    ...initialState,
    phase: 'ready',
    folder: 'C:\\src\\Engine',
    solutions: [engine.path],
    solution: engine,
    configuration: engine.configurations.find(c => c.name === 'Release|x64'),
    projects: new Map<string, ProjectEntry>(engine.projects.map(p => [p.guid, { exists: p.name !== 'Missing' }])),
    toolchain: VS,
    settings: { environment: { ENGINE_SDK: '${workspaceFolder}\\sdk' }, msbuild: { properties: { UseMultiToolTask: 'true' } } },
    ...over,
  };
}

/** A runner whose process replays a log, or waits for `release()` when `hold` is set. */
function fakeRunner(log: string, exitCode: number, hold = false) {
  const spawned: { file: string; args: string[]; env: Record<string, string | undefined> }[] = [];
  let release = () => {};
  const spawn: Spawn = (file, args, env) => {
    spawned.push({ file, args, env });
    let lineCb: (l: string) => void = () => {};
    let exitCb: (c: number | null) => void = () => {};
    const play = () => {
      for (const line of readFixture(log).split(/\r?\n/)) lineCb(line);
      exitCb(exitCode);
    };
    if (hold) release = play;
    else setImmediate(play);
    return { pid: 1, onLine: cb => (lineCb = cb), onExit: cb => (exitCb = cb) };
  };
  return { runner: new BuildRunner(spawn, async () => {}), spawned, release: () => release() };
}

function deps(store: Store, runner: BuildRunner, written: string[]): SessionDeps {
  let t = 0;
  return { store, runner, now: () => (t += 1000), logDir: 'C:\\logs', env: { PATH: 'C:\\bin' }, write: l => written.push(l) };
}

test('a failed rebuild ends in the store with Math failed', async () => {
  const store = new Store();
  store.set(readyState());
  const { runner } = fakeRunner('msbuild/rebuild-failed.log', 1);
  const written: string[] = [];
  const r = await runBuild(deps(store, runner, written), { action: 'Rebuild' });
  expect(r.started).toBe(true);
  const b = store.state.build;
  expect(b.status).toBe('failed');
  expect(b.projects.get(guid('Math'))).toMatchObject({ status: 'failed', errors: 1 });
  expect(b.logFile).toBe('C:\\logs\\build.log');
  expect(written[0]).toBe('Rebuild Engine.sln (Release|x64)');
  expect(written).toContain('Math: FAILED');
  expect(written.some(l => l.includes('error C1189'))).toBe(true);
  expect(written.at(-1)).toBe('Build log: C:\\logs\\build.log');
});

test('MSBuild gets the arguments, the expanded environment and English output', async () => {
  const store = new Store();
  store.set(readyState());
  const { runner, spawned } = fakeRunner('msbuild/build-incremental.log', 0);
  await runBuild(deps(store, runner, []), { action: 'Build' });
  expect(spawned[0].file).toBe(VS.msbuildPath);
  expect(spawned[0].args).toContain('-p:UseMultiToolTask=true');
  expect(spawned[0].env).toMatchObject({ PATH: 'C:\\bin', ENGINE_SDK: 'C:\\src\\Engine\\sdk', VSLANG: '1033' });
  expect(store.state.build.status).toBe('succeeded');
});

test('a project build starts with only that project and names it', async () => {
  const store = new Store();
  store.set(readyState());
  const { runner, spawned } = fakeRunner('msbuild/project-rebuild.log', 0);
  const written: string[] = [];
  const render = engine.projects.find(p => p.name === 'Render')!;
  await runBuild(deps(store, runner, written), { action: 'Rebuild', project: render });
  expect(spawned[0].args[1]).toBe('-t:Graphics\\Render:Rebuild');
  expect(written[0]).toBe('Rebuild Render (Release|x64)');
  expect(store.state.build.projectName).toBe('Render');
  expect(store.state.build.projects.get(guid('Render'))!.status).toBe('succeeded');
});

test('a second build while one runs is refused and spawns nothing', async () => {
  const store = new Store();
  store.set(readyState());
  const { runner, spawned, release } = fakeRunner('msbuild/build-incremental.log', 0, true);
  const first = runBuild(deps(store, runner, []), { action: 'Build' });
  const second = await runBuild(deps(store, runner, []), { action: 'Build' });
  expect(second).toEqual({ started: false, reason: 'A build is already running.' });
  expect(spawned).toHaveLength(1);
  release();
  expect((await first).started).toBe(true);
});

test('without a toolchain nothing starts', async () => {
  const store = new Store();
  store.set(readyState({ toolchain: undefined }));
  const { runner, spawned } = fakeRunner('msbuild/build-incremental.log', 0);
  const r = await runBuild(deps(store, runner, []), { action: 'Build' });
  expect(r.started).toBe(false);
  expect(r.started === false && r.reason).toMatch(/Configure toolchain/);
  expect(spawned).toHaveLength(0);
  expect(store.state.build.status).toBe('idle');
});

test('without a loaded solution nothing starts', async () => {
  const store = new Store();
  store.set({ ...initialState, phase: 'noSolution' });
  const { runner, spawned } = fakeRunner('msbuild/build-incremental.log', 0);
  expect((await runBuild(deps(store, runner, []), { action: 'Build' })).started).toBe(false);
  expect(spawned).toHaveLength(0);
});
