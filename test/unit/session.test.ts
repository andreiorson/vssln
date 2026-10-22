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
/** The sample without its .sln dependencies: builds of it are one MSBuild run, as the captured logs are. */
const flat = { ...engine, projects: engine.projects.map(p => ({ ...p, dependencies: [] })) };

function readyState(over: Partial<AppState> = {}): AppState {
  return {
    ...initialState,
    phase: 'ready',
    folder: 'C:\\src\\Engine',
    solutions: [engine.path],
    solution: flat,
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
    return { pid: 1, onLine: cb => (lineCb = cb), onError: () => {}, onExit: cb => (exitCb = cb) };
  };
  return { runner: new BuildRunner(spawn, async () => {}), spawned, release: () => release() };
}

function deps(store: Store, runner: BuildRunner, written: string[], files = new Map<string, string>()): SessionDeps {
  let t = 0;
  return {
    store, runner, now: () => (t += 1000), logDir: 'C:\\logs', env: { PATH: 'C:\\bin' }, write: l => written.push(l),
    writeFile: async (p, text) => void files.set(p, text),
    projectFiles: { readText: async () => undefined, exists: async () => false },
  };
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
  // Visual Studio-style output: numbered projects, headers with the project's configuration.
  expect(written).toContainEqual(expect.stringMatching(/^\d+>Math: FAILED$/));
  expect(written).toContainEqual(expect.stringMatching(/^\d+>------ Rebuild All started: Project: Math, Configuration: Release x64 ------$/));
  expect(written.some(l => /^\d+>.*error C1189/.test(l))).toBe(true);
  expect(written.at(-1)).toBe('Build log: C:\\logs\\build.log');
});

test('MSBuild gets the arguments, the expanded environment and English output', async () => {
  const store = new Store();
  store.set(readyState());
  const { runner, spawned } = fakeRunner('msbuild/build-incremental.log', 0);
  await runBuild(deps(store, runner, []), { action: 'Build' });
  expect(spawned[0].file).toBe(VS.msbuildPath);
  expect(spawned[0].args).toContain('-p:UseMultiToolTask=true');
  // MSBuild takes its language from DOTNET_CLI_UI_LANGUAGE; cl and link from VSLANG.
  expect(spawned[0].env).toMatchObject({ PATH: 'C:\\bin', ENGINE_SDK: 'C:\\src\\Engine\\sdk', VSLANG: '1033', DOTNET_CLI_UI_LANGUAGE: 'en-US' });
  expect(store.state.build.status).toBe('succeeded');
});

test('settings override environment variables regardless of case, and editor-only variables are dropped', async () => {
  const store = new Store();
  store.set(readyState({ settings: { environment: { path: 'D:\\tools' } } }));
  const { runner, spawned } = fakeRunner('msbuild/build-incremental.log', 0);
  const d = deps(store, runner, []);
  d.env = { Path: 'C:\\bin', ELECTRON_RUN_AS_NODE: '1', VSCODE_PID: '7', OTHER: 'x' };
  await runBuild(d, { action: 'Build' });
  const env = spawned[0].env;
  expect(Object.keys(env).filter(k => k.toLowerCase() === 'path').map(k => env[k])).toEqual(['D:\\tools']);
  expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  expect(env.VSCODE_PID).toBeUndefined();
  expect(env.OTHER).toBe('x');
});

test('a Clean call during a Rebuild is not reported as the project succeeding', async () => {
  const store = new Store();
  store.set(readyState());
  const { runner } = fakeRunner('msbuild/rebuild-failed.log', 1);
  const written: string[] = [];
  await runBuild(deps(store, runner, written), { action: 'Rebuild' });
  expect(written.filter(l => l.endsWith('>Render: succeeded'))).toEqual([]);
  expect(written).toContainEqual(expect.stringMatching(/^\d+>Platform: succeeded$/));
  expect(written).toContainEqual(expect.stringMatching(/^\d+>Math: FAILED$/));
});

test('an exception from the runner still finishes the build', async () => {
  const store = new Store();
  store.set(readyState());
  const runner = new BuildRunner(() => {
    throw new Error('spawn exploded');
  }, async () => {});
  const written: string[] = [];
  const r = await runBuild(deps(store, runner, written), { action: 'Build' });
  expect(r.started).toBe(true);
  expect(store.state.build.status).toBe('failed');
  expect(written.some(l => l.includes('spawn exploded'))).toBe(true);
});

test('a process that cannot start is explained', async () => {
  const store = new Store();
  store.set(readyState());
  const spawn: Spawn = () => {
    let errorCb: (m: string) => void = () => {};
    let exitCb: (c: number | null) => void = () => {};
    setImmediate(() => {
      errorCb('spawn C:\\VS\\MSBuild.exe ENOENT');
      exitCb(null);
    });
    return { pid: undefined, onLine: () => {}, onError: cb => (errorCb = cb), onExit: cb => (exitCb = cb) };
  };
  const written: string[] = [];
  await runBuild(deps(store, new BuildRunner(spawn, async () => {}), written), { action: 'Build' });
  expect(written).toContain('MSBuild could not start: spawn C:\\VS\\MSBuild.exe ENOENT');
  expect(store.state.build.status).toBe('failed');
});

test('a stopped build says so', async () => {
  const store = new Store();
  store.set(readyState());
  const proc = { exit: (_c: number | null) => {} };
  const spawn: Spawn = () => ({ pid: 9, onLine: () => {}, onError: () => {}, onExit: cb => (proc.exit = cb) });
  const runner = new BuildRunner(spawn, async () => proc.exit(1));
  const written: string[] = [];
  const done = runBuild(deps(store, runner, written), { action: 'Build' });
  await runner.stop();
  await done;
  expect(store.state.build.status).toBe('cancelled');
  expect(written).toContain('Build stopped.');
});

test('onStarted is called once for a started build and never for a refused one', async () => {
  const store = new Store();
  store.set(readyState());
  const { runner } = fakeRunner('msbuild/build-incremental.log', 0);
  let started = 0;
  await runBuild({ ...deps(store, runner, []), onStarted: () => started++ }, { action: 'Build' });
  expect(started).toBe(1);
  store.set(readyState({ toolchain: undefined }));
  await runBuild({ ...deps(store, runner, []), onStarted: () => started++ }, { action: 'Build' });
  expect(started).toBe(1);
});

test('onStarted comes before the first written line, so clearing the output keeps the header', async () => {
  const store = new Store();
  store.set(readyState());
  const { runner } = fakeRunner('msbuild/build-incremental.log', 0);
  const order: string[] = [];
  await runBuild({ ...deps(store, runner, []), write: l => order.push(`write:${l}`), onStarted: () => order.push('started') }, { action: 'Build' });
  expect(order[0]).toBe('started');
  expect(order[1]).toBe('write:Build Engine.sln (Release|x64)');
});

test('each diagnostic is handed out once, without the summary repeats', async () => {
  const store = new Store();
  store.set(readyState());
  const { runner } = fakeRunner('msbuild/rebuild-failed.log', 1);
  const seen: string[] = [];
  await runBuild({ ...deps(store, runner, []), onDiagnostic: e => seen.push(`${e.severity}:${e.text.slice(-20)}`) }, { action: 'Rebuild' });
  expect(seen.filter(s => s.startsWith('error'))).toHaveLength(1);
  expect(seen.filter(s => s.startsWith('warning'))).toHaveLength(1);
});

test('a build requested while the solution loads says so', async () => {
  const store = new Store();
  store.set({ ...initialState, phase: 'loading' });
  const { runner } = fakeRunner('msbuild/build-incremental.log', 0);
  expect(await runBuild(deps(store, runner, []), { action: 'Build' })).toEqual({ started: false, reason: 'The solution is still loading.' });
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
