import { expect, test } from 'vitest';
import { findToolchain, ToolchainDeps } from '../../src/toolchain/vswhere';
import { readFixture } from './helpers';

const PF86 = 'C:\\Program Files (x86)';
const VSWHERE = 'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe';
const VS = 'C:\\VS\\2019\\Professional';

function fakeDeps(opts: { vswhere?: string; existing?: string[]; programFilesX86?: string | null }) {
  const calls: { file: string; args: string[] }[] = [];
  const existing = new Set([VSWHERE, ...(opts.existing ?? [])]);
  if (opts.existing && !opts.existing.includes(VSWHERE) && opts.vswhere === undefined) existing.delete(VSWHERE);
  const deps: ToolchainDeps & { calls: typeof calls } = {
    calls,
    programFilesX86: opts.programFilesX86 === null ? undefined : (opts.programFilesX86 ?? PF86),
    async exists(p) {
      return existing.has(p);
    },
    async exec(file, args) {
      calls.push({ file, args });
      return { code: 0, stdout: readFixture(`vswhere/${opts.vswhere ?? 'vs2019.json'}`), stderr: '' };
    },
  };
  return deps;
}

const CURRENT = `${VS}\\MSBuild\\Current\\Bin\\MSBuild.exe`;

test('calls vswhere with -latest by default and derives paths', async () => {
  const deps = fakeDeps({ vswhere: 'vs2019.json', existing: [CURRENT] });
  const r = await findToolchain({}, deps);
  expect(deps.calls[0]).toEqual({
    file: VSWHERE,
    args: ['-latest', '-products', '*', '-requires', 'Microsoft.Component.MSBuild', '-format', 'json', '-utf8'],
  });
  expect(r).toEqual({
    instance: {
      installationPath: VS,
      installationVersion: '16.11.34',
      displayName: 'Visual Studio Professional 2019',
      msbuildPath: CURRENT,
      devEnvDir: `${VS}\\Common7\\IDE\\`,
    },
  });
});

test('version range is passed as -version', async () => {
  const deps = fakeDeps({ vswhere: 'vs2019.json', existing: [CURRENT] });
  await findToolchain({ vsVersion: '[16,17)' }, deps);
  expect(deps.calls[0].args).toEqual(['-latest', '-version', '[16,17)', '-products', '*', '-requires', 'Microsoft.Component.MSBuild', '-format', 'json', '-utf8']);
});

test('vsVersion "latest" is the same as omitted', async () => {
  const deps = fakeDeps({ vswhere: 'vs2019.json', existing: [CURRENT] });
  await findToolchain({ vsVersion: 'latest' }, deps);
  expect(deps.calls[0].args).not.toContain('-version');
});

test('falls back to MSBuild\\15.0\\Bin when Current is absent', async () => {
  const old = `${VS}\\MSBuild\\15.0\\Bin\\MSBuild.exe`;
  const r = await findToolchain({}, fakeDeps({ vswhere: 'vs2019.json', existing: [old] }));
  expect(r.instance!.msbuildPath).toBe(old);
});

test('instance without MSBuild.exe is a problem', async () => {
  const r = await findToolchain({}, fakeDeps({ vswhere: 'vs2019.json', existing: [] }));
  expect(r.instance).toBeUndefined();
  expect(r.problem).toMatch(/MSBuild\.exe/);
});

test('explicit msbuildPath wins and derives devEnvDir', async () => {
  const deps = fakeDeps({ existing: ['E:\\VS\\MSBuild\\Current\\Bin\\MSBuild.exe'] });
  const r = await findToolchain({ msbuildPath: 'E:\\VS\\MSBuild\\Current\\Bin\\MSBuild.exe' }, deps);
  expect(r.problem).toBeUndefined();
  expect(r.instance!.msbuildPath).toBe('E:\\VS\\MSBuild\\Current\\Bin\\MSBuild.exe');
  expect(r.instance!.devEnvDir).toBe('E:\\VS\\Common7\\IDE\\');
  expect(deps.calls).toEqual([]);
});

test('explicit msbuildPath outside a VS layout: devEnvDir empty and a problem', async () => {
  const r = await findToolchain({ msbuildPath: 'E:\\tools\\MSBuild.exe' }, fakeDeps({ existing: ['E:\\tools\\MSBuild.exe'] }));
  expect(r.instance!.devEnvDir).toBe('');
  expect(r.problem).toMatch(/DevEnvDir/);
});

test('explicit msbuildPath that does not exist is a problem', async () => {
  const r = await findToolchain({ msbuildPath: 'E:\\nope\\MSBuild.exe' }, fakeDeps({ existing: [] }));
  expect(r.instance).toBeUndefined();
  expect(r.problem).toContain('E:\\nope\\MSBuild.exe');
});

test('missing vswhere.exe is a problem, not a throw', async () => {
  const deps = fakeDeps({ existing: [] });
  const r = await findToolchain({}, deps);
  expect(r.instance).toBeUndefined();
  expect(r.problem).toMatch(/vswhere/);
  expect(deps.calls).toEqual([]);
});

test('unknown Program Files (x86) is a problem', async () => {
  const r = await findToolchain({}, fakeDeps({ programFilesX86: null }));
  expect(r.problem).toMatch(/vswhere/);
});

test('no instance in range is a problem naming the range', async () => {
  const r = await findToolchain({ vsVersion: '[18,19)' }, fakeDeps({ vswhere: 'empty.json' }));
  expect(r.instance).toBeUndefined();
  expect(r.problem).toContain('[18,19)');
});

test('vswhere failure or garbage output is a problem', async () => {
  const deps = fakeDeps({});
  deps.exec = async () => ({ code: 1, stdout: 'not json', stderr: 'boom' });
  expect((await findToolchain({}, deps)).problem).toMatch(/vswhere/);
});
