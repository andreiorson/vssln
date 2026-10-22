import * as path from 'path';
import { beforeAll, expect, test } from 'vitest';
import { ProjectDump } from '../../src/intellisense/dump';
import { FileIndex } from '../../src/intellisense/fileIndex';
import { AppState } from '../../src/state/store';
import { loadFixtureState, WORKSPACE } from './helpers';

const GAME = '{11111111-1111-1111-1111-111111111111}';
const MATH = '{22222222-2222-2222-2222-222222222222}';
const game = (...p: string[]) => path.join(WORKSPACE, 'Game', ...p);
const math = (...p: string[]) => path.join(WORKSPACE, 'Core', 'Math', ...p);
let s: AppState;

beforeAll(async () => {
  s = await loadFixtureState();
});

const gameDump: ProjectDump = {
  records: [
    { files: [game('main.cpp')], commandLine: '/c /I C:\\own /D MAIN', projectDefault: false },
    { files: [game('src', 'game.cpp')], commandLine: '/c /I C:\\default /D GAME', projectDefault: true },
  ],
  systemIncludes: ['C:\\VC\\include'],
};
const mathDump: ProjectDump = { records: [{ files: [math('vector.cpp')], commandLine: '/D MATH', projectDefault: true }], systemIncludes: [] };
const dumps = new Map([[GAME, gameDump], [MATH, mathDump]]);

test('a source in a record gets that record, with the system includes and the project platform', () => {
  const c = new FileIndex(s).configurationFor(game('main.cpp'), dumps)!;
  expect(c).toEqual({ includePath: ['C:\\own', 'C:\\VC\\include'], defines: ['MAIN'], forcedInclude: [], standard: 'c++14', intelliSenseMode: 'windows-msvc-x64' });
});

test('a header of the project gets the project default; lookups ignore case and separators', () => {
  const index = new FileIndex(s);
  expect(index.projectFor(game('src', 'game.h'))).toBe(GAME);
  expect(index.configurationFor(game('src', 'game.h').toUpperCase().replace(/\\/g, '/'), dumps)!.defines).toEqual(['GAME']);
});

test('a file listed by two projects: the startup project first, otherwise solution order', () => {
  const shared = (startup: string | undefined): AppState => {
    const projects = new Map(s.projects);
    const m = projects.get(MATH)!;
    projects.set(MATH, { ...m, items: { ...m.items!, items: [...m.items!.items, { itemType: 'ClCompile', include: 'x', path: game('main.cpp') }] } });
    return { ...s, projects, startupProjectGuid: startup };
  };
  expect(new FileIndex(shared(MATH)).projectFor(game('main.cpp'))).toBe(MATH);
  expect(new FileIndex(shared(undefined)).projectFor(game('main.cpp'))).toBe(GAME);
  // While the first project has no data yet, the next one that has answers.
  expect(new FileIndex(shared(GAME)).configurationFor(game('main.cpp'), new Map([[MATH, mathDump]]))!.defines).toEqual(['MATH']);
});

test('a file in no project but inside a project folder gets the nearest project default; elsewhere nothing', () => {
  const index = new FileIndex(s);
  expect(index.projectFor(math('detail', 'simd.h'))).toBe(MATH);
  expect(index.configurationFor(math('detail', 'simd.h'), dumps)!.defines).toEqual(['MATH']);
  expect(index.projectFor(path.join(WORKSPACE, 'README.md'))).toBeUndefined();
  expect(index.configurationFor(path.join(WORKSPACE, 'README.md'), dumps)).toBeUndefined();
});

test('a header in no project and no project folder takes a project whose include directories hold it, startup first', () => {
  const inc = path.join(WORKSPACE, 'Core', 'include');
  const header = path.join(inc, 'engine', 'render.h');
  const withInc = (dump: ProjectDump, define: string): ProjectDump => ({ ...dump, records: [{ files: [], commandLine: `/I "${inc}" /D ${define}`, projectDefault: true }] });
  const both = new Map([[GAME, withInc(gameDump, 'FROM_GAME')], [MATH, withInc(mathDump, 'FROM_MATH')]]);
  expect(new FileIndex(s).configurationFor(header, both)!.defines).toEqual(['FROM_GAME']);
  expect(new FileIndex({ ...s, startupProjectGuid: MATH }).configurationFor(header, both)!.defines).toEqual(['FROM_MATH']);
  // System include directories do not count: every project has them.
  expect(new FileIndex(s).configurationFor('C:\\VC\\include\\vector', new Map([[GAME, gameDump]]))).toBeUndefined();
});

test('no answer for a project without data', () => {
  expect(new FileIndex(s).configurationFor(game('main.cpp'), new Map())).toBeUndefined();
});

test('100 000 listed files are indexed quickly', () => {
  const projects = new Map(s.projects);
  const g = projects.get(GAME)!;
  const items = Array.from({ length: 100000 }, (_, i) => ({ itemType: 'ClCompile', include: `f${i}.cpp`, path: game('gen', `f${i}.cpp`) }));
  projects.set(GAME, { ...g, items: { filters: [], items } });
  const start = Date.now();
  const index = new FileIndex({ ...s, projects });
  expect(index.projectFor(game('gen', 'f99999.cpp'))).toBe(GAME);
  expect(Date.now() - start).toBeLessThan(1000);
});
