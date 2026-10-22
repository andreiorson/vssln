import { expandVariables } from '../settings/resolver';
import { VsslnSettings } from '../settings/settings';
import { SolutionConfig } from '../solution/slnParser';
import { Env, setVariable } from '../util/env';

export interface MsbuildContext {
  settings: VsslnSettings;
  folder: string;
  /** With a trailing backslash, like MSBuild's $(SolutionDir). */
  solutionDir: string;
  configuration: SolutionConfig;
}

/** Variables of the VS Code extension host that must not leak into MSBuild and the tools it runs. */
function isEditorVariable(name: string): boolean {
  return name === 'ELECTRON_RUN_AS_NODE' || name.startsWith('VSCODE_');
}

/**
 * The environment of every MSBuild run (builds and launch-setting evaluations): the process environment without the
 * editor's own variables, the expanded `environment` of vssln.json, and English output — MSBuild takes its language
 * from DOTNET_CLI_UI_LANGUAGE (which also switches its console to UTF-8), cl.exe and link.exe from VSLANG.
 */
export function msbuildEnvironment(ctx: MsbuildContext, processEnv: Env): Env {
  const env: Env = {};
  for (const [key, value] of Object.entries(processEnv)) if (!isEditorVariable(key)) env[key] = value;
  for (const [key, value] of Object.entries(ctx.settings.environment ?? {})) {
    const expanded = expandVariables(value, {
      workspaceFolder: ctx.folder,
      solutionDir: ctx.solutionDir,
      configuration: ctx.configuration.configuration,
      platform: ctx.configuration.platform,
      env: processEnv,
    });
    setVariable(env, key, expanded.value);
  }
  setVariable(env, 'DOTNET_CLI_UI_LANGUAGE', 'en-US');
  setVariable(env, 'VSLANG', '1033');
  return env;
}

/** $(SolutionDir) form of a directory. */
export function withTrailingBackslash(dir: string): string {
  return dir.endsWith('\\') ? dir : `${dir}\\`;
}
