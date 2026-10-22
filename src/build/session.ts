import * as path from 'path';
import { projectConfigFor } from '../solution/slnParser';
import { applyBuildEvent, BuildState, counts, expectedProjects, finishBuild, skipProjects, startBuild } from '../state/build';
import { Store } from '../state/store';
import { samePath } from '../util/paths';
import { BuildRequest, buildArgs } from './args';
import { msbuildEnvironment, withTrailingBackslash } from './environment';
import { BuildEvent, OutputParser } from './outputParser';
import { BuildRunner } from './runner';
import { planWaves, solutionFilter, WavePlan } from './waves';

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
}

type RunResult = { exitCode: number | null; cancelled: boolean };

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
  const plan = request.action === 'Clean' ? undefined : planWaves(sln, config, s.projects, request.project);
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
            deps.write(`${n === undefined ? '' : `${n}>`}${path.win32.basename(e.path).replace(/\.vcxproj$/i, '')}: ${e.failed ? 'FAILED' : 'succeeded'}`);
          }
        }
        if (parsed.events.length === 0) return;
        deps.store.update(st => {
          let build = st.build;
          for (const e of parsed.events) build = applyBuildEvent(build, e, guidByPath, deps.now());
          return { ...st, build };
        });
      },
      message => deps.write(`MSBuild could not start: ${message}`),
    );
  };

  /** The waves in order; the projects that depend on a failed one are not built. */
  const runWaves = async (plan: WavePlan): Promise<RunResult> => {
    let ok = true;
    let appendLog = false;
    if (request.action === 'Rebuild') {
      const cleaned = await run(buildArgs({ sln, config, toolchain, request: { ...request, action: 'Clean' }, properties, logFile }));
      if (cleaned.cancelled || cleaned.exitCode !== 0) return cleaned;
      appendLog = true;
    }
    const skipped = new Set<string>();
    for (let i = 0; i < plan.waves.length; i++) {
      const wave = plan.waves[i].filter(g => !skipped.has(g));
      if (wave.length === 0) continue;
      const file = path.win32.join(deps.logDir, `wave-${i + 1}.slnf`);
      await deps.writeFile(file, solutionFilter(sln, wave));
      deps.write(`Wave ${i + 1}/${plan.waves.length}: ${wave.map(nameOf).join(', ')}`);
      const r = await run(buildArgs({
        sln, config, toolchain, request: { action: 'Build' }, properties, logFile, solutionFile: file, appendLog,
        ...(plan.skipReferences[i] ? { extraProperties: { BuildProjectReferences: 'false' } } : {}),
      }));
      appendLog = true;
      if (r.cancelled) return r;
      if (r.exitCode === 0) continue;
      ok = false;
      // The failed projects of the wave; when MSBuild failed without naming one (a project type we do not follow),
      // every project of the wave that did not succeed.
      const status = (g: string) => deps.store.state.build.projects.get(g)?.status;
      const failed = wave.filter(g => status(g) === 'failed');
      for (const f of failed.length > 0 ? failed : wave.filter(g => status(g) !== 'succeeded')) {
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
    result = waves ? await runWaves(waves) : await run(buildArgs({ sln, config, toolchain, request, properties, logFile }));
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
