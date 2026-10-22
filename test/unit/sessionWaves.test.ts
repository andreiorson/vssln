import * as fs from 'fs';
import * as path from 'path';
import { expect, test } from 'vitest';
import { BuildRunner, Spawn } from '../../src/build/runner';
import { runBuild, SessionDeps } from '../../src/build/session';
import { parseSln } from '../../src/solution/slnParser';
import { AppState, initialState, ProjectEntry, Store } from '../../src/state/store';
import { VsInstance } from '../../src/toolchain/vswhere';

const engine = parseSln(fs.readFileSync(path.join(__dirname, '..', '..', 'samples', 'Engine', 'Engine.sln'), 'utf8'), 'C:\\src\\Engine\\Engine.sln');
const VS: VsInstance = {
  installationPath: 'C:\\VS', installationVersion: '18.0', displayName: 'VS',
  msbuildPath: 'C:\\VS\\MSBuild\\Current\\Bin\\MSBuild.exe', devEnvDir: 'C:\\VS\\Common7\\IDE\\',
};
const byName = (name: string) => engine.projects.find(p => p.name === name)!;
const guid = (name: string) => byName(name).guid;
const refs: Record<string, string[]> = { Render: ['Math'], Game: ['Render', 'Audio', 'Platform', 'Math'], MathTests: ['Math'], Editor: ['Render', 'Math'] };

/** The sample with its .sln dependency (Render on Shaders) and the ProjectReferences of its projects. */
function graphState(over: Partial<AppState> = {}): AppState {
  const projects = new Map<string, ProjectEntry>(engine.projects.map(p => [p.guid, p.name === 'Missing' ? { exists: false } : {
    exists: true,
    items: { items: [], filters: [], references: (refs[p.name] ?? []).map(r => byName(r).absPath) },
  }]));
  return {
    ...initialState,
    phase: 'ready',
    folder: 'C:\\src\\Engine',
    solutions: [engine.path],
    solution: engine,
    configuration: engine.configurations.find(c => c.name === 'Release|x64'),
    projects,
    toolchain: VS,
    settings: {},
    ...over,
  };
}

function deps(store: Store, runner: BuildRunner, written: string[], files: Map<string, string>): SessionDeps {
  let t = 0;
  return {
    store, runner, now: () => (t += 1000), logDir: 'C:\\logs', env: {}, write: l => written.push(l),
    writeFile: async (p, text) => void files.set(p, text),
  };
}

/** Each MSBuild run builds the projects of its solution filter; the named ones fail. A held run waits for release(). */
function waveRunner(files: Map<string, string>, failing: string[] = [], holdRun?: number) {
  const spawned: string[][] = [];
  let release = () => {};
  const spawn: Spawn = (_file, args) => {
    spawned.push(args);
    const run = spawned.length;
    let lineCb: (l: string) => void = () => {};
    let exitCb: (c: number | null) => void = () => {};
    const play = () => {
      let failed = false;
      const filter = files.get(args[0]);
      const rels: string[] = filter ? JSON.parse(filter).solution.projects : [];
      rels.forEach((rel, i) => {
        const p = engine.projects.find(x => x.relPath === rel)!;
        const id = i + 2;
        lineCb(`     1>Project "${args[0]}" (1) is building "${p.absPath}" (${id}) on node 1 (default targets).`);
        lineCb(`         ${p.name.toLowerCase()}.cpp`);
        if (failing.includes(p.name)) {
          failed = true;
          lineCb(`     ${id}>${path.win32.dirname(p.absPath)}\\x.cpp(1,1): error C1189: #error: boom [${p.absPath}]`);
          lineCb(`     ${id}>Done Building Project "${p.absPath}" (default targets) -- FAILED.`);
        } else {
          lineCb(`     ${id}>Done Building Project "${p.absPath}" (default targets).`);
        }
      });
      lineCb('');
      lineCb(failed ? 'Build FAILED.' : 'Build succeeded.');
      lineCb('    0 Warning(s)');
      lineCb('Time Elapsed 00:00:01.00');
      exitCb(failed ? 1 : 0);
    };
    if (run === holdRun) release = play;
    else setImmediate(play);
    return { pid: run, onLine: cb => (lineCb = cb), onError: () => {}, onExit: cb => (exitCb = cb) };
  };
  return { runner: new BuildRunner(spawn, async () => release()), spawned, release: () => release() };
}

const names = (rels: string[]) => rels.map(rel => engine.projects.find(p => p.relPath === rel)!.name);
const filterOf = (files: Map<string, string>, args: string[]) => names(JSON.parse(files.get(args[0])!).solution.projects);
const appends = (args: string[]) => args.some(a => a.startsWith('-flp:') && a.endsWith(';Append'));

test('Build runs one MSBuild per wave on solution filters, dependencies first', async () => {
  const store = new Store();
  store.set(graphState());
  const files = new Map<string, string>();
  const { runner, spawned } = waveRunner(files);
  await runBuild(deps(store, runner, [], files), { action: 'Build' });
  expect(spawned.map(a => a[0])).toEqual(['C:\\logs\\wave-1.slnf', 'C:\\logs\\wave-2.slnf', 'C:\\logs\\wave-3.slnf']);
  expect(filterOf(files, spawned[0])).toEqual(expect.arrayContaining(['Math', 'Audio', 'Platform', 'Shaders']));
  expect(filterOf(files, spawned[0])).not.toContain('Render');
  expect(filterOf(files, spawned[1])).toEqual(expect.arrayContaining(['Render', 'MathTests']));
  expect(filterOf(files, spawned[2])).toEqual(expect.arrayContaining(['Game', 'Editor']));
  expect(JSON.parse(files.get('C:\\logs\\wave-1.slnf')!).solution.path).toBe(engine.path);
  expect(spawned.every(a => a.includes('-t:Build'))).toBe(true);
  // The later waves do not build their references again; the file log is appended to after the first run.
  expect(spawned[1]).toContain('-p:BuildProjectReferences=false');
  expect(spawned[2]).toContain('-p:BuildProjectReferences=false');
  expect(appends(spawned[0])).toBe(false);
  expect(appends(spawned[2])).toBe(true);
  expect(store.state.build.status).toBe('succeeded');
  expect(store.state.build.projects.get(guid('Game'))!.status).toBe('succeeded');
});

test('project numbers go on across waves and one summary ends the build', async () => {
  const store = new Store();
  store.set(graphState());
  const files = new Map<string, string>();
  const { runner } = waveRunner(files);
  const written: string[] = [];
  await runBuild(deps(store, runner, written, files), { action: 'Build' });
  const headers = written.filter(l => /^\d+>------ Build started/.test(l)).map(l => Number(l.split('>')[0]));
  expect(headers.length).toBeGreaterThan(5);
  expect(headers).toEqual(headers.map((_, i) => i + 1));
  expect(written.filter(l => l === 'Build succeeded.')).toHaveLength(1);
  expect(written.filter(l => l.startsWith('Time Elapsed'))).toHaveLength(1);
  expect(written).toContainEqual(expect.stringMatching(/^Wave 2\/3: /));
});

test('a failed project skips what depends on it; the rest is built', async () => {
  const store = new Store();
  store.set(graphState());
  const files = new Map<string, string>();
  const { runner, spawned } = waveRunner(files, ['Math']);
  const written: string[] = [];
  await runBuild(deps(store, runner, written, files), { action: 'Build' });
  const b = store.state.build;
  expect(b.status).toBe('failed');
  for (const name of ['Render', 'MathTests', 'Game', 'Editor']) {
    expect(b.projects.get(guid(name))).toMatchObject({ status: 'skipped', messages: ['Math failed'] });
  }
  // Every later project depends on Math, so no later wave runs.
  expect(spawned).toHaveLength(1);
  expect(b.projects.get(guid('Audio'))!.status).toBe('succeeded');
  expect(written).toContainEqual(expect.stringMatching(/^Not built because Math failed: /));
  expect(written.filter(l => l === 'Build FAILED.')).toHaveLength(1);
});

test('Stop during a wave starts no later wave', async () => {
  const store = new Store();
  store.set(graphState());
  const files = new Map<string, string>();
  const { runner, spawned } = waveRunner(files, [], 2);
  const build = runBuild(deps(store, runner, [], files), { action: 'Build' });
  await new Promise(r => setTimeout(r, 20));
  expect(spawned).toHaveLength(2);
  await runner.stop();
  await build;
  expect(spawned).toHaveLength(2);
  expect(store.state.build.status).toBe('cancelled');
});

test('Rebuild cleans everything once, then builds in waves; Clean is one run', async () => {
  const store = new Store();
  store.set(graphState());
  const files = new Map<string, string>();
  const { runner, spawned } = waveRunner(files);
  await runBuild(deps(store, runner, [], files), { action: 'Rebuild' });
  expect(spawned[0][0]).toBe(engine.path);
  expect(spawned[0]).toContain('-t:Clean');
  expect(spawned.slice(1).map(a => a[0])).toEqual(['C:\\logs\\wave-1.slnf', 'C:\\logs\\wave-2.slnf', 'C:\\logs\\wave-3.slnf']);
  expect(appends(spawned[1])).toBe(true);
  expect(store.state.build.status).toBe('succeeded');

  const clean = waveRunner(files);
  await runBuild(deps(store, clean.runner, [], files), { action: 'Clean' });
  expect(clean.spawned.map(a => [a[0], a[1]])).toEqual([[engine.path, '-t:Clean']]);
});

test('a project build takes its dependencies in waves', async () => {
  const store = new Store();
  store.set(graphState());
  const files = new Map<string, string>();
  const { runner, spawned } = waveRunner(files);
  await runBuild(deps(store, runner, [], files), { action: 'Build', project: byName('Render') });
  expect(spawned.map(a => filterOf(files, a))).toEqual([['Math', 'Shaders'], ['Render']]);
});

test('a dependency cycle builds the solution in one run and says why', async () => {
  const store = new Store();
  const cyclic = { ...engine, projects: engine.projects.map(p => (p.name === 'Shaders' ? { ...p, dependencies: [guid('Render').toUpperCase()] } : p)) };
  store.set(graphState({ solution: cyclic }));
  const files = new Map<string, string>();
  const { runner, spawned } = waveRunner(files);
  const written: string[] = [];
  await runBuild(deps(store, runner, written, files), { action: 'Build' });
  expect(spawned.map(a => [a[0], a[1]])).toEqual([[engine.path, '-t:Build']]);
  expect(written).toContainEqual('The project dependencies form a cycle (Render → Shaders → Render); building the solution in one run.');
});
