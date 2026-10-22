import * as fs from 'fs';
import * as vscode from 'vscode';
import { BuildAction, BuildRequest } from '../build/args';
import { BuildRunner, realKillTree, realSpawn } from '../build/runner';
import { cannotBuild, NO_TOOLCHAIN, runBuild } from '../build/session';
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

/** How long a button press counts as "starting" while VS Code has not opened the task terminal yet. */
const STARTING_GRACE_MS = 5000;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Builds through VS Code tasks, so Ctrl+Shift+B and the problem matchers work, and owns the one MSBuild runner. */
export class BuildTasks implements vscode.TaskProvider, vscode.Disposable {
  readonly runner = new BuildRunner(realSpawn(), realKillTree());
  private lastTaskName?: string;
  private startingUntil = 0;
  private stopping?: Promise<void>;

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
      // Ours first: $msCompile also accepts lines without a position and would file them under "LINK".
      ['$vssln-nolocation', '$msCompile'],
    );
    task.group = GROUPS[def.action];
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, focus: false, clear: true, panel: vscode.TaskPanelKind.Dedicated };
    return task;
  }

  private terminal(def: VsslnTaskDefinition, name: string): vscode.Pseudoterminal {
    const write = new vscode.EventEmitter<string>();
    const close = new vscode.EventEmitter<number>();
    // Only the terminal that started the running build may stop it when it is closed.
    let ownsBuild = false;
    return {
      onDidWrite: write.event,
      onDidClose: close.event,
      open: () => {
        const started = () => {
          ownsBuild = true;
          this.lastTaskName = name;
        };
        void this.run(def, line => write.fire(`${line}\r\n`), started).then(code => {
          ownsBuild = false;
          close.fire(code);
          write.dispose();
          close.dispose();
        });
      },
      close: () => {
        if (ownsBuild) this.stopping = this.stopAndWait();
      },
    };
  }

  private async stopAndWait(): Promise<void> {
    await this.runner.stop();
    await this.runner.whenIdle();
    this.stopping = undefined;
  }

  private async run(def: VsslnTaskDefinition, write: (line: string) => void, onStarted: () => void): Promise<number> {
    this.startingUntil = 0;
    // "Restart Task" closes the old terminal and opens a new one at once: let the old build die first.
    if (this.stopping) await this.stopping;

    const project = def.project ? this.store.state.solution?.projects.find(p => p.name.toLowerCase() === def.project!.toLowerCase()) : undefined;
    if (def.project && !project) {
      const reason = `Project "${def.project}" is not in the loaded solution.`;
      write(reason);
      this.showRefusal(reason);
      return 1;
    }
    const request: BuildRequest = { action: def.action, ...(project ? { project } : {}) };
    try {
      await fs.promises.mkdir(this.logDir, { recursive: true });
      const result = await runBuild(
        { store: this.store, runner: this.runner, now: Date.now, logDir: this.logDir, env: process.env, write, onStarted },
        request,
      );
      if (!result.started) {
        write(result.reason);
        this.showRefusal(result.reason);
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

  private showRefusal(reason: string): void {
    if (reason !== NO_TOOLCHAIN) {
      void vscode.window.showErrorMessage(reason);
      return;
    }
    const configure = 'Configure toolchain';
    void vscode.window.showErrorMessage(reason, configure).then(choice => {
      if (choice === configure) void vscode.commands.executeCommand('vssln.configureToolchain');
    });
  }

  /** Starts a build from a button or menu: one at a time, nothing asked when it cannot run, Clean and Rebuild confirmed. */
  async start(action: BuildAction, node?: TreeNode): Promise<void> {
    if (Date.now() < this.startingUntil) {
      void vscode.window.showInformationMessage('A build is already starting.');
      return;
    }
    const reason = cannotBuild(this.store.state, this.runner);
    if (reason) {
      if (reason === 'A build is already running.') void vscode.window.showInformationMessage(reason);
      else this.showRefusal(reason);
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
    // VS Code saves dirty editors itself before running a task (task.saveBeforeRun).
    this.startingUntil = Date.now() + STARTING_GRACE_MS;
    await vscode.tasks.executeTask(this.task({ type: TASK_TYPE, action, ...(projectName ? { project: projectName } : {}) }));
  }

  async stop(): Promise<void> {
    await this.runner.stop();
  }

  /** The terminal of the last started build, or the build log when the terminal is gone. */
  async showOutput(): Promise<void> {
    const name = this.lastTaskName;
    const exact = name ? new RegExp(`(^|[\\s-])${escapeRegExp(name)}$`) : undefined;
    const terminal = exact ? vscode.window.terminals.find(t => exact.test(t.name)) : undefined;
    if (terminal) {
      terminal.show(true);
      return;
    }
    const logFile = this.store.state.build.logFile;
    if (logFile && fs.existsSync(logFile)) await vscode.window.showTextDocument(vscode.Uri.file(logFile));
  }

  /** Window reload or shutdown: kill the build synchronously so no MSBuild outlives the extension host. */
  dispose(): void {
    this.runner.stopNow();
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
