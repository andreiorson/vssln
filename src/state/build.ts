import { BuildAction, BuildRequest } from '../build/args';
import { BuildEvent, WorkTarget } from '../build/outputParser';
import { ParsedSolution, projectConfigFor, SolutionConfig } from '../solution/slnParser';
import type { ProjectEntry } from './store';

export type ProjectBuildStatus = 'waiting' | 'building' | 'succeeded' | 'failed' | 'skipped';

export interface ProjectBuild {
  status: ProjectBuildStatus;
  errors: number;
  warnings: number;
  /** First diagnostics of the project, for its tooltip. */
  messages: string[];
  startedAt?: number;
  finishedAt?: number;
}

export interface BuildState {
  status: 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  action?: BuildAction;
  /** Set for a single-project build. */
  projectName?: string;
  startedAt?: number;
  finishedAt?: number;
  total: number;
  done: number;
  errors: number;
  warnings: number;
  /** By project guid. */
  projects: Map<string, ProjectBuild>;
  logFile?: string;
}

const MAX_MESSAGES = 5;

export const idleBuild: BuildState = { status: 'idle', total: 0, done: 0, errors: 0, warnings: 0, projects: new Map() };

/** C++ projects the solution configuration builds (Build.0) and whose file exists. */
export function expectedProjects(sln: ParsedSolution, config: SolutionConfig, projects: Map<string, ProjectEntry>): string[] {
  return sln.projects
    .filter(p => p.kind === 'vcxproj' && projects.get(p.guid)?.exists && projectConfigFor(sln, p.guid, config.name)?.build)
    .map(p => p.guid);
}

export function startBuild(request: BuildRequest, expectedGuids: string[], logFile: string, now: number): BuildState {
  const projects = new Map<string, ProjectBuild>(expectedGuids.map(g => [g, { status: 'waiting', errors: 0, warnings: 0, messages: [] }]));
  return {
    status: 'running',
    action: request.action,
    ...(request.project ? { projectName: request.project.name } : {}),
    startedAt: now,
    total: projects.size,
    done: 0,
    errors: 0,
    warnings: 0,
    projects,
    logFile,
  };
}

/** A Rebuild also cleans references with a separate Clean call; only the target that does the requested work counts. */
export function counts(action: BuildAction | undefined, target: WorkTarget): boolean {
  return action === 'Clean' ? target === 'Clean' : target !== 'Clean';
}

export function applyBuildEvent(b: BuildState, e: BuildEvent, guidByPath: (path: string) => string | undefined, now: number): BuildState {
  const target = e.kind === 'diagnostic' ? e.projectPath : e.path;
  const guid = target ? guidByPath(target) : undefined;

  if (e.kind === 'diagnostic') {
    const next = { ...b, [e.severity === 'error' ? 'errors' : 'warnings']: b[e.severity === 'error' ? 'errors' : 'warnings'] + 1 };
    const project = guid ? b.projects.get(guid) : undefined;
    if (!project || !guid) return next;
    const projects = new Map(b.projects);
    projects.set(guid, {
      ...project,
      ...(e.severity === 'error' ? { errors: project.errors + 1 } : { warnings: project.warnings + 1 }),
      messages: project.messages.length < MAX_MESSAGES ? [...project.messages, e.text] : project.messages,
    });
    return { ...next, projects };
  }

  if (!guid || !counts(b.action, e.target)) return b;
  const projects = new Map(b.projects);
  const current = projects.get(guid) ?? { status: 'waiting' as const, errors: 0, warnings: 0, messages: [] };
  let { total, done } = b;
  if (!b.projects.has(guid)) total++;

  if (e.kind === 'projectStarted') {
    if (current.status === 'succeeded' || current.status === 'failed') return b;
    projects.set(guid, { ...current, status: 'building', startedAt: current.startedAt ?? now });
  } else {
    if (current.status !== 'succeeded' && current.status !== 'failed') done++;
    projects.set(guid, { ...current, status: e.failed ? 'failed' : 'succeeded', finishedAt: now });
  }
  return { ...b, projects, total, done };
}

/**
 * The build state to keep across a reload: a running build always, a finished one only while it still describes
 * the same solution and configuration.
 */
export function carryBuild(
  prev: { solution?: ParsedSolution; configuration?: SolutionConfig; build: BuildState },
  next: { solution?: ParsedSolution; configuration?: SolutionConfig },
): BuildState {
  if (prev.build.status === 'running') return prev.build;
  const same =
    prev.solution !== undefined && next.solution !== undefined &&
    prev.solution.path.toLowerCase() === next.solution.path.toLowerCase() &&
    prev.configuration?.name === next.configuration?.name;
  return same ? prev.build : idleBuild;
}

/** Marks projects that will not be built (a project they depend on failed) as skipped, with the reason as message. */
export function skipProjects(b: BuildState, guids: string[], reason: string): BuildState {
  const projects = new Map(b.projects);
  for (const guid of guids) {
    const p = projects.get(guid);
    if (p && (p.status === 'waiting' || p.status === 'building')) projects.set(guid, { ...p, status: 'skipped', messages: [reason] });
  }
  return { ...b, projects };
}

export function finishBuild(b: BuildState, outcome: { exitCode: number | null; cancelled: boolean }, now: number): BuildState {
  const projects = new Map<string, ProjectBuild>();
  for (const [guid, p] of b.projects) {
    projects.set(guid, p.status === 'waiting' || p.status === 'building' ? { ...p, status: 'skipped' } : p);
  }
  const status = outcome.cancelled ? 'cancelled' : outcome.exitCode === 0 ? 'succeeded' : 'failed';
  return { ...b, status, finishedAt: now, projects };
}
