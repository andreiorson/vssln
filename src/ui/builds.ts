import * as fs from 'fs';
import * as vscode from 'vscode';
import { BuildAction, BuildRequest } from '../build/args';
import { diagnosticDetails, diagnosticRange, DiagnosticDetails, ProblemsBuffer } from '../build/diagnostics';
import { BUILD_OUTPUT_LANGUAGE } from '../build/outputLanguage';
import { BuildRunner, realKillTree, realSpawn } from '../build/runner';
import { cannotBuild, NO_TOOLCHAIN, runBuild, SessionResult } from '../build/session';
import { TreeNode } from '../solution/model';
import { SlnProject } from '../solution/slnParser';
import { Store } from '../state/store';
import { projectFiles } from './host';

/** Problems are pushed to VS Code at most this often during a build, and once at its end. */
const PROBLEMS_FLUSH_MS = 250;

/** Files whose unsaved edits change what is built: they are saved and reloaded before the build starts. */
const SOLUTION_FILES = /(?:[\\/]vssln\.json|\.sln|\.vcxproj)$/i;

function toDiagnostic(d: DiagnosticDetails): vscode.Diagnostic {
  const r = diagnosticRange(d);
  const range = new vscode.Range(r.startLine, r.startColumn, r.endLine, r.endColumn);
  const diagnostic = new vscode.Diagnostic(range, d.message, d.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
  diagnostic.source = 'MSBuild';
  if (d.code) diagnostic.code = d.code;
  return diagnostic;
}

/** Starts builds, writes their output to one Output channel (colored by its grammar) and fills Problems. */
export class Builds implements vscode.Disposable {
  readonly runner = new BuildRunner(realSpawn(), realKillTree());
  private readonly channel = vscode.window.createOutputChannel('VS Solution: Build', BUILD_OUTPUT_LANGUAGE);
  private readonly problems = vscode.languages.createDiagnosticCollection('vssln');
  private readonly buffer = new ProblemsBuffer();
  private flushTimer?: ReturnType<typeof setTimeout>;
  private readonly subscription: { dispose(): void };
  /** Set from the moment a build is accepted until it ends, so a double click cannot start two. */
  private busy = false;
  private disposed = false;

  constructor(
    private readonly store: Store,
    private readonly logDir: string,
    private readonly log: vscode.LogOutputChannel,
    /** Reloads the solution (used when unsaved solution files were saved right before a build). */
    private readonly reload: () => Promise<void>,
  ) {
    // When a reload drops the build result (another solution or configuration), its problems go too.
    this.subscription = store.onDidChange(s => {
      if (s.build.status === 'idle' && !this.busy) this.clearProblems();
    });
  }

  /** A build from a button or menu: nothing is asked when it cannot run, Clean and Rebuild are confirmed. */
  async start(action: BuildAction, node?: TreeNode): Promise<void> {
    const reason = this.busy ? 'A build is already running.' : cannotBuild(this.store.state, this.runner);
    if (reason) {
      this.showRefusal(reason);
      return;
    }
    const project = node?.project;
    if (action !== 'Build') {
      const what = project ? `project ${project.name}` : 'the whole solution';
      const question = action === 'Rebuild'
        ? `Rebuild ${what}? This discards the incremental build state.`
        : `Clean ${what}? This deletes the build outputs.`;
      if ((await vscode.window.showWarningMessage(question, { modal: true }, action)) !== action) return;
    }
    await this.run(action, project);
  }

  /** Runs a build without asking (the confirmed path of start(); also the API for tests). */
  async run(action: BuildAction, projectOrName?: SlnProject | string): Promise<SessionResult> {
    const refused = (reason: string): SessionResult => {
      this.showRefusal(reason);
      return { started: false, reason };
    };
    if (this.busy) return refused('A build is already running.');
    const early = cannotBuild(this.store.state, this.runner);
    if (early) return refused(early);
    this.busy = true;
    try {
      const project = typeof projectOrName === 'string'
        ? this.store.state.solution?.projects.find(p => p.name.toLowerCase() === projectOrName.toLowerCase())
        : projectOrName;
      if (projectOrName !== undefined && !project) return refused(`Project "${projectOrName}" is not in the loaded solution.`);

      // Like Visual Studio: the build sees what is in the editors, including unsaved solution settings.
      const solutionEdited = vscode.workspace.textDocuments.some(d => d.isDirty && d.uri.scheme === 'file' && SOLUTION_FILES.test(d.fileName));
      await vscode.workspace.saveAll(false);
      if (solutionEdited) await this.reload();
      await fs.promises.mkdir(this.logDir, { recursive: true });

      const request: BuildRequest = { action, ...(project ? { project } : {}) };
      const solutionPath = this.store.state.solution?.path;
      const result = await runBuild(
        {
          store: this.store,
          runner: this.runner,
          now: Date.now,
          logDir: this.logDir,
          env: process.env,
          writeFile: (p, text) => fs.promises.writeFile(p, text, 'utf8'),
          projectFiles,
          write: line => this.write(line),
          onStarted: () => {
            if (this.disposed) return;
            this.channel.clear();
            this.channel.show(true);
            this.clearProblems();
          },
          onDiagnostic: e => {
            const d = diagnosticDetails(e.text, solutionPath);
            if (d && this.buffer.add(d)) this.scheduleFlush();
          },
        },
        request,
      );
      if (!result.started) this.showRefusal(result.reason);
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.log.error(`Build failed to run: ${message}`);
      this.write(`The build failed to run: ${message}`);
      if (!this.disposed) {
        this.channel.show(true);
        void vscode.window.showErrorMessage(`The build failed to run: ${message}`);
      }
      return { started: false, reason: message };
    } finally {
      this.flush();
      this.busy = false;
    }
  }

  /** Writing after dispose (window reload during a build) would throw: the channel is closed. */
  private write(line: string): void {
    if (!this.disposed) this.channel.appendLine(line);
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), PROBLEMS_FLUSH_MS);
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.disposed) return;
    for (const [file, list] of this.buffer.files()) this.problems.set(vscode.Uri.file(file), list.map(toDiagnostic));
  }

  private clearProblems(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.buffer.clear();
    if (!this.disposed) this.problems.clear();
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
    this.disposed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.subscription.dispose();
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
