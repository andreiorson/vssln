import * as path from 'path';
import { expect, test } from 'vitest';
import { CacheEntry, CacheStore } from '../../src/intellisense/cache';
import { EngineDeps, IntelliSenseEngine } from '../../src/intellisense/engine';
import { AppState, ProjectIntelliSense, Store } from '../../src/state/store';
import { loadFixtureState, WORKSPACE } from './helpers';

const GAME = '{11111111-1111-1111-1111-111111111111}';
const MATH = '{22222222-2222-2222-2222-222222222222}';
const RENDER = '{33333333-3333-3333-3333-333333333333}';
const COMMON = path.join(WORKSPACE, 'Common.props');
const rule = '='.repeat(30);
const banner = (p: string) => `<!--\n${rule}\n${p}\n${rule}\n-->`;
const nameOf = (projectPath: string) => path.win32.basename(projectPath, '.vcxproj');

interface Options {
  fail?: string[];
  /** Projects whose MSBuild run waits for release(); `ignoreAbort` lets it finish after an abort. */
  gate?: { project: string; ignoreAbort?: boolean; flag?: string };
  cores?: number;
  state?: (s: AppState) => AppState;
}

async function setup(o: Options = {}, shared?: { files: Map<string, string>; cache: Map<string, CacheEntry> }) {
  const store = new Store();
  const loaded = await loadFixtureState();
  store.set(o.state ? o.state(loaded) : loaded);
  const files = shared?.files ?? new Map<string, string>([[COMMON, 'v1']]);
  for (const p of store.state.solution!.projects) files.set(p.absPath, '<Project/>');
  const cache = shared?.cache ?? new Map<string, CacheEntry>();
  const runs: string[] = [];
  const log: string[] = [];
  let release: () => void = () => {};
  let gated = false;
  let temp = 0;
  const cacheStore: CacheStore = {
    read: async n => cache.get(n),
    write: async (n, e) => void cache.set(n, e),
    remove: async n => void cache.delete(n),
  };
  const deps: EngineDeps = {
    exec: async (_file, args, _env, opts) => {
      const project = args[0];
      const name = nameOf(project);
      const pp = args.find(a => a.startsWith('-preprocess:'));
      runs.push(`${name}:${pp ? 'pp' : 'cl'}`);
      if (pp) {
        files.set(pp.slice('-preprocess:'.length), [banner(project), banner(COMMON)].join('\n'));
        return { code: 0, stdout: '', stderr: '' };
      }
      let flag = name.toUpperCase();
      if (o.gate?.project === name && !gated) {
        gated = true;
        flag = o.gate.flag ?? flag;
        await new Promise<void>((resolve, reject) => {
          release = resolve;
          if (!o.gate!.ignoreAbort) opts?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        });
      }
      if (o.fail?.includes(name)) return { code: 1, stdout: 'Build started.\nerror MSB4019: The imported project was not found.\n', stderr: '' };
      const dir = path.win32.dirname(project);
      return { code: 0, stdout: `  VSSLN|CL|true|${dir}\\a.cpp|/c /D ${flag}\n  VSSLN|IncludePath|C:\\inc\n  VSSLN|ExternalIncludePath|\n`, stderr: '' };
    },
    store: cacheStore,
    read: async p => (files.has(p) ? Buffer.from(files.get(p)!) : undefined),
    exists: async p => files.has(p),
    existsSync: p => files.has(p),
    remove: async p => void files.delete(p),
    tempFile: () => `C:\\tmp\\pp${++temp}.xml`,
    cores: o.cores ?? 4,
    env: {},
    log: line => log.push(line),
    now: () => 0,
  };
  const engine = new IntelliSenseEngine(store, deps, 'C:\\ext\\vssln-intellisense.targets');
  const status = (guid: string) => store.state.intellisense.projects.get(guid);
  return { store, engine, runs, log, files, cache, release: () => release(), status };
}

const done = async (engine: IntelliSenseEngine) => {
  await engine.idle;
  await new Promise(r => setTimeout(r, 0));
};

test('a pass computes every mapped C++ project on disk and nothing else', async () => {
  const h = await setup();
  h.engine.start();
  expect(h.store.state.intellisense.running).toBe(true);
  await done(h.engine);
  expect([...h.store.state.intellisense.projects.keys()].sort()).toEqual([GAME, MATH, RENDER]);
  expect([...h.store.state.intellisense.projects.values()].every(p => p.status === 'ready' && !p.fromCache)).toBe(true);
  expect(h.store.state.intellisense.running).toBe(false);
  expect(h.runs.sort()).toEqual(['Game:cl', 'Game:pp', 'Math:cl', 'Math:pp', 'Render:cl', 'Render:pp']);
  expect(h.engine.dumps().get(MATH)!.records[0].commandLine).toBe('/c /D MATH');
  // The preprocess output is a temporary file.
  expect([...h.files.keys()].some(p => p.startsWith('C:\\tmp\\'))).toBe(false);
  expect(h.log.some(l => /^Math: /.test(l))).toBe(true);
});

test('a second start with nothing changed takes every project from the cache', async () => {
  const first = await setup();
  first.engine.start();
  await done(first.engine);
  const second = await setup({}, { files: first.files, cache: first.cache });
  second.engine.start();
  await done(second.engine);
  expect(second.runs).toEqual([]);
  expect(second.status(GAME)).toMatchObject({ status: 'ready', fromCache: true });
  expect(second.log).toContain('Game: from cache');
});

test('a changed input makes the entries stale', async () => {
  const first = await setup();
  first.engine.start();
  await done(first.engine);
  first.files.set(COMMON, 'v2');
  const second = await setup({}, { files: first.files, cache: first.cache });
  second.engine.start();
  await done(second.engine);
  expect(second.runs.filter(r => r.endsWith(':cl')).sort()).toEqual(['Game:cl', 'Math:cl', 'Render:cl']);
});

test('a failed project keeps the tail of the output and the pass goes on', async () => {
  const h = await setup({ fail: ['Math'] });
  h.engine.start();
  await done(h.engine);
  expect(h.status(MATH)).toMatchObject({ status: 'failed' });
  expect(h.status(MATH)!.message).toContain('error MSB4019');
  expect(h.status(GAME)!.status).toBe('ready');
  expect(h.engine.dumps().has(MATH)).toBe(false);
  expect(h.cache.size).toBe(2);
});

test('a new start cancels the pass: a result of the old pass reaches neither the state nor the cache', async () => {
  const h = await setup({ gate: { project: 'Game', ignoreAbort: true, flag: 'OLD' }, cores: 2 });
  h.engine.start();
  await new Promise(r => setTimeout(r, 0));
  // The new pass waits (paused) while the old run finishes, so nothing can overwrite what the old run leaves.
  h.engine.pause();
  h.engine.start();
  h.release();
  await new Promise(r => setTimeout(r, 10));
  expect(h.engine.dumps().has(GAME)).toBe(false);
  expect(h.cache.size).toBe(0);
  expect(h.status(GAME)!.status).toBe('waiting');
  h.engine.resume();
  await done(h.engine);
  expect(h.engine.dumps().get(GAME)!.records[0].commandLine).toBe('/c /D GAME');
  expect([...h.cache.values()].some(e => e.dump.records[0].commandLine.includes('OLD'))).toBe(false);
  expect(h.status(GAME)!.status).toBe('ready');
});

test('pause gives the machine to a build: the running project waits and finishes after resume', async () => {
  const h = await setup({ gate: { project: 'Game' }, cores: 2 });
  h.engine.start();
  await new Promise(r => setTimeout(r, 0));
  expect(h.status(GAME)!.status).toBe('computing');
  h.engine.pause();
  await new Promise(r => setTimeout(r, 0));
  expect(h.status(GAME)!.status).toBe('waiting');
  expect(h.store.state.intellisense.running).toBe(true);
  h.engine.resume();
  await done(h.engine);
  expect(h.status(GAME)!.status).toBe('ready');
  expect(h.store.state.intellisense.running).toBe(false);
});

test('recompute of one project drops its cache entry and computes only it', async () => {
  const h = await setup();
  h.engine.start();
  await done(h.engine);
  h.runs.length = 0;
  h.engine.recompute(MATH);
  expect(h.status(MATH)!.status).toBe('waiting');
  await done(h.engine);
  expect(h.runs.sort()).toEqual(['Math:cl', 'Math:pp']);
  expect(h.status(MATH)).toMatchObject({ status: 'ready', fromCache: false });
});

test('recompute of everything ignores the cache', async () => {
  const h = await setup();
  h.engine.start();
  await done(h.engine);
  h.runs.length = 0;
  h.engine.recompute();
  await done(h.engine);
  expect(h.runs.filter(r => r.endsWith(':cl'))).toHaveLength(3);
});

test('a changed file re-checks the projects that read it; the others stay untouched', async () => {
  const h = await setup();
  h.engine.start();
  await done(h.engine);
  h.runs.length = 0;
  h.files.set(COMMON, 'v2');
  h.engine.recheck([COMMON.toUpperCase()]);
  await done(h.engine);
  expect(h.runs.filter(r => r.endsWith(':cl'))).toHaveLength(3);
  h.runs.length = 0;
  h.engine.recheck([path.join(WORKSPACE, 'unrelated.props')]);
  await done(h.engine);
  expect(h.runs).toEqual([]);
});

test('projects of open files go first', async () => {
  const h = await setup({ cores: 2 });
  h.engine.prioritize([path.join(WORKSPACE, 'Core', 'Render', 'r.cpp')]);
  h.engine.start();
  await done(h.engine);
  expect(h.runs[0]).toBe('Render:cl');
});

test('states go waiting, computing, ready', async () => {
  const h = await setup();
  const seen: string[] = [];
  h.store.onDidChange(s => {
    const g: ProjectIntelliSense | undefined = s.intellisense.projects.get(GAME);
    if (g && seen.at(-1) !== g.status) seen.push(g.status);
  });
  h.engine.start();
  await done(h.engine);
  expect(seen).toEqual(['waiting', 'computing', 'ready']);
});

test('no toolchain or no solution: nothing runs and the state is empty', async () => {
  const h = await setup({ state: s => ({ ...s, toolchain: undefined }) });
  h.engine.start();
  await done(h.engine);
  expect(h.runs).toEqual([]);
  expect(h.store.state.intellisense).toEqual({ projects: new Map(), running: false });
});
