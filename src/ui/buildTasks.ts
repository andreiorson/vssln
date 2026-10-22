import * as fs from 'fs';
import * as vscode from 'vscode';
import { BuildAction, BuildRequest } from '../build/args';
import { BuildRunner, realKillTree, realSpawn } from '../build/runner';
import { runBuild } from '../build/session';
import { TreeNode } from '../solution/model';
import { Store } from '../state/store';

export const TASK_TYPE = 'vssln';

interface VsslnTaskDefinition extends vscode.TaskDefinition {
  action: BuildAction;
  /** Project name as in the .sln; absent for the whole solution. */
  project?: string;
}

const GROUPS: Record<BuildAction, vscode.TaskGroup> = {
  Build: vscode.TaskGroup.Build,
  Rebuild: vscode.TaskGroup.Rebuild,
  Clean: vscode.TaskGroup.Clean,
};

/** Builds through VS Code tasks, so Ctrl+Shift+B and the $msCompile problem matcher work, and owns the one MSBuild runner. */
export class BuildTasks implements vscode.TaskProvider, vscode.Disposable {
  readonly runner = new BuildRunner(realSpawn(), realKillTree());
  private lastTaskName?: string;

  constructor(private readonly store: Store, private readonly logDir: string, private readonly log: vscode.LogOutputChannel) {}

  provideTasks(): vscode.Task[] {
    return (['Build', 'Rebuild', 'Clean'] as const).map(action => this.task({ type: TASK_TYPE, action }));
  }

  resolveTask(task: vscode.Task): vscode.Task | undefined {
    const def = task.definition as VsslnTaskDefinition;
    return def.action ? this.task(def) : undefined;
  }

  private task(def: VsslnTaskDefinition): vscode.Task {
    const name = def.project ? `${def.action} ${def.project}` : `${def.action} solution`;
    const task = new vscode.Task(
      def,
      vscode.TaskScope.Workspace,
      name,
      TASK_TYPE,
      new vscode.CustomExecution(async () => this.terminal(def, name)),
      '$msCompile',
    );
    task.group = GROUPS[def.action];
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, focus: false, clear: true, panel: vscode.TaskPanelKind.Dedicated };
    return task;
  }

  private terminal(def: VsslnTaskDefinition, name: string): vscode.Pseudoterminal {
    const write = new vscode.EventEmitter<string>();
    const close = new vscode.EventEmitter<number>();
    this.lastTaskName = name;
    return {
      onDidWrite: write.event,
      onDidClose: close.event,
      open: () => {
        void this.run(def, line => write.fire(`${line}\r\n`)).then(code => close.fire(code));
      },
      // Closing the terminal stops the build.
      close: () => void this.runner.stop(),
    };
  }

  private async run(def: VsslnTaskDefinition, write: (line: string) => void): Promise<number> {
    const project = def.project ? this.store.state.solution?.projects.find(p => p.name.toLowerCase() === def.project!.toLowerCase()) : undefined;
    if (def.project && !project) {
      write(`Project "${def.project}" is not in the loaded solution.`);
      return 1;
    }
    const request: BuildRequest = { action: def.action, ...(project ? { project } : {}) };
    try {
      await fs.promises.mkdir(this.logDir, { recursive: true });
      const result = await runBuild(
        { store: this.store, runner: this.runner, now: Date.now, logDir: this.logDir, env: process.env, write },
        request,
      );
      if (!result.started) {
        write(result.reason);
        void vscode.window.showErrorMessage(result.reason);
        return 1;
      }
      return result.outcome.status === 'succeeded' ? 0 : 1;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log.error(`Build failed to run: ${message}`);
      write(`Build failed to run: ${message}`);
      return 1;
    }
  }

  /** Starts a build from a button or menu: one at a time, saves editors, confirms Clean and Rebuild. */
  async start(action: BuildAction, node?: TreeNode): Promise<void> {
    if (this.store.state.build.status === 'running' || this.runner.running) {
      void vscode.window.showInformationMessage('A build is already running.');
      return;
    }
    const projectName = node?.project?.name;
    if (action !== 'Build') {
      const what = projectName ? `project ${projectName}` : 'the whole solution';
      const question = action === 'Rebuild'
        ? `Rebuild ${what}? This discards the incremental build state.`
        : `Clean ${what}? This deletes the build outputs.`;
      if ((await vscode.window.showWarningMessage(question, { modal: true }, action)) !== action) return;
    }
    if (this.store.state.settings.build?.saveBeforeBuild !== false) await vscode.workspace.saveAll(false);
    await vscode.tasks.executeTask(this.task({ type: TASK_TYPE, action, ...(projectName ? { project: projectName } : {}) }));
  }

  async stop(): Promise<void> {
    await this.runner.stop();
  }

  /** The terminal of the last build, or the build log when the terminal is gone. */
  async showOutput(): Promise<void> {
    const terminal = this.lastTaskName ? vscode.window.terminals.find(t => t.name.includes(this.lastTaskName!)) : undefined;
    if (terminal) {
      terminal.show(true);
      return;
    }
    const logFile = this.store.state.build.logFile;
    if (logFile && fs.existsSync(logFile)) await vscode.window.showTextDocument(vscode.Uri.file(logFile));
  }

  dispose(): void {
    void this.runner.stop();
  }
}

export function registerBuildCommands(builds: BuildTasks): vscode.Disposable[] {
  const r = (id: string, fn: (...args: any[]) => unknown) => vscode.commands.registerCommand(id, fn);
  return [
    vscode.tasks.registerTaskProvider(TASK_TYPE, builds),
    r('vssln.build', () => builds.start('Build')),
    r('vssln.rebuild', () => builds.start('Rebuild')),
    r('vssln.clean', () => builds.start('Clean')),
    r('vssln.buildProject', (node?: TreeNode) => node?.project && builds.start('Build', node)),
    r('vssln.rebuildProject', (node?: TreeNode) => node?.project && builds.start('Rebuild', node)),
    r('vssln.cleanProject', (node?: TreeNode) => node?.project && builds.start('Clean', node)),
    r('vssln.stop', () => builds.stop()),
    r('vssln.showBuildOutput', () => builds.showOutput()),
  ];
}
