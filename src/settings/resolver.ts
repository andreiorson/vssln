import * as path from 'path';
import { typeFor, VcxprojScan } from '../solution/projectScan';
import { ParsedSolution, projectConfigFor, SlnProject, SolutionConfig } from '../solution/slnParser';
import { samePath } from '../util/paths';
import { VsslnSettings } from './settings';

export interface VariableContext {
  workspaceFolder: string;
  solutionDir?: string;
  projectDir?: string;
  targetPath?: string;
  configuration?: string;
  platform?: string;
  env: Record<string, string | undefined>;
}

const CONTEXT_VARIABLES = ['workspaceFolder', 'solutionDir', 'projectDir', 'targetPath', 'configuration', 'platform'] as const;

/** Environment variable names are case-insensitive on Windows. */
function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find(k => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

/** Expands ${name} and ${env:NAME}; unknown or unset context variables stay literal and are listed. */
export function expandVariables(value: string, ctx: VariableContext): { value: string; unknown: string[] } {
  const unknown: string[] = [];
  const expanded = value.replace(/\$\{([^}]+)\}/g, (whole, name: string) => {
    if (name.startsWith('env:')) return envValue(ctx.env, name.slice(4)) ?? '';
    const known = (CONTEXT_VARIABLES as readonly string[]).includes(name)
      ? ctx[name as (typeof CONTEXT_VARIABLES)[number]]
      : undefined;
    if (known !== undefined) return known;
    unknown.push(name);
    return whole;
  });
  return { value: expanded, unknown };
}

export type Source = 'settings' | 'default';

export interface Resolved<T> {
  value?: T;
  source: Source;
  problem?: string;
}

function depth(folder: string, p: string): number {
  return path.win32.relative(folder, p).split(/[\\/]/).length - 1;
}

/** The shallowest solution under the folder, ties broken alphabetically. */
export function defaultSolution(folder: string, discovered: string[]): string | undefined {
  return [...discovered].sort((a, b) =>
    depth(folder, a) - depth(folder, b) || a.localeCompare(b, undefined, { sensitivity: 'base' }))[0];
}

/** A path from the settings file: variables expanded, then resolved against the workspace folder. */
export function settingsPath(value: string, folder: string, env: Record<string, string | undefined>): string {
  return path.win32.resolve(folder, expandVariables(value, { workspaceFolder: folder, env }).value);
}

export function resolveSolutionPath(
  settings: VsslnSettings,
  folder: string,
  discovered: string[],
  env: Record<string, string | undefined> = {},
): Resolved<string> {
  if (settings.solution !== undefined) {
    const wanted = settingsPath(settings.solution, folder, env);
    const found = discovered.find(p => samePath(p, wanted));
    if (found) return { value: found, source: 'settings' };
    const fallback = defaultSolution(folder, discovered);
    return {
      ...(fallback !== undefined ? { value: fallback } : {}),
      source: 'default',
      problem: `Solution "${settings.solution}" from vssln.json was not found; using ${fallback ? `"${path.win32.basename(fallback)}"` : 'none'}.`,
    };
  }
  const fallback = defaultSolution(folder, discovered);
  return fallback !== undefined ? { value: fallback, source: 'default' } : { source: 'default' };
}

function defaultConfiguration(sln: ParsedSolution): SolutionConfig | undefined {
  return sln.configurations.find(c => c.name === 'Release|x64') ?? sln.configurations[0];
}

export function resolveConfiguration(settings: VsslnSettings, sln: ParsedSolution): Resolved<SolutionConfig> {
  const fallback = defaultConfiguration(sln);
  const withValue = (r: Resolved<SolutionConfig>) => (fallback ? { value: fallback, ...r } : r);
  if (settings.configuration !== undefined) {
    const found = sln.configurations.find(c => c.name.toLowerCase() === settings.configuration!.toLowerCase());
    if (found) return { value: found, source: 'settings' };
    return withValue({
      source: 'default',
      problem: `Configuration "${settings.configuration}" from vssln.json is not in the solution; using "${fallback?.name ?? 'none'}".`,
    });
  }
  return withValue({ source: 'default' });
}

/** First C++ project in .sln order whose type in the given solution configuration is Application. */
export function defaultStartupProject(sln: ParsedSolution, config: SolutionConfig, scans: Map<string, VcxprojScan | undefined>): SlnProject | undefined {
  return [...sln.projects]
    .filter(p => p.kind === 'vcxproj')
    .sort((a, b) => a.order - b.order)
    .find(p => {
      const mapping = projectConfigFor(sln, p.guid, config.name);
      return mapping !== undefined && typeFor(scans.get(p.guid), `${mapping.configuration}|${mapping.platform}`) === 'Application';
    });
}

export function resolveStartupProject(
  settings: VsslnSettings,
  sln: ParsedSolution,
  config: SolutionConfig,
  scans: Map<string, VcxprojScan | undefined>,
): Resolved<SlnProject> {
  const fallback = () => defaultStartupProject(sln, config, scans);
  if (settings.startupProject !== undefined) {
    const wanted = settings.startupProject.toLowerCase();
    const found = sln.projects.find(p => p.kind === 'vcxproj' && p.name.toLowerCase() === wanted);
    if (found) return { value: found, source: 'settings' };
    const other = fallback();
    return {
      ...(other ? { value: other } : {}),
      source: 'default',
      problem: `Startup project "${settings.startupProject}" from vssln.json is not a C++ project of the solution; using ${other ? `"${other.name}"` : 'none'}.`,
    };
  }
  const other = fallback();
  return other ? { value: other, source: 'default' } : { source: 'default' };
}
