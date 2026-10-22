import * as fs from 'fs';
import * as path from 'path';
import { loadWorkspace, LoaderDeps } from '../../src/state/loader';
import { AppState } from '../../src/state/store';
import { ToolchainResult } from '../../src/toolchain/vswhere';
import { scanVcxproj, VcxprojScan } from '../../src/solution/projectScan';
import { parseSln } from '../../src/solution/slnParser';

export const fixturesDir = path.join(__dirname, '..', 'fixtures');

export function fixturePath(rel: string): string {
  return path.join(fixturesDir, ...rel.split('/'));
}

export function readFixture(rel: string): string {
  return fs.readFileSync(fixturePath(rel), 'utf8');
}

/** The fixture solution parsed from its real location, with static scans of its C++ projects keyed by guid. */
export function loadSample() {
  const sample = parseSln(readFixture('workspace/Sample.sln'), fixturePath('workspace/Sample.sln'));
  const scans = new Map<string, VcxprojScan | undefined>();
  for (const p of sample.projects.filter(p => p.kind === 'vcxproj')) {
    scans.set(p.guid, fs.existsSync(p.absPath) ? scanVcxproj(fs.readFileSync(p.absPath, 'utf8')) : undefined);
  }
  return { sample, scans };
}

/** In-memory text files keyed by absolute path, shaped like the injected fs of the settings modules. */
export function memoryFs(files: Record<string, string>) {
  return {
    files,
    async readText(p: string): Promise<string | undefined> {
      return files[p];
    },
    async writeText(p: string, text: string): Promise<void> {
      files[p] = text;
    },
  };
}

export const WORKSPACE = fixturePath('workspace');
export const SETTINGS = path.join(WORKSPACE, '.vscode', 'vssln.json');
export const TOOLCHAIN: ToolchainResult = {
  instance: { installationPath: 'C:\\VS', installationVersion: '18.0', displayName: 'VS', msbuildPath: 'C:\\VS\\MSBuild\\Current\\Bin\\MSBuild.exe', devEnvDir: 'C:\\VS\\Common7\\IDE\\' },
};

export function fixtureDeps(opts: { settings?: string; toolchain?: ToolchainResult; solutions?: string[]; folders?: string[]; files?: Record<string, string>; env?: Record<string, string> } = {}): LoaderDeps & { toolchainOpts: unknown[] } {
  const toolchainOpts: unknown[] = [];
  return {
    toolchainOpts,
    folders: opts.folders ?? [WORKSPACE],
    env: opts.env ?? {},
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


/** State loaded from the fixture workspace with a fake toolchain. */
export function loadFixtureState(opts: Parameters<typeof fixtureDeps>[0] = {}): Promise<AppState> {
  return loadWorkspace(fixtureDeps(opts));
}
