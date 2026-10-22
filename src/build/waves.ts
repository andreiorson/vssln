import { cachedFs, ProjectReference, readProjectReferences, ReferenceFs } from '../solution/projectReferences';
import { ParsedSolution, projectConfigFor, SlnProject, SolutionConfig } from '../solution/slnParser';
import type { ProjectEntry } from '../state/store';
import { pathKey } from '../util/paths';

/**
 * The order of a build: wave n holds the projects whose dependencies are all in earlier waves, so each project is
 * read by MSBuild only after everything it depends on was built (a file one project produces and another imports,
 * like conan's conandeps.props, exists by then).
 */
export interface WavePlan {
  /** Project guids, in solution order within a wave. */
  waves: string[][];
  /** Per wave: every ProjectReference of its projects was built in an earlier wave, so MSBuild need not build them. */
  skipReferences: boolean[];
  /** Project names along a dependency cycle (first name repeated at the end); the plan is then one wave. */
  cycle?: string[];
  /** Planned projects that depend on this one, directly or not, in solution order. */
  dependents(guid: string): string[];
  /** References of planned projects that name no project of the solution and could not be evaluated. */
  unread: { guid: string; include: string }[];
}

/**
 * Plans a build of the solution (or of one project and what it depends on). The graph has every project the solution
 * configuration builds (Build.0) whose file exists, of any kind; its edges come from the .sln project dependencies
 * and from the ProjectReference items of C++ projects (`references`, by project guid; a project without an entry has
 * unknown references). A reference names a project by its path, or by its guid when the path needs MSBuild. A
 * dependency on a project outside that set counts through it.
 */
export function planWaves(
  sln: ParsedSolution,
  config: SolutionConfig,
  projects: ReadonlyMap<string, ProjectEntry>,
  references: ReadonlyMap<string, ProjectReference[]>,
  project?: SlnProject,
): WavePlan {
  const key = (guid: string) => guid.toUpperCase();
  const byKey = new Map(sln.projects.map(p => [key(p.guid), p]));
  const byPath = new Map(sln.projects.map(p => [pathKey(p.absPath), p]));
  const referencesOf = (p: SlnProject) => references.get(p.guid) ?? [];
  /** The solution project a reference names. */
  const target = (r: ProjectReference) => (r.path !== undefined ? byPath.get(pathKey(r.path)) : undefined) ?? (r.guid ? byKey.get(key(r.guid)) : undefined);
  const buildable = (p: SlnProject) => {
    if (!projectConfigFor(sln, p.guid, config.name)?.build) return false;
    return p.kind !== 'vcxproj' || projects.get(p.guid)?.exists === true;
  };
  /** Direct dependencies, as keys of solution projects. */
  const direct = new Map<string, string[]>();
  for (const p of sln.projects) {
    const deps = new Set(p.dependencies.map(key).filter(k => byKey.has(k)));
    for (const r of referencesOf(p)) {
      const t = target(r);
      if (t) deps.add(key(t.guid));
    }
    deps.delete(key(p.guid));
    direct.set(key(p.guid), [...deps]);
  }

  // The projects to build: all buildable ones, or the requested project and the buildable ones it needs.
  let members: Set<string>;
  if (project) {
    members = new Set([key(project.guid)]);
    const seen = new Set<string>();
    const visit = (k: string) => {
      if (seen.has(k)) return;
      seen.add(k);
      for (const d of direct.get(k) ?? []) {
        if (buildable(byKey.get(d)!)) members.add(d);
        visit(d);
      }
    };
    visit(key(project.guid));
  } else {
    members = new Set(sln.projects.filter(buildable).map(p => key(p.guid)));
  }

  // Dependencies among the members; a project outside the set passes its own dependencies on. A walk per member
  // through the projects outside the set only (it stops at members), so a cycle among those cannot hide an edge.
  const deps = new Map<string, Set<string>>();
  for (const k of members) {
    const set = new Set<string>();
    const seen = new Set<string>([k]);
    const stack = [...(direct.get(k) ?? [])];
    while (stack.length > 0) {
      const d = stack.pop()!;
      if (seen.has(d)) continue;
      seen.add(d);
      if (members.has(d)) set.add(d);
      else stack.push(...(direct.get(d) ?? []));
    }
    deps.set(k, set);
  }
  const dependentsOf = new Map<string, string[]>();
  for (const [k, ds] of deps) for (const d of ds) dependentsOf.set(d, [...(dependentsOf.get(d) ?? []), k]);
  const ordered = sln.projects.filter(p => members.has(key(p.guid)));
  const dependents = (guid: string): string[] => {
    const found = new Set<string>();
    const queue = [key(guid)];
    while (queue.length > 0) {
      for (const m of dependentsOf.get(queue.shift()!) ?? []) {
        if (found.has(m)) continue;
        found.add(m);
        queue.push(m);
      }
    }
    return ordered.filter(p => found.has(key(p.guid))).map(p => p.guid);
  };

  // Kahn's algorithm, one level per wave.
  const waveOf = new Map<string, number>();
  const waves: string[][] = [];
  const position = new Map(ordered.map((p, i) => [key(p.guid), i]));
  const waiting = new Map([...deps].map(([k, ds]) => [k, ds.size]));
  let ready = ordered.filter(p => waiting.get(key(p.guid)) === 0).map(p => key(p.guid));
  while (ready.length > 0) {
    ready.sort((a, b) => position.get(a)! - position.get(b)!);
    for (const k of ready) waveOf.set(k, waves.length);
    waves.push(ready.map(k => byKey.get(k)!.guid));
    const next: string[] = [];
    for (const k of ready) {
      for (const m of dependentsOf.get(k) ?? []) {
        const left = waiting.get(m)! - 1;
        waiting.set(m, left);
        if (left === 0) next.push(m);
      }
    }
    ready = next;
  }
  const unread = ordered.flatMap(p => referencesOf(p).filter(r => r.path === undefined && !target(r)).map(r => ({ guid: p.guid, include: r.include })));
  const remaining = ordered.filter(p => !waveOf.has(key(p.guid)));
  if (remaining.length > 0) {
    return { waves: [ordered.map(p => p.guid)], skipReferences: [false], cycle: findCycle(remaining.map(p => key(p.guid)), deps, byKey), dependents, unread };
  }

  // Only C++ projects have their references read; any other project may reference something MSBuild must build.
  const skipReferences = waves.map((wave, n) =>
    wave.every(guid => {
      const p = byKey.get(key(guid))!;
      return p.kind === 'vcxproj' && references.has(p.guid) && referencesOf(p).every(r => {
        const t = target(r);
        const w = t ? waveOf.get(key(t.guid)) : undefined;
        return w !== undefined && w < n;
      });
    }),
  );
  return { waves, skipReferences, dependents, unread };
}

/** The ProjectReferences of every C++ project of the solution that exists, by guid, for the solution configuration. */
export async function readSolutionReferences(
  sln: ParsedSolution,
  config: SolutionConfig,
  projects: ReadonlyMap<string, ProjectEntry>,
  build: { properties: Record<string, string>; env: Record<string, string | undefined> },
  fs: ReferenceFs,
): Promise<Map<string, ProjectReference[]>> {
  const files = cachedFs(fs);
  const cpp = sln.projects.filter(p => p.kind === 'vcxproj' && projects.get(p.guid)?.exists === true);
  return new Map(await Promise.all(cpp.map(async (p): Promise<[string, ProjectReference[]]> => {
    const mapping = projectConfigFor(sln, p.guid, config.name);
    const ctx = {
      projectPath: p.absPath,
      solutionPath: sln.path,
      configuration: mapping?.configuration ?? config.configuration,
      platform: mapping?.platform ?? config.platform,
      ...build,
    };
    return [p.guid, await readProjectReferences(ctx, files)];
  })));
}

/** A cycle among the projects left after Kahn's algorithm, as names, the first repeated at the end. */
function findCycle(left: string[], deps: Map<string, Set<string>>, byKey: Map<string, SlnProject>): string[] {
  const leftSet = new Set(left);
  const path: string[] = [];
  const onPath = new Set<string>();
  const done = new Set<string>();
  const walk = (k: string): string[] | undefined => {
    if (onPath.has(k)) return [...path.slice(path.indexOf(k)), k];
    if (done.has(k)) return undefined;
    path.push(k);
    onPath.add(k);
    for (const d of deps.get(k) ?? []) {
      if (!leftSet.has(d)) continue;
      const cycle = walk(d);
      if (cycle) return cycle;
    }
    path.pop();
    onPath.delete(k);
    done.add(k);
    return undefined;
  };
  for (const k of left) {
    const cycle = walk(k);
    if (cycle) return cycle.map(c => byKey.get(c)!.name);
  }
  return [];
}

/** A solution filter (.slnf) that builds these projects of the solution, with its configurations and mapping. */
export function solutionFilter(sln: ParsedSolution, guids: string[]): string {
  const wanted = new Set(guids.map(g => g.toUpperCase()));
  const projects = sln.projects.filter(p => wanted.has(p.guid.toUpperCase())).map(p => p.relPath);
  return JSON.stringify({ solution: { path: sln.path, projects } }, null, 2);
}
