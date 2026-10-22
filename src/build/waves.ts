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
}

/**
 * Plans a build of the solution (or of one project and what it depends on). The graph has every project the solution
 * configuration builds (Build.0) whose file exists, of any kind; its edges come from the .sln project dependencies
 * and from the ProjectReference items of C++ projects. A dependency on a project outside that set counts through it.
 */
export function planWaves(sln: ParsedSolution, config: SolutionConfig, projects: ReadonlyMap<string, ProjectEntry>, project?: SlnProject): WavePlan {
  const key = (guid: string) => guid.toUpperCase();
  const byKey = new Map(sln.projects.map(p => [key(p.guid), p]));
  const byPath = new Map(sln.projects.map(p => [pathKey(p.absPath), p]));
  const references = (p: SlnProject) => projects.get(p.guid)?.items?.references ?? [];
  const buildable = (p: SlnProject) => {
    if (!projectConfigFor(sln, p.guid, config.name)?.build) return false;
    return p.kind !== 'vcxproj' || projects.get(p.guid)?.exists === true;
  };
  /** Direct dependencies, as keys of solution projects. */
  const direct = new Map<string, string[]>();
  for (const p of sln.projects) {
    const deps = new Set(p.dependencies.map(key).filter(k => byKey.has(k)));
    for (const r of references(p)) {
      const target = byPath.get(pathKey(r));
      if (target) deps.add(key(target.guid));
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

  // Dependencies among the members; a project outside the set passes its own dependencies on.
  const through = new Map<string, Set<string>>();
  const passOn = (k: string, visiting: Set<string>): Set<string> => {
    const known = through.get(k);
    if (known) return known;
    const result = new Set<string>();
    if (visiting.has(k)) return result;
    visiting.add(k);
    for (const d of direct.get(k) ?? []) {
      if (members.has(d)) result.add(d);
      else for (const x of passOn(d, visiting)) result.add(x);
    }
    visiting.delete(k);
    through.set(k, result);
    return result;
  };
  const deps = new Map<string, Set<string>>();
  for (const k of members) {
    const set = new Set<string>();
    for (const d of direct.get(k) ?? []) {
      if (members.has(d)) set.add(d);
      else for (const x of passOn(d, new Set([k]))) set.add(x);
    }
    set.delete(k);
    deps.set(k, set);
  }
  const ordered = sln.projects.filter(p => members.has(key(p.guid)));
  const dependents = (guid: string): string[] => {
    const found = new Set<string>();
    const queue = [key(guid)];
    while (queue.length > 0) {
      const k = queue.shift()!;
      for (const [m, ds] of deps) {
        if (ds.has(k) && !found.has(m)) {
          found.add(m);
          queue.push(m);
        }
      }
    }
    return ordered.filter(p => found.has(key(p.guid))).map(p => p.guid);
  };

  // Kahn's algorithm, one level per wave.
  const waveOf = new Map<string, number>();
  const waves: string[][] = [];
  let remaining = ordered;
  while (remaining.length > 0) {
    const ready = remaining.filter(p => [...deps.get(key(p.guid))!].every(d => waveOf.has(d)));
    if (ready.length === 0) break;
    for (const p of ready) waveOf.set(key(p.guid), waves.length);
    waves.push(ready.map(p => p.guid));
    remaining = remaining.filter(p => !waveOf.has(key(p.guid)));
  }
  if (remaining.length > 0) {
    return { waves: [ordered.map(p => p.guid)], skipReferences: [false], cycle: findCycle(remaining.map(p => key(p.guid)), deps, byKey), dependents };
  }

  const skipReferences = waves.map((wave, n) =>
    wave.every(guid =>
      references(byKey.get(key(guid))!).every(r => {
        const target = byPath.get(pathKey(r));
        const w = target ? waveOf.get(key(target.guid)) : undefined;
        return w !== undefined && w < n;
      }),
    ),
  );
  return { waves, skipReferences, dependents };
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
