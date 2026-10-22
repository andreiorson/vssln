import * as path from 'path';
import { expandVariables } from '../settings/resolver';
import { applyBuildEvent, BuildState, expectedProjects, finishBuild, startBuild } from '../state/build';
import { Store } from '../state/store';
import { samePath } from '../util/paths';
import { BuildRequest, buildArgs } from './args';
import { OutputParser } from './outputParser';
import { BuildRunner } from './runner';

export interface SessionDeps {
  store: Store;
  runner: BuildRunner;
  now(): number;
  logDir: string;
  env: Record<string, string | undefined>;
  /** Terminal sink for the lines the user sees. */
  write(line: string): void;
}

export type SessionResult = { started: false; reason: string } | { started: true; outcome: BuildState };

/** Runs one MSBuild build of the loaded solution and keeps the store's build state current. */
export async function runBuild(deps: SessionDeps, request: BuildRequest): Promise<SessionResult> {
  const s = deps.store.state;
  if (s.phase !== 'ready' || !s.solution || !s.configuration) {
    return { started: false, reason: 'No solution is loaded. Open a folder with a .sln file.' };
  }
  if (!s.toolchain) {
    return { started: false, reason: 'Visual Studio with MSBuild was not found. Use Configure toolchain to set it up.' };
  }
  if (deps.runner.running || s.build.status === 'running') {
    return { started: false, reason: 'A build is already running.' };
  }

  const { solution: sln, configuration: config, toolchain } = s;
  const folder = s.folder ?? sln.dir;
  const env: Record<string, string | undefined> = { ...deps.env };
  for (const [key, value] of Object.entries(s.settings.environment ?? {})) {
    env[key] = expandVariables(value, { workspaceFolder: folder, solutionDir: sln.dir, configuration: config.configuration, platform: config.platform, env: deps.env }).value;
  }
  // The output parser reads English MSBuild messages; localized Visual Studio installs would print others.
  env.VSLANG = '1033';

  const logFile = path.win32.join(deps.logDir, 'build.log');
  const args = buildArgs({ sln, config, toolchain, request, properties: s.settings.msbuild?.properties ?? {}, logFile });
  const expected = request.project ? [request.project.guid] : expectedProjects(sln, config, s.projects);
  const guidByPath = (p: string) => sln.projects.find(x => samePath(x.absPath, p))?.guid;

  deps.write(`${request.action} ${request.project ? request.project.name : path.win32.basename(sln.path)} (${config.name})`);
  deps.store.update(st => ({ ...st, build: startBuild(request, expected, logFile, deps.now()) }));

  const parser = new OutputParser();
  const result = await deps.runner.run(toolchain.msbuildPath, args, env, line => {
    const parsed = parser.push(line);
    if (parsed.display !== undefined) deps.write(parsed.display);
    if (parsed.events.length === 0) return;
    deps.store.update(st => {
      let build = st.build;
      for (const e of parsed.events) build = applyBuildEvent(build, e, guidByPath, deps.now());
      return { ...st, build };
    });
  });

  deps.store.update(st => ({ ...st, build: finishBuild(st.build, result, deps.now()) }));
  deps.write(`Build log: ${logFile}`);
  return { started: true, outcome: deps.store.state.build };
}
