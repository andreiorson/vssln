import * as fs from 'fs';
import * as vscode from 'vscode';
import { BuildAction, BuildRequest } from '../build/args';
import { diagnosticDetails } from '../build/diagnostics';
import { BuildRunner, realKillTree, realSpawn } from '../build/runner';
import { cannotBuild, NO_TOOLCHAIN, runBuild, SessionResult } from '../build/session';
import { TreeNode } from '../solution/model';
import { Store } from '../state/store';

export const BUILD_OUTPUT_LANGUAGE = 'vssln-build-output';

/** Starts builds, writes their output to one Output channel (colored by its grammar) and fills Problems. */
export class Builds implements vscode.Disposable {
  readonly runner = new BuildRunner(realSpawn(), realKillTree());
  private readonly channel = vscode.window.createOutputChannel('VS Solution: Build', BUILD_OUTPUT_LANGUAGE);
  private readonly problems = vscode.languages.createDiagnosticCollection('vssln');
  /** Set from the moment a build is accepted until it ends, so a double click cannot start two. */
  private busy = false;

  constructor(private readonly store: Store, private readonly logDir: string, private readonly log: vscode.LogOutputChannel) {}

  /** A build from a button or menu: nothing is asked when it cannot run, Clean and Rebuild are confirmed. */
  async start(action: BuildAction, node?: TreeNode): Promise<void> {
    const reason = this.busy ? 'A build is already running.' : cannotBuild(this.store.state, this.runner);
    if (reason) {
      this.showRefusal(reason);
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
    await this.run(action, node?.project?.name);
  }

  /** Runs a build without asking (the confirmed path of start(); also the API for tests). */
  async run(action: BuildAction, projectName?: string): Promise<SessionResult> {
    if (this.busy) return { started: false, reason: 'A build is already running.' };
    this.busy = true;
    try {
      const project = projectName ? this.store.state.solution?.projects.find(p => p.name.toLowerCase() === projectName.toLowerCase()) : undefined;
      if (projectName && !project) {
        const reason = `Project "${projectName}" is not in the loaded solution.`;
        this.showRefusal(reason);
        return { started: false, reason };
      }
      const request: BuildRequest = { action, ...(project ? { project } : {}) };
      // Like Visual Studio: the build sees what is in the editors.
      await vscode.workspace.saveAll(false);
      await fs.promises.mkdir(this.logDir, { recursive: true });

      const files = new Map<string, vscode.Diagnostic[]>();
      const result = await runBuild(
        {
          store: this.store,
          runner: this.runner,
          now: Date.now,
          logDir: this.logDir,
          env: process.env,
          write: line => this.channel.appendLine(line),
          onStarted: () => {
            this.channel.clear();
            this.channel.show(true);
            this.problems.clear();
          },
          onDiagnostic: e => this.addProblem(files, e.text),
        },
        request,
      );
      if (!result.started) this.showRefusal(result.reason);
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log.error(`Build failed to run: ${message}`);
      this.channel.appendLine(`The build failed to run: ${message}`);
      return { started: false, reason: message };
    } finally {
      this.busy = false;
    }
  }

  private addProblem(files: Map<string, vscode.Diagnostic[]>, text: string): void {
    const d = diagnosticDetails(text);
    if (!d?.file) return;
    const line = Math.max(0, (d.line ?? 1) - 1);
    const column = Math.max(0, (d.column ?? 1) - 1);
    // Without a column the whole line is marked; VS Code clamps the end to the line length.
    const range = new vscode.Range(line, d.column ? column : 0, line, d.column ? column + 1 : 10_000);
    const diagnostic = new vscode.Diagnostic(range, d.message, d.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
    diagnostic.source = 'MSBuild';
    if (d.code) diagnostic.code = d.code;
    const list = files.get(d.file) ?? [];
    list.push(diagnostic);
    files.set(d.file, list);
    this.problems.set(vscode.Uri.file(d.file), list);
  }

  private showRefusal(reason: string): void {
    if (reason === 'A build is already running.') {
      void vscode.window.showInformationMessage(reason);
      return;
    }
    if (reason !== NO_TOOLCHAIN) {
      void vscode.window.showErrorMessage(reason);
      return;
    }
    const configure = 'Configure toolchain';
    void vscode.window.showErrorMessage(reason, configure).then(choice => {
      if (choice === configure) void vscode.commands.executeCommand('vssln.configureToolchain');
    });
  }

  async stop(): Promise<void> {
    await this.runner.stop();
  }

  showOutput(): void {
    this.channel.show(true);
  }

  /** Window reload or shutdown: kill the build synchronously so no MSBuild outlives the extension host. */
  dispose(): void {
    this.runner.stopNow();
    this.channel.dispose();
    this.problems.dispose();
  }
}

export function registerBuildCommands(builds: Builds): vscode.Disposable[] {
  const r = (id: string, fn: (...args: any[]) => unknown) => vscode.commands.registerCommand(id, fn);
  return [
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
