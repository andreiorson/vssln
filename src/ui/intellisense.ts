import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { fileCacheStore } from '../intellisense/cache';
import { CppConfiguration } from '../intellisense/configuration';
import { ProjectDump } from '../intellisense/dump';
import { EngineDeps, IntelliSenseEngine } from '../intellisense/engine';
import { FileIndex } from '../intellisense/fileIndex';
import { TreeNode } from '../solution/model';
import { AppState, Store } from '../state/store';
import { coalesce, debounce } from './coalesce';
import { envExec } from './host';

/** The part of the C/C++ extension's API (vscode-cpptools, version 6) this extension uses. */
interface SourceFileConfigurationItem {
  uri: vscode.Uri;
  configuration: CppConfiguration;
}
interface CustomConfigurationProvider {
  readonly name: string;
  readonly extensionId: string;
  canProvideConfiguration(uri: vscode.Uri): Thenable<boolean>;
  provideConfigurations(uris: vscode.Uri[]): Thenable<SourceFileConfigurationItem[]>;
  canProvideBrowseConfiguration(): Thenable<boolean>;
  provideBrowseConfiguration(): Thenable<null>;
  canProvideBrowseConfigurationsPerFolder(): Thenable<boolean>;
  provideFolderBrowseConfiguration(uri: vscode.Uri): Thenable<null>;
  dispose(): void;
}
interface CppToolsApi {
  registerCustomConfigurationProvider(provider: CustomConfigurationProvider): void;
  notifyReady(provider: CustomConfigurationProvider): void;
  didChangeCustomConfiguration(provider: CustomConfigurationProvider): void;
  dispose(): void;
}
const CPPTOOLS_API_VERSION = 6;

/** What the extension's API exposes for tests. */
export interface IntelliSenseApi {
  engine: Pick<IntelliSenseEngine, 'idle' | 'dumps' | 'recompute' | 'start'>;
  configurationFor(file: string): CppConfiguration | undefined;
}

function engineDeps(dir: string, log: vscode.LogOutputChannel): EngineDeps {
  let temp = 0;
  return {
    exec: envExec,
    store: fileCacheStore(dir),
    read: p => fs.promises.readFile(p).catch(() => undefined),
    exists: p => fs.promises.access(p).then(() => true, () => false),
    existsSync: p => fs.existsSync(p),
    remove: p => fs.promises.rm(p, { force: true }),
    tempFile: () => path.join(os.tmpdir(), `vssln-preprocess-${process.pid}-${++temp}.xml`),
    cores: os.cpus().length,
    env: process.env,
    log: line => log.info(`IntelliSense: ${line}`),
    now: () => Date.now(),
  };
}

/**
 * Keeps IntelliSense data for the loaded solution and answers the C/C++ extension's questions about files. A new
 * pass starts with every reload; a build pauses it.
 */
export function registerIntelliSense(context: vscode.ExtensionContext, store: Store, log: vscode.LogOutputChannel): { disposables: vscode.Disposable[]; api: IntelliSenseApi } {
  const storage = (context.storageUri ?? context.globalStorageUri).fsPath;
  const engine = new IntelliSenseEngine(store, engineDeps(path.join(storage, 'intellisense'), log), context.asAbsolutePath('resources/vssln-intellisense.targets'));

  let dumps: ReadonlyMap<string, ProjectDump> = new Map();
  let index: { key: unknown[]; index: FileIndex } | undefined;
  const indexKey = (s: AppState) => [s.solution, s.projects, s.startupProjectGuid, s.configuration];
  const fileIndex = () => {
    const key = indexKey(store.state);
    if (!index || index.key.some((k, i) => k !== key[i])) index = { key, index: new FileIndex(store.state) };
    return index.index;
  };
  const configurationFor = (file: string) => fileIndex().configurationFor(file, dumps);

  let cpptools: CppToolsApi | undefined;
  const provider: CustomConfigurationProvider = {
    name: 'VS Solution',
    extensionId: context.extension.id,
    canProvideConfiguration: async uri => uri.scheme === 'file' && configurationFor(uri.fsPath) !== undefined,
    provideConfigurations: async uris =>
      uris.flatMap(uri => {
        const configuration = uri.scheme === 'file' ? configurationFor(uri.fsPath) : undefined;
        return configuration ? [{ uri, configuration }] : [];
      }),
    canProvideBrowseConfiguration: async () => false,
    provideBrowseConfiguration: async () => null,
    canProvideBrowseConfigurationsPerFolder: async () => false,
    provideFolderBrowseConfiguration: async () => null,
    dispose: () => undefined,
  };
  // cpptools asks again about every open file after this; once a second is enough while projects keep arriving.
  const changed = coalesce(() => cpptools?.didChangeCustomConfiguration(provider), 1000);
  const dumpsChanged = engine.onDidChangeDumps(() => {
    dumps = engine.dumps();
    changed();
  });

  void (async () => {
    try {
      const extension = vscode.extensions.getExtension<{ getApi?(version: number): CppToolsApi }>('ms-vscode.cpptools');
      const exports = extension ? (extension.isActive ? extension.exports : await extension.activate()) : undefined;
      cpptools = exports?.getApi?.(CPPTOOLS_API_VERSION);
      if (!cpptools) {
        log.warn('IntelliSense: the C/C++ extension (ms-vscode.cpptools) is not available, so its IntelliSense gets no data from the solution.');
        return;
      }
      cpptools.registerCustomConfigurationProvider(provider);
      cpptools.notifyReady(provider);
    } catch (e) {
      log.error(`IntelliSense: registering with the C/C++ extension failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  })();

  // A new pass for every reload (solution, configuration, projects, toolchain or settings changed); none for the
  // updates the engine and builds make themselves. A build pauses the pass.
  const passKey = (s: AppState) => [s.phase, s.solution, s.configuration, s.projects, s.toolchain, s.settings];
  let lastPass: unknown[] = [];
  let building = false;
  let lastIndex: unknown[] = [];
  const onState = (s: AppState) => {
    const key = passKey(s);
    if (key.some((k, i) => k !== lastPass[i])) {
      lastPass = key;
      queueMicrotask(() => engine.start());
    }
    const nowBuilding = s.build.status === 'running';
    if (nowBuilding !== building) {
      building = nowBuilding;
      if (building) engine.pause();
      else engine.resume();
    }
    // Another startup project can change which project answers for a shared file.
    const ik = indexKey(s);
    if (ik.some((k, i) => k !== lastIndex[i])) {
      lastIndex = ik;
      changed();
    }
  };
  const stateSubscription = store.onDidChange(onState);
  onState(store.state);

  const prioritize = () => {
    const active = vscode.window.activeTextEditor?.document.uri;
    const files = [active, ...vscode.window.visibleTextEditors.map(e => e.document.uri)].flatMap(u => (u?.scheme === 'file' ? [u.fsPath] : []));
    engine.prioritize(files);
  };
  prioritize();

  // Property sheets in the workspace: the projects that read them are checked again (by content hash).
  const sheets = new Set<string>();
  const recheck = debounce(() => {
    const files = [...sheets];
    sheets.clear();
    engine.recheck(files);
  }, 500);
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{props,targets}');
  const onSheet = (uri: vscode.Uri) => {
    sheets.add(uri.fsPath);
    recheck();
  };

  const disposables: vscode.Disposable[] = [
    watcher,
    watcher.onDidCreate(onSheet),
    watcher.onDidChange(onSheet),
    watcher.onDidDelete(onSheet),
    vscode.window.onDidChangeActiveTextEditor(prioritize),
    vscode.window.onDidChangeVisibleTextEditors(prioritize),
    vscode.commands.registerCommand('vssln.recomputeIntelliSense', () => engine.recompute()),
    vscode.commands.registerCommand('vssln.recomputeIntelliSenseForProject', (node?: TreeNode) => {
      if (node?.project) engine.recompute(node.project.guid);
    }),
    {
      dispose: () => {
        recheck.cancel();
        stateSubscription.dispose();
        dumpsChanged.dispose();
        engine.dispose();
        cpptools?.dispose();
      },
    },
  ];
  return { disposables, api: { engine, configurationFor } };
}
