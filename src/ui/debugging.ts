import * as vscode from 'vscode';
import { msbuildEnvironment, withTrailingBackslash } from '../build/environment';
import { CppvsdbgConfiguration, LaunchInput, LaunchResult, resolveLaunch } from '../debug/launchResolver';
import { DebugProperties, debugPropertiesArgs, evaluateDebugProperties } from '../debug/properties';
import { RunConfig, RunSession } from '../debug/runAdapter';
import { TreeNode } from '../solution/model';
import { projectConfigFor, SlnProject } from '../solution/slnParser';
import { Store } from '../state/store';
import { Builds } from './builds';
import { envExec, killTreeNow, spawnRun } from './host';

type Overrides = NonNullable<LaunchInput['overrides']>;

/** A Run without debugging: our own small debug adapter starts the program (see debug/runAdapter.ts). */
interface RunLaunch extends vscode.DebugConfiguration {
  type: 'vssln';
  vsslnRun: RunConfig;
}

function toRunLaunch(c: CppvsdbgConfiguration, argv: string[]): RunLaunch {
  return {
    type: 'vssln',
    request: 'launch',
    name: c.name,
    noDebug: true,
    vsslnRun: { program: c.program, args: argv, cwd: c.cwd, environment: c.environment, console: c.console },
  };
}

type Evaluated = { project: SlnProject; properties: DebugProperties } | { problem: string };

/** Builds a project, reads its launch settings from MSBuild and starts it: cppvsdbg to debug, our adapter to run. */
export class Debugging implements vscode.DebugConfigurationProvider, vscode.DebugAdapterDescriptorFactory {
  private launching = false;

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

  /** The project's launch properties from MSBuild, in the same context a solution build gives it. */
  async evaluate(projectName?: string): Promise<Evaluated> {
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

    const folder = s.folder ?? s.solution.dir;
    const env = msbuildEnvironment({ settings: s.settings, folder, solutionDir: withTrailingBackslash(s.solution.dir), configuration: s.configuration }, process.env);
    const args = debugPropertiesArgs({
      projectPath: project.absPath,
      config: mapping,
      solutionPath: s.solution.path,
      targetsFile: this.targetsFile,
      devEnvDir: s.toolchain.devEnvDir,
      properties: s.settings.msbuild?.properties ?? {},
    });
    const toolchain = s.toolchain;
    const evaluated = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `Reading launch settings of ${project.name}…` },
      () => evaluateDebugProperties({ exec: envExec, msbuildPath: toolchain.msbuildPath, env }, args),
    );
    if (!evaluated.properties) return { problem: evaluated.problem ?? 'Reading the launch settings failed.' };
    if (!evaluated.properties.mergeEnvironment) {
      this.log.warn(`${project.name}: "Merge Environment" is off in its debugging settings; the debugger still inherits the VS Code environment.`);
    }
    return { project, properties: evaluated.properties };
  }

  /** The launch configuration for a project (the startup project when none is named), without building. */
  async resolve(projectName?: string, noDebug = false, overrides?: Overrides): Promise<LaunchResult> {
    const evaluated = await this.evaluate(projectName);
    if ('problem' in evaluated) return evaluated;
    const s = this.store.state;
    return resolveLaunch({
      project: evaluated.project,
      config: s.configuration!,
      settings: s.settings,
      properties: evaluated.properties,
      workspaceFolder: s.folder ?? s.solution!.dir,
      solutionDir: withTrailingBackslash(s.solution!.dir),
      env: process.env,
      noDebug,
      ...(overrides ? { overrides } : {}),
    });
  }

  private showProblem(problem: string, action?: 'openSettings', settingsPath?: string[]): void {
    this.log.warn(problem);
    // Not awaited: an open notification must not hold up VS Code's debug start.
    void vscode.window.showErrorMessage(problem, ...(action ? ['Open settings'] : [])).then(choice => {
      if (choice === 'Open settings') void vscode.commands.executeCommand('vssln.openSettings', settingsPath ?? ['projects']);
    });
  }

  /** Resolve, then build (unless turned off); returns undefined when the launch cannot or should not go on. */
  private async prepare(projectName: string | undefined, noDebug: boolean, overrides?: Overrides): Promise<{ config: CppvsdbgConfiguration; argv: string[] } | undefined> {
    if (this.launching) {
      void vscode.window.showInformationMessage('A launch is already being prepared.');
      return undefined;
    }
    if (this.store.state.build.status === 'running') {
      void vscode.window.showInformationMessage('Wait for the build to finish or stop it.');
      return undefined;
    }
    if (projectName?.includes('${')) {
      this.showProblem(`"project" must name a project of the solution; variables such as ${projectName} are not supported there.`);
      return undefined;
    }
    this.launching = true;
    try {
      // The launch settings do not depend on the build, so a project that cannot start is reported before building.
      const result = await this.resolve(projectName, noDebug, overrides);
      if ('problem' in result) {
        this.showProblem(result.problem, result.action, result.settingsPath);
        return undefined;
      }
      const project = this.project(projectName);
      if (project && this.store.state.settings.build?.buildBeforeDebug !== false) {
        const built = await this.builds.run('Build', project);
        if (!built.started || built.outcome.status === 'cancelled') return undefined;
        if (built.outcome.status !== 'succeeded') {
          void vscode.commands.executeCommand('workbench.actions.view.problems');
          void vscode.window.showErrorMessage(`The build failed, so ${project.name} was not started.`);
          return undefined;
        }
      }
      return result;
    } finally {
      this.launching = false;
    }
  }

  /** Debug (or run) a project: the startup project when none is given. */
  async launch(projectName: string | undefined, noDebug: boolean): Promise<boolean> {
    const prepared = await this.prepare(projectName, noDebug);
    if (!prepared) return false;
    const folder = vscode.workspace.workspaceFolders?.find(f => f.uri.fsPath.toLowerCase() === this.store.state.folder?.toLowerCase());
    const launch = noDebug ? toRunLaunch(prepared.config, prepared.argv) : (prepared.config as unknown as vscode.DebugConfiguration);
    return vscode.debug.startDebugging(folder, launch, { noDebug });
  }

  /**
   * launch.json entries of type vssln become cppvsdbg launches (or our Run launches with noDebug). Fields of the entry
   * that this extension does not compute (stopAtEntry, visualizerFile, symbolSearchPath, …) are passed through.
   */
  async resolveDebugConfiguration(_folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): Promise<vscode.DebugConfiguration | undefined> {
    if ((config as Partial<RunLaunch>).vsslnRun) return config;
    const { type: _type, request: _request, name, project, program, args, cwd, env, console, noDebug, ...rest } = config;
    const overrides: Overrides = {
      ...(typeof program === 'string' ? { program } : {}),
      ...(Array.isArray(args) ? { args: args.map(String) } : {}),
      ...(typeof cwd === 'string' ? { cwd } : {}),
      ...(env && typeof env === 'object' ? { env: Object.fromEntries(Object.entries(env as object).map(([k, v]) => [k, String(v)])) } : {}),
      ...(typeof console === 'string' ? { console } : {}),
    };
    const resolved = await this.prepare(typeof project === 'string' && project ? project : undefined, noDebug === true, overrides);
    if (!resolved) return undefined;
    const launch = noDebug === true ? toRunLaunch(resolved.config, resolved.argv) : (resolved.config as unknown as vscode.DebugConfiguration);
    return { ...rest, ...launch, ...(typeof name === 'string' && name ? { name } : {}) };
  }

  /** The adapter of Run sessions (type vssln); debugging itself goes to cppvsdbg. */
  createDebugAdapterDescriptor(session: vscode.DebugSession): vscode.DebugAdapterDescriptor {
    return new vscode.DebugAdapterInlineImplementation(new InlineRunAdapter((session.configuration as Partial<RunLaunch>).vsslnRun));
  }
}

/** Connects the DAP core of a Run to VS Code. */
class InlineRunAdapter implements vscode.DebugAdapter {
  private readonly sent = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  readonly onDidSendMessage = this.sent.event;
  private readonly session?: RunSession;
  private pid?: number;

  constructor(config: RunConfig | undefined) {
    if (!config) return;
    this.session = new RunSession(config, {
      spawn: (program, args, opts) => {
        const child = spawnRun(program, args, opts);
        this.pid = child.pid;
        return child;
      },
      killTree: pid => killTreeNow(pid),
      processEnv: process.env,
      send: message => this.sent.fire(message as vscode.DebugProtocolMessage),
    });
  }

  handleMessage(message: vscode.DebugProtocolMessage): void {
    this.session?.handle(message as Parameters<RunSession['handle']>[0]);
  }

  dispose(): void {
    if (this.pid !== undefined) killTreeNow(this.pid);
    this.sent.dispose();
  }
}

export function registerDebugging(debugging: Debugging, store: Store): vscode.Disposable[] {
  const r = (id: string, fn: (...args: any[]) => unknown) => vscode.commands.registerCommand(id, fn);
  const fail = (message: string) => {
    void vscode.window.showErrorMessage(message);
    return undefined;
  };
  return [
    vscode.debug.registerDebugConfigurationProvider('vssln', debugging),
    vscode.debug.registerDebugAdapterDescriptorFactory('vssln', debugging),
    r('vssln.debug', () => debugging.launch(undefined, false)),
    r('vssln.run', () => debugging.launch(undefined, true)),
    r('vssln.debugProject', (node?: TreeNode) => node?.project && debugging.launch(node.project.name, false)),
    r('vssln.runProject', (node?: TreeNode) => node?.project && debugging.launch(node.project.name, true)),
    // For ${command:vssln.…} in launch.json and tasks.json; an undefined result cancels the launch, so say why.
    r('vssln.startupProject', () => store.state.solution?.projects.find(p => p.guid === store.state.startupProjectGuid)?.name ?? fail('There is no startup project.')),
    r('vssln.configuration', () => store.state.configuration?.name ?? fail('No solution is loaded.')),
    r('vssln.targetPath', async () => {
      const evaluated = await debugging.evaluate();
      return 'problem' in evaluated ? fail(evaluated.problem) : evaluated.properties.targetPath;
    }),
  ];
}
