import { msbuildEnvironment, withTrailingBackslash } from '../build/environment';
import { DebugPropertiesInput, EnvExec } from '../debug/properties';
import { projectConfigFor, SlnProject } from '../solution/slnParser';
import { AppState, idleIntelliSense, ProjectIntelliSense, Store } from '../state/store';
import { pathKey } from '../util/paths';
import { CacheStore, cacheFileName, cacheKey, Hasher, isFresh } from './cache';
import { intellisenseArgs, parseDump, ProjectDump } from './dump';
import { parsePreprocess, preprocessArgs } from './preprocess';
import { Scheduler } from './scheduler';

/** Bumped when resources/vssln-intellisense.targets changes what it prints: older cache entries become stale. */
export const INTELLISENSE_TARGETS_VERSION = 1;
const RUN_TIMEOUT_MS = 300_000;
const TAIL_LINES = 20;

export interface EngineDeps {
  exec: EnvExec;
  store: CacheStore;
  read(p: string): Promise<Buffer | undefined>;
  exists(p: string): Promise<boolean>;
  existsSync(p: string): boolean;
  remove(p: string): Promise<void>;
  /** A path for the -preprocess output; the engine removes it. */
  tempFile(): string;
  cores: number;
  /** The process environment MSBuild starts from. */
  env: Record<string, string | undefined>;
  log(line: string): void;
  now(): number;
}

interface Target {
  project: SlnProject;
  configuration: string;
  platform: string;
}

/** A project's data from MSBuild and the files it was computed from, for the provider and for re-checks. */
interface Data {
  /** "Release|x64": data of another project configuration is dropped. */
  config: string;
  dump: ProjectDump;
  /** Path keys of the files the evaluation read, and of those whose appearing would change it. */
  inputs: Set<string>;
  awaited: Set<string>;
}

function tail(text: string): string {
  return text.split(/\r?\n/).filter(l => l.trim()).slice(-TAIL_LINES).join('\n');
}

class Stale extends Error {}

/**
 * Computes IntelliSense data for every C++ project of the current solution configuration: from the cache when its
 * inputs did not change, from MSBuild otherwise, a few projects at a time. A new start cancels the running pass;
 * nothing a cancelled pass produced reaches the state or the cache.
 */
export class IntelliSenseEngine {
  private generation = 0;
  private scheduler?: Scheduler<string>;
  private hasher: Hasher;
  private readonly data = new Map<string, Data>();
  private priority: string[] = [];
  private paused = false;
  /** Projects to compute with MSBuild whatever the cache says (Recompute). */
  private readonly forced = new Set<string>();
  /** The latest run of each project: an older one that ends late must not touch its state. */
  private readonly runs = new Map<string, object>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly store: Store, private readonly deps: EngineDeps, private readonly targetsFile: string) {
    this.hasher = new Hasher(deps.read);
  }

  /** The projects of the current configuration: C++, on disk and mapped. */
  private targets(s: AppState): Target[] {
    if (s.phase !== 'ready' || !s.solution || !s.configuration || !s.toolchain) return [];
    return s.solution.projects.flatMap(project => {
      if (project.kind !== 'vcxproj' || !s.projects.get(project.guid)?.exists) return [];
      const mapping = projectConfigFor(s.solution!, project.guid, s.configuration!.name);
      return mapping ? [{ project, configuration: mapping.configuration, platform: mapping.platform }] : [];
    });
  }

  /** Starts a pass over the current state (after every reload); a running pass is cancelled. */
  start(): void {
    this.generation++;
    this.scheduler?.cancel();
    this.hasher = new Hasher(this.deps.read);
    const s = this.store.state;
    const targets = this.targets(s);
    const configs = new Map(targets.map(t => [t.project.guid, `${t.configuration}|${t.platform}`]));
    let dropped = false;
    for (const [guid, d] of this.data) {
      if (configs.get(guid) !== d.config) {
        this.data.delete(guid);
        dropped = true;
      }
    }
    if (dropped) this.fire();
    if (targets.length === 0) {
      this.scheduler = undefined;
      this.store.update(st => ({ ...st, intellisense: { ...idleIntelliSense, projects: new Map() } }));
      return;
    }
    this.store.update(st => ({ ...st, intellisense: { projects: new Map(targets.map(t => [t.project.guid, { status: 'waiting' }])), running: true } }));
    const workers = s.settings.msbuild?.maxParallelism || Math.max(1, Math.floor(this.deps.cores / 2));
    const generation = this.generation;
    const byGuid = new Map(targets.map(t => [t.project.guid, t]));
    this.scheduler = new Scheduler<string>(workers, (guid, signal) => this.compute(generation, byGuid.get(guid)!, signal), guid => guid);
    if (this.paused) this.scheduler.pause();
    const first = this.priority.filter(g => byGuid.has(g));
    this.scheduler.enqueue([...first, ...targets.map(t => t.project.guid).filter(g => !first.includes(g))]);
    this.whenIdle();
  }

  /**
   * Computes one project (or all) again with MSBuild, whatever the cache says; a running one starts over. The cache
   * entries are removed too, and a removal that fails (a locked file) changes nothing.
   */
  recompute(projectGuid?: string): void {
    const targets = this.targets(this.store.state);
    const chosen = projectGuid ? targets.filter(t => t.project.guid === projectGuid) : targets;
    for (const t of chosen) this.forced.add(t.project.guid);
    for (const t of chosen) {
      this.deps.store.remove(cacheFileName(t.project.absPath, t.configuration, t.platform)).catch(e => this.deps.log(`${t.project.name}: the cache entry could not be removed: ${e instanceof Error ? e.message : String(e)}`));
    }
    if (!projectGuid) {
      this.start();
      return;
    }
    this.hasher = new Hasher(this.deps.read);
    this.requeue(chosen.map(t => t.project.guid));
  }

  /**
   * Files changed on disk: the projects computed from them (or waiting for them to appear) are checked against the
   * cache again, and the running ones start over, since MSBuild may have read the file before it changed.
   */
  recheck(files: string[]): void {
    const keys = files.map(pathKey);
    const affected = [...this.data].filter(([, d]) => keys.some(k => d.inputs.has(k) || d.awaited.has(k))).map(([guid]) => guid);
    // A failed project has no inputs to compare: the new file may be the import it missed (a property sheet that a
    // package step such as conan writes on its first build), so it is tried again.
    const failed = [...this.store.state.intellisense.projects]
      .filter(([, p]) => p.status === 'failed' && /\bMSB4019\b/.test(p.message ?? ''))
      .map(([guid]) => guid);
    const guids = [...new Set([...affected, ...failed, ...(this.scheduler?.active ?? [])])];
    if (guids.length === 0) return;
    this.hasher = new Hasher(this.deps.read);
    this.requeue(guids);
  }

  /** These projects (those of the open editors) are computed first, now and in later passes. */
  prioritize(projectGuids: string[]): void {
    this.priority = [...new Set(projectGuids)];
    this.scheduler?.prioritize(this.priority);
  }

  /** A build takes the machine: running MSBuild processes stop and their projects wait. */
  pause(): void {
    this.paused = true;
    this.scheduler?.pause();
  }

  resume(): void {
    this.paused = false;
    this.scheduler?.resume();
  }

  get idle(): Promise<void> {
    return this.scheduler?.idle ?? Promise.resolve();
  }

  dumps(): ReadonlyMap<string, ProjectDump> {
    return new Map([...this.data].map(([guid, d]) => [guid, d.dump]));
  }

  onDidChangeDumps(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  dispose(): void {
    this.generation++;
    this.scheduler?.cancel();
    this.listeners.clear();
  }

  private fire(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private requeue(guids: string[]): void {
    if (!this.scheduler) return;
    this.setProjects(guids, { status: 'waiting' });
    this.store.update(st => ({ ...st, intellisense: { ...st.intellisense, running: true } }));
    this.scheduler.restart(guids);
    this.whenIdle();
  }

  private whenIdle(): void {
    const generation = this.generation;
    const scheduler = this.scheduler!;
    void scheduler.idle.then(() => {
      if (generation !== this.generation || this.scheduler !== scheduler) return;
      this.store.update(st => ({ ...st, intellisense: { ...st.intellisense, running: false } }));
    });
  }

  private setProjects(guids: string[], value: ProjectIntelliSense): void {
    this.store.update(st => {
      const projects = new Map(st.intellisense.projects);
      for (const guid of guids) if (projects.has(guid)) projects.set(guid, value);
      return { ...st, intellisense: { ...st.intellisense, projects } };
    });
  }

  private async compute(generation: number, target: Target, signal: AbortSignal): Promise<void> {
    const guid = target.project.guid;
    const check = () => {
      if (generation !== this.generation || signal.aborted) throw new Stale();
    };
    const s = this.store.state;
    const sln = s.solution!;
    const toolchain = s.toolchain!;
    const projectPath = target.project.absPath;
    const started = this.deps.now();
    const input: DebugPropertiesInput = {
      projectPath,
      config: { configuration: target.configuration, platform: target.platform },
      solutionPath: sln.path,
      targetsFile: this.targetsFile,
      devEnvDir: toolchain.devEnvDir,
      properties: s.settings.msbuild?.properties ?? {},
    };
    const key = cacheKey({
      msbuildPath: toolchain.msbuildPath,
      projectPath,
      configuration: target.configuration,
      platform: target.platform,
      solutionPath: sln.path,
      properties: input.properties,
      environment: s.settings.environment ?? {},
      targetsVersion: INTELLISENSE_TARGETS_VERSION,
    });
    const name = cacheFileName(projectPath, target.configuration, target.platform);
    const config = `${target.configuration}|${target.platform}`;
    const hasher = this.hasher;
    const run = {};
    this.runs.set(guid, run);
    const forced = this.forced.has(guid);
    try {
      const cached = forced ? undefined : await this.deps.store.read(name);
      check();
      if (cached && (await isFresh(cached, key, hasher, this.deps.exists))) {
        check();
        const data = { config, dump: cached.dump, inputs: new Set(cached.inputs.map(i => pathKey(i.path))), awaited: new Set(cached.awaited.map(pathKey)) };
        this.accept(guid, data, { status: 'ready', fromCache: true });
        this.deps.log(`${target.project.name}: from cache`);
        return;
      }
      this.setProjects([guid], { status: 'computing' });
      const env = msbuildEnvironment({ settings: s.settings, folder: s.folder ?? sln.dir, solutionDir: withTrailingBackslash(sln.dir), configuration: s.configuration! }, this.deps.env);
      const result = await this.deps.exec(toolchain.msbuildPath, intellisenseArgs(input), env, { signal, timeoutMs: RUN_TIMEOUT_MS });
      check();
      const dump = result.code === 0 ? parseDump(result.stdout) : undefined;
      if (!dump) {
        this.fail(guid, target.project.name, tail(`${result.stdout}\n${result.stderr}`) || `MSBuild exited with code ${result.code}.`);
        return;
      }
      const out = this.deps.tempFile();
      let xml: string;
      try {
        const pp = await this.deps.exec(toolchain.msbuildPath, preprocessArgs(input, out), env, { signal, timeoutMs: RUN_TIMEOUT_MS });
        check();
        const text = pp.code === 0 ? await this.deps.read(out) : undefined;
        if (!text) {
          this.fail(guid, target.project.name, tail(`${pp.stdout}\n${pp.stderr}`) || 'MSBuild -preprocess wrote nothing.');
          return;
        }
        xml = text.toString('utf8');
      } finally {
        await this.deps.remove(out).catch(() => undefined);
      }
      const { inputs, awaited } = parsePreprocess(xml, { projectPath, solutionDir: withTrailingBackslash(sln.dir) }, this.deps.existsSync);
      const hashed = await Promise.all(inputs.map(async p => ({ path: p, sha1: (await hasher.sha1(p)) ?? '' })));
      check();
      try {
        await this.deps.store.write(name, { key, dump, inputs: hashed, awaited });
      } catch (e) {
        // A locked cache folder (an antivirus scan) costs the next load a recompute, not this result.
        this.deps.log(`${target.project.name}: the cache entry could not be written: ${e instanceof Error ? e.message : String(e)}`);
      }
      check();
      this.forced.delete(guid);
      const seconds = Math.round((this.deps.now() - started) / 100) / 10;
      this.accept(guid, { config, dump, inputs: new Set(inputs.map(pathKey)), awaited: new Set(awaited.map(pathKey)) }, { status: 'ready', fromCache: false, seconds });
      this.deps.log(`${target.project.name}: ${seconds} s`);
    } catch (e) {
      const current = generation === this.generation && this.runs.get(guid) === run;
      if (e instanceof Stale || signal.aborted) {
        // Paused for a build or started over: the project waits for its turn again. A cancelled pass, or a run that
        // a newer one replaced, leaves no trace.
        if (current) this.setProjects([guid], { status: 'waiting' });
        return;
      }
      if (!current) return;
      const killed = (e as { killed?: boolean }).killed;
      const output = e as { stdout?: string; stderr?: string };
      const message = killed
        ? [`MSBuild did not finish in ${RUN_TIMEOUT_MS / 1000} s.`, tail(`${output.stdout ?? ''}\n${output.stderr ?? ''}`)].filter(Boolean).join('\n')
        : e instanceof Error ? e.message : String(e);
      this.fail(guid, target.project.name, message);
    }
  }

  private accept(guid: string, data: Data, status: ProjectIntelliSense): void {
    const before = this.data.get(guid);
    this.data.set(guid, data);
    this.setProjects([guid], status);
    // A reload that finds the same data (from the cache) must not make cpptools ask about every open file again.
    if (!before || before.config !== data.config || JSON.stringify(before.dump) !== JSON.stringify(data.dump)) this.fire();
  }

  private fail(guid: string, name: string, message: string): void {
    this.setProjects([guid], { status: 'failed', message });
    this.deps.log(`${name}: failed, see below\n${message}`);
  }
}
