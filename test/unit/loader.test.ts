import * as fs from 'fs';
import * as path from 'path';
import { expect, test } from 'vitest';
import { loadWorkspace, LoaderDeps } from '../../src/state/loader';
import { ToolchainResult } from '../../src/toolchain/vswhere';
import { fixturePath, readFixture } from './helpers';

const WORKSPACE = fixturePath('workspace');
const SETTINGS = path.join(WORKSPACE, '.vscode', 'vssln.json');
const TOOLCHAIN: ToolchainResult = {
  instance: { installationPath: 'C:\\VS', installationVersion: '18.0', displayName: 'VS', msbuildPath: 'C:\\VS\\MSBuild\\Current\\Bin\\MSBuild.exe', devEnvDir: 'C:\\VS\\Common7\\IDE\\' },
};

function fixtureDeps(opts: { settings?: string; toolchain?: ToolchainResult; solutions?: string[]; folders?: string[]; files?: Record<string, string> } = {}): LoaderDeps & { toolchainOpts: unknown[] } {
  const toolchainOpts: unknown[] = [];
  return {
    toolchainOpts,
    folders: opts.folders ?? [WORKSPACE],
    async findSolutions() {
      return opts.solutions ?? [path.join(WORKSPACE, 'Sample.sln')];
    },
    async readText(p) {
      if (opts.files && p in opts.files) return opts.files[p];
      if (p === SETTINGS) return opts.settings;
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : undefined;
    },
    async exists(p) {
      return (opts.files !== undefined && p in opts.files) || fs.existsSync(p);
    },
    async findToolchain(o) {
      toolchainOpts.push(o);
      return opts.toolchain ?? TOOLCHAIN;
    },
  };
}

test('no .sln: phase noSolution, no throw', async () => {
  const s = await loadWorkspace(fixtureDeps({ solutions: [] }));
  expect(s.phase).toBe('noSolution');
  expect(s.folder).toBe(WORKSPACE);
});

test('loads the fixture workspace with defaults', async () => {
  const s = await loadWorkspace(fixtureDeps());
  expect(s.phase).toBe('ready');
  expect(s.folder).toBe(WORKSPACE);
  expect(s.solutions).toEqual([path.join(WORKSPACE, 'Sample.sln')]);
  expect(s.configuration!.name).toBe('Release|x64');
  expect(s.solution!.projects.find(p => p.guid === s.startupProjectGuid)!.name).toBe('Game');
  expect(s.projects.get('{66666666-6666-6666-6666-666666666666}')).toEqual({ exists: false });
  expect(s.projects.get('{11111111-1111-1111-1111-111111111111}')!.scan!.sources).toBe(2);
  expect(s.projects.has('{55555555-5555-5555-5555-555555555555}')).toBe(false);
  expect(s.toolchain).toEqual(TOOLCHAIN.instance);
  expect(s.problems).toEqual([]);
  expect(s.settingsSyntaxOk).toBe(true);
});

test('toolchain options come from the settings file', async () => {
  const deps = fixtureDeps({ settings: '{"toolchain": {"vsVersion": "[16,17)"}}' });
  await loadWorkspace(deps);
  expect(deps.toolchainOpts).toEqual([{ vsVersion: '[16,17)' }]);
});

test('missing toolchain still loads the tree and reports an actionable error', async () => {
  const s = await loadWorkspace(fixtureDeps({ toolchain: { problem: 'vswhere.exe not found' } }));
  expect(s.phase).toBe('ready');
  expect(s.solution!.projects).toHaveLength(6);
  expect(s.toolchain).toBeUndefined();
  expect(s.problems).toContainEqual({ severity: 'error', message: 'vswhere.exe not found', action: 'configureToolchain' });
});

test('stale settings produce warnings and keep settingsSyntaxOk', async () => {
  const s = await loadWorkspace(fixtureDeps({ settings: '{"configuration": "Profile|x64", "startupProject": "Gone"}' }));
  expect(s.configuration!.name).toBe('Release|x64');
  expect(s.solution!.projects.find(p => p.guid === s.startupProjectGuid)!.name).toBe('Game');
  expect(s.settingsSyntaxOk).toBe(true);
  expect(s.problems).toHaveLength(2);
  expect(s.problems.every(p => p.severity === 'warning' && p.action === 'openSettings')).toBe(true);
});

test('broken settings file: defaults, settingsSyntaxOk false, error problem', async () => {
  const s = await loadWorkspace(fixtureDeps({ settings: readFixture('settings/broken.json') }));
  expect(s.phase).toBe('ready');
  expect(s.configuration!.name).toBe('Release|x64');
  expect(s.settingsSyntaxOk).toBe(false);
  expect(s.problems).toHaveLength(1);
  expect(s.problems[0]).toMatchObject({ severity: 'error', action: 'openSettings' });
});

test('settings choose the solution and configuration', async () => {
  const other = path.join(WORKSPACE, 'nested', 'Other.sln');
  const s = await loadWorkspace(fixtureDeps({
    solutions: [path.join(WORKSPACE, 'Sample.sln'), other],
    files: { [other]: readFixture('sln/dotted-config.sln') },
    settings: '{"solution": "nested/Other.sln", "configuration": "Debug|x64"}',
  }));
  expect(s.solution!.path).toBe(other);
  expect(s.configuration!.name).toBe('Debug|x64');
});

test('multi-root default does not depend on the process working directory', async () => {
  const near = path.join(process.cwd(), 'x', 'Y.sln');
  const far = 'C:\\a\\B.sln';
  const s = await loadWorkspace(fixtureDeps({
    folders: [path.join(process.cwd(), 'x'), 'C:\\a'],
    solutions: [near, far],
    files: { [near]: readFixture('sln/dotted-config.sln'), [far]: readFixture('sln/dotted-config.sln') },
  }));
  expect(s.solution!.path).toBe(far);
});

test('multi-root: the folder of the default solution supplies the settings', async () => {
  const second = 'C:\\second';
  const secondSln = 'C:\\second\\A.sln';
  const s = await loadWorkspace(fixtureDeps({
    folders: [second, WORKSPACE],
    solutions: [secondSln, path.join(WORKSPACE, 'Sample.sln')],
    files: { [secondSln]: readFixture('sln/dotted-config.sln'), 'C:\\second\\.vscode\\vssln.json': '{"configuration": "Debug|x64"}' },
  }));
  expect(s.folder).toBe(second);
  expect(s.solution!.path).toBe(secondSln);
  expect(s.configuration!.name).toBe('Debug|x64');
});
