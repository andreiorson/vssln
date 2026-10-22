import * as path from 'path';
import { expandVariables, VariableContext } from '../settings/resolver';
import { DebugSettings, VsslnSettings } from '../settings/settings';
import { SlnProject, SolutionConfig } from '../solution/slnParser';
import { Env, envLookup, setVariable, withVariables } from '../util/env';
import { applyEnvironmentLines, joinCommandLine, splitCommandLine } from './commandLine';
import { DebugProperties } from './properties';

/** Console programs write to the Debug Console by default, so no terminal opens per launch. */
export const DEFAULT_CONSOLE = 'internalConsole';

/** What Windows can start directly; anything else (a .dll, a .lib) needs a host program. */
const RUNNABLE = /\.(exe|com|bat|cmd)$/i;

export interface LaunchInput {
  project: SlnProject;
  config: SolutionConfig;
  settings: VsslnSettings;
  properties: DebugProperties;
  workspaceFolder: string;
  solutionDir: string;
  /** The environment the debugger inherits. */
  env: Env;
  noDebug: boolean;
  /** Values of a launch.json entry of type vssln, which win over everything else. */
  overrides?: { program?: string; args?: string[]; cwd?: string; env?: Record<string, string>; console?: string };
}

export interface CppvsdbgConfiguration {
  type: 'cppvsdbg';
  request: 'launch';
  name: string;
  program: string;
  /**
   * One command line: cppvsdbg passes it to the program as is, while an args array loses empty arguments. The
   * .vcxproj.user string is used verbatim, like Visual Studio does; arrays are joined with Windows quoting.
   */
  args: string;
  cwd: string;
  /** Only the variables that differ from the inherited environment, in the inherited spelling of their names. */
  environment: { name: string; value: string }[];
  console: string;
  noDebug?: boolean;
}

/** `argv` is what the program receives, for launches that start it themselves (Run without debugging). */
export type LaunchResult = { config: CppvsdbgConfiguration; argv: string[] } | { problem: string; action?: 'openSettings' };

function find<T>(record: Record<string, T> | undefined, name: string): T | undefined {
  if (!record) return undefined;
  const key = Object.keys(record).find(k => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : record[key];
}

/** The project's debug settings with the entry for the current configuration applied on top. */
function debugSettings(settings: VsslnSettings, project: SlnProject, config: SolutionConfig): DebugSettings {
  const debug = find(settings.projects, project.name)?.debug ?? {};
  const { byConfiguration, ...rest } = debug;
  return { ...rest, ...(find(byConfiguration, config.name) ?? {}) };
}

/** An empty string counts as not set. */
function given(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/**
 * The cppvsdbg configuration for a project: MSBuild values (including .vcxproj.user), then vssln.json, then the
 * configuration entry, then a launch.json entry. Relative paths of the settings and launch.json are resolved against
 * the workspace folder, those of MSBuild against the project directory.
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
  const fromSettings = (value: string | undefined) => (given(value) ? path.win32.resolve(input.workspaceFolder, expand(value!)) : undefined);
  const fromOverrides = (value: string | undefined) => (given(value) ? path.win32.resolve(input.workspaceFolder, value!) : undefined);
  const fromMsbuild = (value: string) => (given(value) ? path.win32.resolve(props.projectDir || input.workspaceFolder, value) : undefined);

  const program = fromOverrides(overrides.program) ?? fromSettings(debug.program ?? undefined) ?? fromMsbuild(props.command) ?? fromMsbuild(props.targetPath) ?? '';
  if (!RUNNABLE.test(program)) {
    const kind = props.configurationType || 'project';
    return {
      problem: `${project.name} is a ${kind} and ${path.win32.basename(program) || 'its output'} cannot be started; set "program" for it in vssln.json (projects.${project.name}.debug.program).`,
      action: 'openSettings',
    };
  }

  const settingsEnv: Env = {};
  for (const [k, v] of Object.entries(settings.environment ?? {})) setVariable(settingsEnv, k, expand(v));
  const fromUserFile = applyEnvironmentLines(props.environment, withVariables(env, settingsEnv));
  const debugEnv: Env = {};
  for (const [k, v] of Object.entries(debug.env ?? {})) setVariable(debugEnv, k, expand(v));
  const changes = withVariables({}, settingsEnv, fromUserFile, debugEnv, overrides.env ?? {});

  const environment = Object.entries(changes)
    .filter(([name, value]) => envLookup(env, name) !== value)
    .map(([name, value]) => ({ name: Object.keys(env).find(k => k.toLowerCase() === name.toLowerCase()) ?? name, value }));

  const listed = overrides.args ?? debug.args?.map(expand);
  const argv = listed ?? splitCommandLine(props.arguments);
  const commandLine = listed ? joinCommandLine(listed) : props.arguments;

  const launch: CppvsdbgConfiguration = {
    type: 'cppvsdbg',
    request: 'launch',
    name: `${input.noDebug ? 'Run' : 'Debug'} ${project.name}`,
    program,
    args: commandLine,
    cwd: fromOverrides(overrides.cwd) ?? fromSettings(debug.cwd) ?? fromMsbuild(props.workingDirectory) ?? fromMsbuild(props.projectDir) ?? input.workspaceFolder,
    environment,
    console: given(overrides.console) ?? debug.console ?? DEFAULT_CONSOLE,
    ...(input.noDebug ? { noDebug: true } : {}),
  };
  return { config: launch, argv };
}
