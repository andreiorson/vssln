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

export function debugPropertiesArgs(
  projectPath: string,
  config: { configuration: string; platform: string },
  solutionDir: string,
  targetsFile: string,
  devEnvDir: string,
): string[] {
  // Project files import solution-level property sheets through $(SolutionDir), which ends with a backslash.
  const dir = solutionDir.endsWith('\\') ? solutionDir : `${solutionDir}\\`;
  return [
    projectPath,
    '-t:VsslnDebugProperties',
    '-nologo',
    '-v:minimal',
    `-p:Configuration=${config.configuration}`,
    `-p:Platform=${config.platform}`,
    `-p:SolutionDir=${dir}`,
    ...(devEnvDir ? [`-p:DevEnvDir=${devEnvDir}`] : []),
    `-p:CustomAfterMicrosoftCommonTargets=${targetsFile}`,
  ];
}

const LINE = /^\s*VSSLN\|([A-Za-z]+)\|(.*?)\s*$/;

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
    environment: get('LocalDebuggerEnvironment').split('\\n').map(l => l.trim()).filter(Boolean),
    mergeEnvironment: get('LocalDebuggerMergeEnvironment').toLowerCase() !== 'false',
    projectDir: get('ProjectDir'),
    configurationType: get('ConfigurationType'),
  };
}

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
    return { problem: `Reading the launch settings with MSBuild failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
