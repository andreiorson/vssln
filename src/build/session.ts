import * as path from 'path';
import { projectConfigFor } from '../solution/slnParser';
import { applyBuildEvent, BuildState, counts, expectedProjects, finishBuild, startBuild } from '../state/build';
import { Store } from '../state/store';
import { samePath } from '../util/paths';
import { BuildRequest, buildArgs } from './args';
import { msbuildEnvironment, withTrailingBackslash } from './environment';
import { BuildEvent, OutputParser } from './outputParser';
import { BuildRunner } from './runner';

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
  const args = buildArgs({ sln, config, toolchain, request, properties: s.settings.msbuild?.properties ?? {}, logFile });
  const expected = request.project ? [request.project.guid] : expectedProjects(sln, config, s.projects);
  const guidByPath = (p: string) => sln.projects.find(x => samePath(x.absPath, p))?.guid;

  deps.store.update(st => ({ ...st, build: startBuild(request, expected, logFile, deps.now()) }));
  // Before the first line: the caller clears its output here.
  deps.onStarted?.();
  deps.write(`${request.action} ${request.project ? request.project.name : path.win32.basename(sln.path)} (${config.name})`);

  const parser = new OutputParser({
    configurationOf: projectPath => {
      const project = sln.projects.find(p => samePath(p.absPath, projectPath));
      const mapping = project && projectConfigFor(sln, project.guid, config.name);
      return mapping ? `${mapping.configuration} ${mapping.platform}` : undefined;
    },
  });
  let result: { exitCode: number | null; cancelled: boolean } = { exitCode: null, cancelled: false };
  try {
    result = await deps.runner.run(
      toolchain.msbuildPath,
      args,
      env,
      line => {
        const parsed = parser.push(line);
        if (parsed.display !== undefined) deps.write(parsed.display);
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
  } catch (e) {
    deps.write(`The build failed to run: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    deps.store.update(st => ({ ...st, build: finishBuild(st.build, result, deps.now()) }));
  }

  if (result.cancelled) deps.write('Build stopped.');
  deps.write(`Build log: ${logFile}`);
  return { started: true, outcome: deps.store.state.build };
}
