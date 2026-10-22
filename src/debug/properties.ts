import * as path from 'path';
import { escapeValue } from '../build/args';
import { withTrailingBackslash } from '../build/environment';

/** What a debug launch of a project needs, as MSBuild evaluates it (including the project's .vcxproj.user). */
export interface DebugProperties {
  targetPath: string;
  /** LocalDebuggerCommand; MSBuild defaults it to TargetPath. */
  command: string;
  /** LocalDebuggerCommandArguments: one command-line string. */
  arguments: string;
  /** LocalDebuggerWorkingDirectory; MSBuild defaults it to ProjectDir. */
  workingDirectory: string;
  /** LocalDebuggerEnvironment: NAME=value lines, %VAR% not expanded yet. */
  environment: string[];
  mergeEnvironment: boolean;
  projectDir: string;
  configurationType: string;
}

export type EnvExec = (
  file: string,
  args: string[],
  env: Record<string, string | undefined>,
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface DebugPropertiesInput {
  projectPath: string;
  /** The project's own configuration (mapped from the solution configuration). */
  config: { configuration: string; platform: string };
  solutionPath: string;
  targetsFile: string;
  devEnvDir: string;
  /** msbuild.properties of vssln.json, as builds get them. */
  properties: Record<string, string>;
}

/** Evaluates one project in the context a solution build gives it: the Solution* properties and the same -p: values. */
export function debugPropertiesArgs(input: DebugPropertiesInput): string[] {
  const { projectPath, config, solutionPath, targetsFile, devEnvDir, properties } = input;
  const p = (name: string, value: string) => `-p:${name}=${escapeValue(value)}`;
  const ext = path.win32.extname(solutionPath);
  return [
    projectPath,
    '-t:VsslnDebugProperties',
    '-nologo',
    '-v:minimal',
    p('Configuration', config.configuration),
    p('Platform', config.platform),
    // Project files import solution-level property sheets through $(SolutionDir), which ends with a backslash.
    p('SolutionDir', withTrailingBackslash(path.win32.dirname(solutionPath))),
    p('SolutionPath', solutionPath),
    p('SolutionName', path.win32.basename(solutionPath, ext)),
    p('SolutionFileName', path.win32.basename(solutionPath)),
    p('SolutionExt', ext),
    ...(devEnvDir ? [p('DevEnvDir', devEnvDir)] : []),
    ...Object.keys(properties).sort().map(k => p(k, properties[k])),
    p('CustomAfterMicrosoftCommonTargets', targetsFile),
  ];
}

const LINE = /^\s*VSSLN\|([A-Za-z]+)\|(.*?)\s*$/;
const EOL = '|VSSLN-EOL|';

export function parseDebugProperties(output: string): DebugProperties | undefined {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (m) values.set(m[1], m[2]);
  }
  const targetPath = values.get('TargetPath');
  if (!targetPath) return undefined;
  const get = (name: string) => values.get(name) ?? '';
  return {
    targetPath,
    command: get('LocalDebuggerCommand'),
    arguments: get('LocalDebuggerCommandArguments'),
    workingDirectory: get('LocalDebuggerWorkingDirectory'),
    environment: get('LocalDebuggerEnvironment').split(EOL).map(l => l.trim()).filter(Boolean),
    mergeEnvironment: get('LocalDebuggerMergeEnvironment').toLowerCase() !== 'false',
    projectDir: get('ProjectDir'),
    configurationType: get('ConfigurationType'),
  };
}

export const EVALUATION_TIMEOUT_S = 120;

/** Runs the evaluation; a failure comes back with the last lines of MSBuild's output. */
export async function evaluateDebugProperties(
  deps: { exec: EnvExec; msbuildPath: string; env: Record<string, string | undefined> },
  args: string[],
): Promise<{ properties?: DebugProperties; problem?: string }> {
  const env = { ...deps.env, DOTNET_CLI_UI_LANGUAGE: 'en-US', VSLANG: '1033' };
  try {
    const { code, stdout, stderr } = await deps.exec(deps.msbuildPath, args, env);
    const properties = code === 0 ? parseDebugProperties(stdout) : undefined;
    if (properties) return { properties };
    const tail = `${stdout}\n${stderr}`.split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(-3).join(' ');
    return { problem: `Reading the launch settings with MSBuild failed: ${tail || `exit code ${code}`}` };
  } catch (e) {
    if ((e as { killed?: boolean }).killed) return { problem: `Reading the launch settings with MSBuild did not finish in ${EVALUATION_TIMEOUT_S} s.` };
    return { problem: `Reading the launch settings with MSBuild failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
