import { expect, test } from 'vitest';
import { planWaves, solutionFilter } from '../../src/build/waves';
import { parseSln } from '../../src/solution/slnParser';
import { ProjectEntry } from '../../src/state/store';

const CPP = '{8BC9CEB8-8B4A-11D0-8D11-00A0C91BC942}';
const CS = '{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}';
const guid = (n: number) => `{A0000000-0000-0000-0000-${String(n).padStart(12, '0')}}`;

interface P {
  name: string;
  /** .sln project dependencies, by name. */
  deps?: string[];
  /** ProjectReference items, by name or by a path outside the solution. */
  refs?: string[];
  build?: boolean;
  csharp?: boolean;
  missing?: boolean;
}

function solution(list: P[]) {
  const n = (name: string) => list.findIndex(p => p.name === name) + 1;
  const rel = (p: P) => `${p.name}\\${p.name}.${p.csharp ? 'csproj' : 'vcxproj'}`;
  const lines = ['Microsoft Visual Studio Solution File, Format Version 12.00'];
  list.forEach((p, i) => {
    lines.push(`Project("${p.csharp ? CS : CPP}") = "${p.name}", "${rel(p)}", "${guid(i + 1)}"`);
    if (p.deps?.length) {
      lines.push('\tProjectSection(ProjectDependencies) = postProject');
      for (const d of p.deps) lines.push(`\t\t${guid(n(d))} = ${guid(n(d))}`);
      lines.push('\tEndProjectSection');
    }
    lines.push('EndProject');
  });
  lines.push('Global', '\tGlobalSection(SolutionConfigurationPlatforms) = preSolution', '\t\tRelease|x64 = Release|x64', '\tEndGlobalSection');
  lines.push('\tGlobalSection(ProjectConfigurationPlatforms) = postSolution');
  list.forEach((p, i) => {
    lines.push(`\t\t${guid(i + 1)}.Release|x64.ActiveCfg = Release|x64`);
    if (p.build !== false) lines.push(`\t\t${guid(i + 1)}.Release|x64.Build.0 = Release|x64`);
  });
  lines.push('\tEndGlobalSection', 'EndGlobal');
  const sln = parseSln(lines.join('\r\n'), 'C:\\s\\S.sln');
  const projects = new Map<string, ProjectEntry>(
    list.flatMap((p, i) => (p.csharp ? [] : [[guid(i + 1), p.missing ? { exists: false } : {
      exists: true,
      items: { items: [], filters: [], references: (p.refs ?? []).map(r => (r.includes('\\') ? r : `C:\\s\\${r}\\${r}.vcxproj`)) },
    }]] as [string, ProjectEntry][])),
  );
  const names = (guids: string[]) => guids.map(g => sln.projects.find(p => p.guid.toUpperCase() === g.toUpperCase())!.name);
  return { sln, config: sln.configurations[0], projects, names, byName: (name: string) => sln.projects.find(p => p.name === name)! };
}

test('a chain gives one wave per level; independent projects share a wave in solution order', () => {
  const s = solution([{ name: 'App', refs: ['Lib'] }, { name: 'Tool' }, { name: 'Lib', deps: ['Conan'] }, { name: 'Conan' }]);
  const plan = planWaves(s.sln, s.config, s.projects);
  expect(plan.waves.map(s.names)).toEqual([['Tool', 'Conan'], ['Lib'], ['App']]);
  expect(plan.cycle).toBeUndefined();
});

test('every project of the solution configuration is planned, of any kind; not built and missing ones are not', () => {
  const s = solution([{ name: 'App', deps: ['Gen'] }, { name: 'Gen', csharp: true }, { name: 'Off', build: false }, { name: 'Gone', missing: true }]);
  expect(planWaves(s.sln, s.config, s.projects).waves.map(s.names)).toEqual([['Gen'], ['App']]);
});

test('a dependency through a project outside the build set still orders the build', () => {
  const s = solution([{ name: 'App', refs: ['Mid'] }, { name: 'Mid', build: false, refs: ['Conan'] }, { name: 'Conan' }]);
  const plan = planWaves(s.sln, s.config, s.projects);
  expect(plan.waves.map(s.names)).toEqual([['Conan'], ['App']]);
  // App references Mid, which no wave builds: its references must still be built by MSBuild.
  expect(plan.skipReferences).toEqual([true, false]);
});

test('references are skipped only when every one was built in an earlier wave', () => {
  const s = solution([{ name: 'App', refs: ['Lib'] }, { name: 'Lib', refs: ['C:\\elsewhere\\Ext.vcxproj'] }, { name: 'Other', refs: ['Lib'] }]);
  const plan = planWaves(s.sln, s.config, s.projects);
  expect(plan.waves.map(s.names)).toEqual([['Lib'], ['App', 'Other']]);
  expect(plan.skipReferences).toEqual([false, true]);
});

test('a wave with a project whose references are unknown (not C++) builds references', () => {
  const s = solution([{ name: 'App', deps: ['Tool'] }, { name: 'Tool', csharp: true }]);
  const plan = planWaves(s.sln, s.config, s.projects);
  expect(plan.waves.map(s.names)).toEqual([['Tool'], ['App']]);
  expect(plan.skipReferences).toEqual([false, true]);
});

test('a cycle builds everything in one wave and names the cycle', () => {
  const s = solution([{ name: 'A', deps: ['B'] }, { name: 'B', refs: ['C'] }, { name: 'C', deps: ['A'] }, { name: 'D' }]);
  const plan = planWaves(s.sln, s.config, s.projects);
  expect(plan.waves.map(s.names)).toEqual([['A', 'B', 'C', 'D']]);
  expect(plan.cycle).toEqual(['A', 'B', 'C', 'A']);
  expect(plan.skipReferences).toEqual([false]);
});

test('a single project takes itself and what it depends on', () => {
  const s = solution([{ name: 'App', refs: ['Lib'] }, { name: 'Lib', deps: ['Conan'] }, { name: 'Conan' }, { name: 'Tool' }]);
  expect(planWaves(s.sln, s.config, s.projects, s.byName('Lib')).waves.map(s.names)).toEqual([['Conan'], ['Lib']]);
  expect(planWaves(s.sln, s.config, s.projects, s.byName('Tool')).waves.map(s.names)).toEqual([['Tool']]);
});

test('the dependents of a failed project, transitively', () => {
  const s = solution([{ name: 'App', refs: ['Lib'] }, { name: 'Lib', deps: ['Conan'] }, { name: 'Conan' }, { name: 'Tool' }]);
  const plan = planWaves(s.sln, s.config, s.projects);
  expect(s.names(plan.dependents(s.byName('Conan').guid))).toEqual(['App', 'Lib']);
  expect(plan.dependents(s.byName('Tool').guid)).toEqual([]);
});

test('a solution filter lists the projects as the solution writes them', () => {
  const s = solution([{ name: 'App' }, { name: 'Lib' }]);
  expect(JSON.parse(solutionFilter(s.sln, [s.byName('Lib').guid]))).toEqual({ solution: { path: 'C:\\s\\S.sln', projects: ['Lib\\Lib.vcxproj'] } });
});

test('a thousand projects are planned quickly', () => {
  const list: P[] = Array.from({ length: 1000 }, (_, i) => ({ name: `P${i}`, refs: i > 0 ? [`P${i - 1}`, `P${Math.floor(i / 2)}`].filter(r => r !== `P${i}`) : [] }));
  const s = solution(list);
  const start = Date.now();
  const plan = planWaves(s.sln, s.config, s.projects);
  expect(plan.waves).toHaveLength(1000);
  expect(Date.now() - start).toBeLessThan(500);
});
