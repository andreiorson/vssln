import { expandVariables, VariableContext } from '../settings/resolver';
import { DebugSettings, VsslnSettings } from '../settings/settings';
import { SlnProject, SolutionConfig } from '../solution/slnParser';
import { samePath } from '../util/paths';
import { applyEnvironmentLines, splitCommandLine } from './commandLine';
import { DebugProperties } from './properties';

/** Console programs write to the Debug Console by default, so no terminal opens per launch. */
export const DEFAULT_CONSOLE = 'internalConsole';

export interface LaunchInput {
  project: SlnProject;
  config: SolutionConfig;
  settings: VsslnSettings;
  properties: DebugProperties;
  workspaceFolder: string;
  solutionDir: string;
  /** The environment the debugger inherits. */
  env: Record<string, string | undefined>;
  noDebug: boolean;
  /** Values of a launch.json entry of type vssln, which win over everything else. */
  overrides?: { program?: string; args?: string[]; cwd?: string; env?: Record<string, string>; console?: string };
}

export interface CppvsdbgConfiguration {
  type: 'cppvsdbg';
  request: 'launch';
  name: string;
  program: string;
  args: string[];
  cwd: string;
  environment: { name: string; value: string }[];
  console: string;
  noDebug?: boolean;
}

export type LaunchResult = { config: CppvsdbgConfiguration } | { problem: string; action?: 'openSettings' };

function find<T>(record: Record<string, T> | undefined, name: string): T | undefined {
  if (!record) return undefined;
  const key = Object.keys(record).find(k => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : record[key];
}

function lookup(env: Record<string, string | undefined>, name: string): string | undefined {
  const key = Object.keys(env).find(k => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

/** Sets a variable the way Windows reads it: other spellings of the name are replaced. */
function setVariable(env: Record<string, string>, name: string, value: string): void {
  const existing = Object.keys(env).find(k => k.toLowerCase() === name.toLowerCase());
  if (existing !== undefined && existing !== name) delete env[existing];
  env[name] = value;
}

/** The project's debug settings with the entry for the current configuration applied on top. */
function debugSettings(settings: VsslnSettings, project: SlnProject, config: SolutionConfig): DebugSettings {
  const debug = find(settings.projects, project.name)?.debug ?? {};
  const { byConfiguration, ...rest } = debug;
  return { ...rest, ...(find(byConfiguration, config.name) ?? {}) };
}

/**
 * The cppvsdbg configuration for a project: MSBuild values (including .vcxproj.user), then vssln.json, then the
 * configuration entry, then a launch.json entry. The environment lists only what differs from the inherited one.
 */
export function resolveLaunch(input: LaunchInput): LaunchResult {
  const { project, config, settings, properties: props, env, overrides = {} } = input;
  const debug = debugSettings(settings, project, config);
  const ctx: VariableContext = {
    workspaceFolder: input.workspaceFolder,
    solutionDir: input.solutionDir,
    projectDir: props.projectDir,
    targetPath: props.targetPath,
    configuration: config.configuration,
    platform: config.platform,
    env,
  };
  const expand = (value: string) => expandVariables(value, ctx).value;

  const explicitProgram = overrides.program ?? (debug.program ? expand(debug.program) : undefined);
  const msbuildProgram = props.command || props.targetPath;
  if (!explicitProgram && props.configurationType !== 'Application' && samePath(msbuildProgram, props.targetPath)) {
    return {
      problem: `${project.name} is a ${props.configurationType || 'project without a program'}; set "program" for it in vssln.json (projects.${project.name}.debug.program).`,
      action: 'openSettings',
    };
  }

  const environment: Record<string, string> = {};
  for (const [k, v] of Object.entries(settings.environment ?? {})) setVariable(environment, k, expand(v));
  const fromUserFile = applyEnvironmentLines(props.environment, { ...env, ...environment });
  for (const [k, v] of Object.entries(fromUserFile)) setVariable(environment, k, v);
  for (const [k, v] of Object.entries(debug.env ?? {})) setVariable(environment, k, expand(v));
  for (const [k, v] of Object.entries(overrides.env ?? {})) setVariable(environment, k, v);

  const launch: CppvsdbgConfiguration = {
    type: 'cppvsdbg',
    request: 'launch',
    name: `${input.noDebug ? 'Run' : 'Debug'} ${project.name}`,
    program: explicitProgram ?? msbuildProgram,
    args: overrides.args ?? debug.args?.map(expand) ?? splitCommandLine(props.arguments),
    cwd: overrides.cwd ?? (debug.cwd ? expand(debug.cwd) : undefined) ?? (props.workingDirectory || props.projectDir),
    environment: Object.entries(environment)
      .filter(([k, v]) => lookup(env, k) !== v)
      .map(([name, value]) => ({ name, value })),
    console: overrides.console ?? debug.console ?? DEFAULT_CONSOLE,
    ...(input.noDebug ? { noDebug: true } : {}),
  };
  return { config: launch };
}
