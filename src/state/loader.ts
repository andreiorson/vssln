import * as path from 'path';
import { resolveConfiguration, resolveSolutionPath, resolveStartupProject } from '../settings/resolver';
import { ParsedSettings, parseSettings } from '../settings/settings';
import { scanVcxproj, VcxprojScan } from '../solution/projectScan';
import { parseSln } from '../solution/slnParser';
import { ToolchainOptions, ToolchainResult } from '../toolchain/vswhere';
import { folderOf } from '../util/paths';
import { AppState, initialState, Problem, ProjectEntry } from './store';

export interface LoaderDeps {
  folders: string[];
  /** Absolute paths of the .sln files in all folders. */
  findSolutions(): Promise<string[]>;
  readText(p: string): Promise<string | undefined>;
  exists(p: string): Promise<boolean>;
  findToolchain(opts: ToolchainOptions): Promise<ToolchainResult>;
}

interface FolderSettings {
  folder: string;
  parsed: ParsedSettings;
}

/** Shallowest solution relative to its own workspace folder, then alphabetical across all folders. */
function workspaceDefault(folders: string[], solutions: string[]): string | undefined {
  const candidates = solutions.map(s => {
    const folder = folderOf(folders, s) ?? path.win32.dirname(s);
    return { s, depth: path.win32.relative(folder, s).split(/[\\/]/).length - 1 };
  });
  const best = Math.min(...candidates.map(c => c.depth));
  return candidates
    .filter(c => c.depth === best)
    .map(c => c.s)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))[0];
}

function settingsProblems(parsed: ParsedSettings): Problem[] {
  return parsed.problems.map(message => ({ severity: parsed.syntaxOk ? 'warning' : 'error', message, action: 'openSettings' }));
}

async function readSettings(deps: LoaderDeps, folder: string): Promise<FolderSettings> {
  const text = await deps.readText(path.win32.join(folder, '.vscode', 'vssln.json'));
  return { folder, parsed: parseSettings(text ?? '') };
}

async function scanProjects(deps: LoaderDeps, absPaths: Map<string, string>): Promise<Map<string, ProjectEntry>> {
  const entries = await Promise.all(
    [...absPaths].map(async ([guid, absPath]): Promise<[string, ProjectEntry]> => {
      const text = (await deps.exists(absPath)) ? await deps.readText(absPath) : undefined;
      return [guid, text === undefined ? { exists: false } : { exists: true, scan: scanVcxproj(text) }];
    }),
  );
  return new Map(entries);
}

/** Builds the whole application state from the workspace. Never throws for missing or broken inputs. */
export async function loadWorkspace(deps: LoaderDeps): Promise<AppState> {
  const solutions = await deps.findSolutions();
  const perFolder = await Promise.all(deps.folders.map(f => readSettings(deps, f)));

  let chosen: FolderSettings | undefined;
  let solutionPath: string | undefined;
  const problems: Problem[] = [];

  for (const entry of perFolder) {
    const r = resolveSolutionPath(entry.parsed.settings, entry.folder, solutions);
    if (r.source === 'settings') {
      chosen = entry;
      solutionPath = r.value;
      break;
    }
  }
  if (!chosen) {
    solutionPath = workspaceDefault(deps.folders, solutions);
    const folder = (solutionPath && folderOf(deps.folders, solutionPath)) ?? deps.folders[0];
    chosen = perFolder.find(e => e.folder === folder) ?? { folder, parsed: parseSettings('') };
    const stale = resolveSolutionPath(chosen.parsed.settings, chosen.folder, solutions).problem;
    if (stale) problems.push({ severity: 'warning', message: stale, action: 'openSettings' });
  }

  const { settings, syntaxOk } = chosen.parsed;
  problems.unshift(...settingsProblems(chosen.parsed));
  const base: AppState = { ...initialState, folder: chosen.folder, solutions, settings, settingsSyntaxOk: syntaxOk, problems };

  const slnText = solutionPath ? await deps.readText(solutionPath) : undefined;
  if (!solutionPath || slnText === undefined) return { ...base, phase: 'noSolution' };

  const solution = parseSln(slnText, solutionPath);
  const configuration = resolveConfiguration(settings, solution);
  if (configuration.problem) problems.push({ severity: 'warning', message: configuration.problem, action: 'openSettings' });

  const cppPaths = new Map(solution.projects.filter(p => p.kind === 'vcxproj').map(p => [p.guid, p.absPath]));
  const [projects, toolchain] = await Promise.all([
    scanProjects(deps, cppPaths),
    deps.findToolchain({
      ...(settings.toolchain?.vsVersion !== undefined ? { vsVersion: settings.toolchain.vsVersion } : {}),
      ...(settings.toolchain?.msbuildPath !== undefined ? { msbuildPath: settings.toolchain.msbuildPath } : {}),
    }),
  ]);

  let startupProjectGuid: string | undefined;
  if (configuration.value) {
    const scans = new Map<string, VcxprojScan | undefined>([...projects].map(([guid, e]) => [guid, e.scan]));
    const startup = resolveStartupProject(settings, solution, configuration.value, scans);
    if (startup.problem) problems.push({ severity: 'warning', message: startup.problem, action: 'openSettings' });
    startupProjectGuid = startup.value?.guid;
  }

  if (toolchain.problem) {
    problems.push({ severity: toolchain.instance ? 'warning' : 'error', message: toolchain.problem, action: 'configureToolchain' });
  }

  return {
    ...base,
    phase: 'ready',
    solution,
    configuration: configuration.value,
    startupProjectGuid,
    projects,
    toolchain: toolchain.instance,
  };
}
