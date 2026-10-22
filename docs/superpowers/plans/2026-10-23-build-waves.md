# Build in waves — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Tracking: https://claude.ai/artifact/ALsMZ1NbWk1xEoUUAd158T (VS-48 is the feature; VS-49 … VS-52 are Tasks 1 … 4)

**Goal:** Build and Rebuild run in waves along the dependency graph, so a project that reads a file another project produces (conan's `conandeps.props`) is evaluated only after that project was built.

**Architecture:** The loader reads the `ProjectReference` items of C++ projects (`solution/projectItems`); a pure planner turns the solution, its dependencies and the request into waves and solution filters (`build/waves.ts`); the build session runs one MSBuild per wave through the existing runner, continues the output numbering, skips the dependents of failed projects and writes one summary (`build/session.ts`).

**Tech Stack:** as before. MSBuild solution filters (`.slnf`) need MSBuild 16.7 or newer (Visual Studio 2019 16.7).

**Spec:** [docs/superpowers/specs/2026-10-22-vssln-extension-design.md](../specs/2026-10-22-vssln-extension-design.md) section 6, "Build order in waves".

## Verified (spike, MSBuild 18, 2026-10-23)

- A C++ project that imports `deps.props` without `Exists` and references the producing project fails with `MSB4019` at evaluation in a parallel solution build; the producer runs later.
- Two runs on solution filters (`wave1.slnf` = producer, `wave2.slnf` = consumer) build it from a clean state. Without `BuildProjectReferences=false` the second wave builds the producer again as a reference.

## Global Constraints

- Earlier constraints hold (pure modules without `vscode`, no shell, English MSBuild output, English code and docs).
- Waves only for Build and Rebuild; Clean stays one run on the `.sln`; Rebuild = Clean run + waves of Build.
- Solution filter: `{"solution":{"path":"<absolute .sln>","projects":["<relPath as in the .sln>", …]}}`, file `<logDir>/wave-<n>.slnf`.
- Messages: skipped reason `<Project> failed`; cycle warning `The project dependencies form a cycle (<A> → <B> → <A>); building the solution in one run.`; summary lines `Build succeeded.` / `Build FAILED.`, `    N Warning(s)`, `    N Error(s)`, `Time Elapsed hh:mm:ss.ss`.

## Review Focus

1. A project referenced through a project outside the build set (not in the solution, or not `Build.0`): the transitive edge must hold, and `BuildProjectReferences=false` must not be set for that wave.
2. Stop during wave 2 of 4: nothing of waves 3–4 starts, the state ends `cancelled`.
3. Project numbers and headers in the output across waves; MSBuild instance ids restart in every run.
4. A single-project build whose project has no dependencies: one wave, same as before.
5. A solution with hundreds of projects: planner time, solution filter size, the command line stays short.

---

### Task 1: Project references

**Files:** modify `src/solution/projectItems.ts` (`ProjectItems.references: string[]`, absolute paths), `src/state/loader.ts` unchanged beyond the type; tests in `test/unit/projectItems.test.ts`.

- [ ] Failing tests: `ProjectReference` items become `references` (resolved against the project folder, macros substituted, duplicates once, conditions ignored), and still are not files.
- [ ] Implement; run all unit tests; commit `feat: read project references`.

### Task 2: The wave planner

**Files:** create `src/build/waves.ts`; test `test/unit/waves.test.ts`.

**Interfaces:**
```ts
export interface WavePlan { waves: string[][]; /* guids */ cycle?: string[]; /* project names */ skipReferences: boolean[] }
export function planWaves(sln: ParsedSolution, config: SolutionConfig, projects: ReadonlyMap<string, ProjectEntry>, project?: SlnProject): WavePlan
export function dependentsOf(plan: WavePlan, failed: string, graph: …): string[]   // or a graph object with dependents()
export function solutionFilter(sln: ParsedSolution, guids: string[]): string        // JSON text
```
- [ ] Failing tests: a chain A→B→C gives three waves; independent projects share a wave; `.sln` dependencies and references both count; an edge through a project outside the build set is kept; a cycle gives `cycle` and one wave of everything; a single-project request takes its closure; a non-C++ project with `Build.0` is in the plan; `skipReferences` is false for a wave whose project references something outside the earlier waves; dependents of a failed project are found transitively; the filter lists `relPath`s; 1 000 projects plan in under 200 ms.
- [ ] Implement; commit `feat: plan builds in waves along the dependency graph`.

### Task 3: The session runs waves

**Files:** modify `src/build/session.ts`, `src/build/args.ts` (`buildArgs` gains `solutionFile?` and `extraProperties`/`appendLog`), `src/build/outputParser.ts` (`newRun()`: forget instance ids, keep numbers; summary lines reported as `summary: true`), `src/state/build.ts` (`skipProjects(b, guids, reason)`); tests in `test/unit/session.test.ts`, `test/unit/outputParser.test.ts`, `test/unit/buildArgs.test.ts`.

- [ ] Failing tests (fake runner returning captured logs per run): Build of a three-level plan runs three MSBuild calls on `wave-1..3.slnf` in order with `-p:BuildProjectReferences=false` where planned and the log appended after the first; a failing project in wave 1 marks its dependents `skipped` with `Math failed` and wave 2 runs the rest; Stop in wave 2 runs nothing more and ends `cancelled`; Rebuild runs one Clean on the `.sln` first; Clean stays one call; a cycle runs one call and writes the warning; numbers continue across waves (`3>` in wave 2 after `1>`,`2>` in wave 1); MSBuild summaries are not written, one summary at the end; a single-project build without dependencies is one call as before.
- [ ] Implement; commit `feat: build and rebuild in waves`.

### Task 4: Sample, IntelliSense retry, docs, engine test

**Files:** `samples/Engine` (a `Tools/Deps` utility project that writes `out/generated/deps.props`, imported without a condition by `Core/Platform`, which references it; Deps listed last in the `.sln`), `src/intellisense/engine.ts` (`recheck` also retries failed projects), `docs/manual-checklist.md`, `test/engine/build.test.ts` (and counts in existing tests), `test/unit/intellisenseEngine.test.ts`.

- [ ] Failing unit test: a failed project is computed again by `recheck` (its missing import appeared).
- [ ] Engine test (written; run only with the user's go): after Clean and deleting `out/generated/deps.props`, Build succeeds and Deps finishes before Platform starts.
- [ ] Checklist lines; commit `test: a producer project in the sample solution`.
