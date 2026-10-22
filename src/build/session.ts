import * as path from 'path';
import { ReferenceFs } from '../solution/projectReferences';
import { projectConfigFor } from '../solution/slnParser';
import { applyBuildEvent, BuildState, counts, expectedProjects, finishBuild, skipProjects, startBuild } from '../state/build';
import { Store } from '../state/store';
import { samePath } from '../util/paths';
import { BuildRequest, buildArgs } from './args';
import { msbuildEnvironment, withTrailingBackslash } from './environment';
import { BuildEvent, OutputParser } from './outputParser';
import { BuildRunner } from './runner';
import { planWaves, readSolutionReferences, solutionFilter, WavePlan } from './waves';

export interface SessionDeps {
  store: Store;
  runner: BuildRunner;
  now(): number;
  logDir: string;
  env: Record<string, string | undefined>;
  /** Terminal sink for the lines the user sees. */
  write(line: string): void;
  /** Called once, when the build has really started (not for a refused request). */
  onStarted?(): void;
  /** Each error or warning of the build, once (the final summary repeats are not passed on). */
  onDiagnostic?(e: Extract<BuildEvent, { kind: 'diagnostic' }>): void;
  /** Writes a solution filter of a wave (in logDir). */
  writeFile(path: string, text: string): Promise<void>;
  /** Reads the project files and the sheets they import, for the ProjectReferences that order the waves. */
  projectFiles: ReferenceFs;
}

type RunResult = { exitCode: number | null; cancelled: boolean };

/**
 * Solution filters (.slnf) need MSBuild 16.7. The version comes from vswhere; an explicit msbuildPath has none, and
 * only the folder of Visual Studio 2017 (MSBuild\15.0) is known to be too old there.
 */
export function solutionFiltersSupported(toolchain: { installationVersion: string; msbuildPath: string }): boolean {
  const m = /^(\d+)\.(\d+)/.exec(toolchain.installationVersion);
  if (m) return Number(m[1]) > 16 || (Number(m[1]) === 16 && Number(m[2]) >= 7);
  return !/[\\/]MSBuild[\\/]15\.0[\\/]/i.test(toolchain.msbuildPath);
}

/** "00:01:02.35", as MSBuild prints its elapsed time. */
function elapsed(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  return `${hh}:${mm}:${(s % 60).toFixed(2).padStart(5, '0')}`;
}

export type SessionResult = { started: false; reason: string } | { started: true; outcome: BuildState };

export const NO_TOOLCHAIN = 'Visual Studio with MSBuild was not found. Use Configure toolchain to set it up.';

/** The reason a build cannot start now, or undefined when it can. */
export function cannotBuild(s: Store['state'], runner: BuildRunner): string | undefined {
  if (s.phase === 'loading') return 'The solution is still loading.';
  if (s.phase !== 'ready' || !s.solution || !s.configuration) return 'No solution is loaded. Open a folder with a .sln file.';
  if (!s.toolchain) return NO_TOOLCHAIN;
  if (runner.running || s.build.status === 'running') return 'A build is already running.';
  return undefined;
}

/** Runs one MSBuild build of the loaded solution and keeps the store's build state current. */
export async function runBuild(deps: SessionDeps, request: BuildRequest): Promise<SessionResult> {
  const s = deps.store.state;
  const reason = cannotBuild(s, deps.runner);
  if (reason) return { started: false, reason };
  const sln = s.solution!;
  const config = s.configuration!;
  const toolchain = s.toolchain!;

  const env = msbuildEnvironment({ settings: s.settings, folder: s.folder ?? sln.dir, solutionDir: withTrailingBackslash(sln.dir), configuration: config }, deps.env);

  const logFile = path.win32.join(deps.logDir, 'build.log');
  const properties = s.settings.msbuild?.properties ?? {};
  // Build and Rebuild go in waves along the dependency graph, so that every project is read by MSBuild only after
  // the projects it depends on were built (spec section 6). One wave, or a cycle, is the plain run as before.
  const wavesWanted = request.action !== 'Clean' && s.settings.build?.waves !== false;
  const filtersSupported = solutionFiltersSupported(toolchain);
  // From here a Stop applies to this build, also while the references are read.
  deps.runner.begin();
  let plan: WavePlan | undefined;
  if (wavesWanted && filtersSupported) {
    const references = await readSolutionReferences(sln, config, s.projects, { properties, env }, deps.projectFiles);
    // Reading takes a moment, in which another build may have started.
    const late = cannotBuild(deps.store.state, deps.runner);
    if (late) return { started: false, reason: late };
    plan = planWaves(sln, config, s.projects, references, request.project);
  }
  const waves = plan && !plan.cycle && plan.waves.length > 1 ? plan : undefined;
  const isCpp = (guid: string) => sln.projects.some(p => p.guid === guid && p.kind === 'vcxproj');
  const expected = waves && request.project
    ? waves.waves.flat().filter(isCpp)
    : request.project ? [request.project.guid] : expectedProjects(sln, config, s.projects);
  const guidByPath = (p: string) => sln.projects.find(x => samePath(x.absPath, p))?.guid;
  const nameOf = (guid: string) => sln.projects.find(p => p.guid === guid)?.name ?? guid;
  const started = deps.now();

  deps.store.update(st => ({ ...st, build: startBuild(request, expected, logFile, started) }));
  // Before the first line: the caller clears its output here.
  deps.onStarted?.();
  deps.write(`${request.action} ${request.project ? request.project.name : path.win32.basename(sln.path)} (${config.name})`);
  if (plan?.cycle) deps.write(`The project dependencies form a cycle (${plan.cycle.join(' → ')}); building the solution in one run.`);
  for (const u of plan?.unread ?? []) deps.write(`${nameOf(u.guid)}: the project reference ${u.include} could not be read without MSBuild; the build order does not include it.`);
  if (wavesWanted && !filtersSupported) deps.write('Building the solution in one run: building in waves needs MSBuild 16.7 or newer (Visual Studio 2019 16.7).');
  /** Project results of all runs, by guid (true: failed), whatever the project type. */
  const outcomes = new Map<string, boolean>();
  let startFailed = false;

  const parser = new OutputParser({
    configurationOf: projectPath => {
      const project = sln.projects.find(p => samePath(p.absPath, projectPath));
      const mapping = project && projectConfigFor(sln, project.guid, config.name);
      return mapping ? `${mapping.configuration} ${mapping.platform}` : undefined;
    },
    counts: target => counts(request.action, target),
  });
  /** One MSBuild run; in waves, MSBuild's own summary is left out (the build writes one at its end). */
  const run = (args: string[]): Promise<RunResult> => {
    parser.newRun();
    return deps.runner.run(
      toolchain.msbuildPath,
      args,
      env,
      line => {
        const parsed = parser.push(line);
        if (parsed.display !== undefined && !(waves && parsed.summary)) deps.write(parsed.display);
        for (const e of parsed.events) {
          if (e.kind === 'diagnostic') deps.onDiagnostic?.(e);
          if (e.kind === 'projectFinished' && counts(request.action, e.target)) {
            const n = parser.numberOf(e.path);
            deps.write(`${n === undefined ? '' : `${n}>`}${path.win32.basename(e.path).replace(/\.[a-z]*proj$/i, '')}: ${e.failed ? 'FAILED' : 'succeeded'}`);
            const guid = guidByPath(e.path);
            if (guid) outcomes.set(guid, e.failed || outcomes.get(guid) === true);
          }
        }
        // The panel follows C++ projects; other project types count only for the waves (outcomes above).
        const tracked = parsed.events.filter(e => e.kind === 'diagnostic' || /\.vcxproj$/i.test(e.path));
        if (tracked.length === 0) return;
        deps.store.update(st => {
          let build = st.build;
          for (const e of tracked) build = applyBuildEvent(build, e, guidByPath, deps.now());
          return { ...st, build };
        });
      },
      message => {
        startFailed = true;
        deps.write(`MSBuild could not start: ${message}`);
      },
    );
  };

  /** The waves in order; the projects that depend on a failed one are not built. */
  const runWaves = async (plan: WavePlan): Promise<RunResult> => {
    let ok = true;
    let appendLog = false;
    const skipped = new Set<string>();
    for (let i = 0; i < plan.waves.length; i++) {
      const wave = plan.waves[i].filter(g => !skipped.has(g));
      if (wave.length === 0) continue;
      const file = path.win32.join(deps.logDir, `wave-${i + 1}.slnf`);
      await deps.writeFile(file, solutionFilter(sln, wave));
      // A Stop while no MSBuild ran (between two waves) ends the build too.
      if (deps.runner.stopped) return { exitCode: null, cancelled: true };
      deps.write(`Wave ${i + 1}/${plan.waves.length}: ${wave.map(nameOf).join(', ')}`);
      // Rebuild rebuilds each wave: a Clean of everything first would read every project and fail the same way.
      const r = await run(buildArgs({
        sln, config, toolchain, request: { action: request.action }, properties, logFile, solutionFile: file, appendLog,
        ...(plan.skipReferences[i] ? { extraProperties: { BuildProjectReferences: 'false' } } : {}),
      }));
      appendLog = true;
      if (r.cancelled) return r;
      if (startFailed) return r;
      if (r.exitCode === 0) continue;
      ok = false;
      // The failed projects of the wave; when MSBuild failed without naming one, every project of the wave that did
      // not succeed.
      const failed = wave.filter(g => outcomes.get(g) === true);
      for (const f of failed.length > 0 ? failed : wave.filter(g => outcomes.get(g) !== false)) {
        const dependents = plan.dependents(f).filter(g => !skipped.has(g));
        if (dependents.length === 0) continue;
        for (const g of dependents) skipped.add(g);
        deps.store.update(st => ({ ...st, build: skipProjects(st.build, dependents, `${nameOf(f)} failed`) }));
        deps.write(`Not built because ${nameOf(f)} failed: ${dependents.map(nameOf).join(', ')}`);
      }
    }
    return { exitCode: ok ? 0 : 1, cancelled: false };
  };

  let result: RunResult = { exitCode: null, cancelled: false };
  try {
    if (deps.runner.stopped) result = { exitCode: null, cancelled: true };
    else result = waves ? await runWaves(waves) : await run(buildArgs({ sln, config, toolchain, request, properties, logFile }));
  } catch (e) {
    deps.write(`The build failed to run: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    deps.store.update(st => ({ ...st, build: finishBuild(st.build, result, deps.now()) }));
  }

  if (waves && !result.cancelled) {
    // One summary for all the runs, in MSBuild's words.
    const b = deps.store.state.build;
    deps.write('');
    deps.write(b.status === 'succeeded' ? 'Build succeeded.' : 'Build FAILED.');
    deps.write(`    ${b.warnings} Warning(s)`);
    deps.write(`    ${b.errors} Error(s)`);
    deps.write(`Time Elapsed ${elapsed(deps.now() - started)}`);
  }
  if (result.cancelled) deps.write('Build stopped.');
  deps.write(`Build log: ${logFile}`);
  return { started: true, outcome: deps.store.state.build };
}
