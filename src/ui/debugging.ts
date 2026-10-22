import * as vscode from 'vscode';
import { debugPropertiesArgs, evaluateDebugProperties } from '../debug/properties';
import { LaunchInput, LaunchResult, resolveLaunch } from '../debug/launchResolver';
import { msbuildEnvironment, withTrailingBackslash } from '../build/environment';
import { TreeNode } from '../solution/model';
import { projectConfigFor, SlnProject } from '../solution/slnParser';
import { Store } from '../state/store';
import { Builds } from './builds';
import { envExec } from './host';

type Overrides = NonNullable<LaunchInput['overrides']>;

/** Builds a project, reads its launch settings from MSBuild and starts the C/C++ debugger (cppvsdbg). */
export class Debugging implements vscode.DebugConfigurationProvider {
  constructor(
    private readonly store: Store,
    private readonly builds: Builds,
    private readonly targetsFile: string,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  private project(name?: string): SlnProject | undefined {
    const s = this.store.state;
    const guid = name === undefined ? s.startupProjectGuid : undefined;
    return s.solution?.projects.find(p => (guid ? p.guid === guid : p.name.toLowerCase() === name?.toLowerCase()));
  }

  /** The launch configuration for a project (the startup project when none is named), without building. */
  async resolve(projectName?: string, noDebug = false, overrides?: Overrides): Promise<LaunchResult> {
    const s = this.store.state;
    if (s.phase !== 'ready' || !s.solution || !s.configuration) return { problem: 'No solution is loaded.' };
    if (!s.toolchain) return { problem: 'Visual Studio with MSBuild was not found. Use Configure toolchain to set it up.' };
    const project = this.project(projectName);
    if (!project) {
      return projectName === undefined
        ? { problem: 'There is no startup project. Pick one in the Status view.' }
        : { problem: `Project "${projectName}" is not in the loaded solution.` };
    }
    if (project.kind !== 'vcxproj' || !s.projects.get(project.guid)?.exists) return { problem: `${project.name} cannot be started: it is not a C++ project on disk.` };
    const mapping = projectConfigFor(s.solution, project.guid, s.configuration.name);
    if (!mapping) return { problem: `${project.name} is not in ${s.configuration.name}.` };

    // The same MSBuild context as builds, so the evaluated TargetPath is the program the build produced.
    const folder = s.folder ?? s.solution.dir;
    const solutionDir = withTrailingBackslash(s.solution.dir);
    const env = msbuildEnvironment({ settings: s.settings, folder, solutionDir, configuration: s.configuration }, process.env);
    const args = debugPropertiesArgs({
      projectPath: project.absPath,
      config: mapping,
      solutionPath: s.solution.path,
      targetsFile: this.targetsFile,
      devEnvDir: s.toolchain.devEnvDir,
      properties: s.settings.msbuild?.properties ?? {},
    });
    const evaluated = await evaluateDebugProperties({ exec: envExec, msbuildPath: s.toolchain.msbuildPath, env }, args);
    if (!evaluated.properties) return { problem: evaluated.problem ?? 'Reading the launch settings failed.' };

    return resolveLaunch({
      project,
      config: s.configuration,
      settings: s.settings,
      properties: evaluated.properties,
      workspaceFolder: folder,
      solutionDir,
      env: process.env,
      noDebug,
      ...(overrides ? { overrides } : {}),
    });
  }

  /** Build (unless turned off), then resolve; shows what went wrong and returns undefined when it cannot start. */
  private async prepare(projectName: string | undefined, noDebug: boolean, overrides?: Overrides) {
    if (this.store.state.build.status === 'running') {
      void vscode.window.showInformationMessage('Wait for the build to finish or stop it.');
      return undefined;
    }
    const project = this.project(projectName);
    if (project && this.store.state.settings.build?.buildBeforeDebug !== false) {
      const built = await this.builds.run('Build', project);
      if (!built.started) return undefined;
      if (built.outcome.status !== 'succeeded') {
        void vscode.commands.executeCommand('workbench.actions.view.problems');
        void vscode.window.showErrorMessage(`The build failed, so ${project.name} was not started.`);
        return undefined;
      }
    }
    const result = await this.resolve(projectName, noDebug, overrides);
    if ('problem' in result) {
      this.log.warn(result.problem);
      const action = result.action === 'openSettings' ? 'Open settings' : undefined;
      const choice = await vscode.window.showErrorMessage(result.problem, ...(action ? [action] : []));
      if (choice === 'Open settings') void vscode.commands.executeCommand('vssln.openSettings');
      return undefined;
    }
    return result.config;
  }

  /** Debug (or run) a project: the startup project when none is given. */
  async launch(projectName: string | undefined, noDebug: boolean): Promise<boolean> {
    const config = await this.prepare(projectName, noDebug);
    if (!config) return false;
    const folder = vscode.workspace.workspaceFolders?.find(f => f.uri.fsPath.toLowerCase() === this.store.state.folder?.toLowerCase());
    return vscode.debug.startDebugging(folder, config as unknown as vscode.DebugConfiguration, { noDebug });
  }

  /** launch.json entries of type vssln, and F5 in the Run view without a launch.json, become cppvsdbg launches. */
  async resolveDebugConfiguration(_folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): Promise<vscode.DebugConfiguration | undefined> {
    const noDebug = config.noDebug === true;
    const overrides: Overrides = {
      ...(typeof config.program === 'string' ? { program: config.program } : {}),
      ...(Array.isArray(config.args) ? { args: config.args.map(String) } : {}),
      ...(typeof config.cwd === 'string' ? { cwd: config.cwd } : {}),
      ...(config.env && typeof config.env === 'object' ? { env: config.env as Record<string, string> } : {}),
      ...(typeof config.console === 'string' ? { console: config.console } : {}),
    };
    const project = typeof config.project === 'string' && config.project ? config.project : undefined;
    const resolved = await this.prepare(project, noDebug, overrides);
    return resolved ? ({ ...resolved, ...(config.name ? { name: config.name } : {}) } as unknown as vscode.DebugConfiguration) : undefined;
  }
}

export function registerDebugging(debugging: Debugging, store: Store): vscode.Disposable[] {
  const r = (id: string, fn: (...args: any[]) => unknown) => vscode.commands.registerCommand(id, fn);
  return [
    vscode.debug.registerDebugConfigurationProvider('vssln', debugging),
    r('vssln.debug', () => debugging.launch(undefined, false)),
    r('vssln.run', () => debugging.launch(undefined, true)),
    r('vssln.debugProject', (node?: TreeNode) => node?.project && debugging.launch(node.project.name, false)),
    r('vssln.runProject', (node?: TreeNode) => node?.project && debugging.launch(node.project.name, true)),
    // For ${command:vssln.…} in launch.json and tasks.json.
    r('vssln.startupProject', () => store.state.solution?.projects.find(p => p.guid === store.state.startupProjectGuid)?.name),
    r('vssln.configuration', () => store.state.configuration?.name),
    r('vssln.targetPath', async () => {
      const result = await debugging.resolve(undefined, true);
      return 'config' in result ? result.config.program : undefined;
    }),
  ];
}

