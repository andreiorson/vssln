# Phase 4: IntelliSense — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Tracking: https://claude.ai/artifact/ALsMZ1NbWk1xEoUUAd158T (VS-16 is the phase; VS-39 … VS-46 are Tasks 1 … 8)

**Goal:** Every file of the loaded solution gets the compiler flags of the real build in the C/C++ extension's IntelliSense, computed by MSBuild in design-time mode, cached, and kept fresh.

**Architecture:** Pure modules under `src/intellisense/` read MSBuild output (`dump`, `preprocess`), map command lines to cpptools configurations (`configuration`), decide freshness (`cache`), order the work (`scheduler`) and answer "which configuration for this file" (`fileIndex`). An engine (`intellisense/engine.ts`, injected runner, cache store and clock) runs passes and reports into `AppState.intellisense`. The VS Code layer registers the cpptools provider, shows progress and pauses the pass during builds.

**Tech Stack:** as before; `vscode-cpptools` (types and `getCppToolsApi`) becomes a dependency.

**Spec:** [docs/superpowers/specs/2026-10-22-vssln-extension-design.md](../specs/2026-10-22-vssln-extension-design.md) section 8 (8.1 verified facts, 8.2 design), and the brief [README.md](../../../README.md) sections 4 to 8.

## Global Constraints

- Earlier constraints hold: no machine values in code, pure modules without `vscode`, no shell for child processes, `DOTNET_CLI_UI_LANGUAGE=en-US` + `VSLANG=1033`, English code and docs.
- Design-time properties: `DesignTimeBuild=true`, `BuildingInsideVisualStudio=true`, `SkipCompilerExecution=true`, `ProvideCommandLineArgs=true`, plus the build context of `debugPropertiesArgs` (mapped configuration and platform, `SolutionDir` with a trailing `\`, `SolutionPath`, `SolutionName`, `SolutionFileName`, `SolutionExt`, `DevEnvDir`, `msbuild.properties`, escaped values).
- Output line prefix `VSSLN|`; records `CL|<true or empty>|<files>|<command line>`, `IncludePath|…`, `ExternalIncludePath|…`.
- Workers: `msbuild.maxParallelism`, 0 → `max(1, floor(cores / 2))`. Timeout per MSBuild run: 300 s.
- Cache directory: `<workspace storage>/intellisense/`, file name `sha1(lower(project path) + '|' + configuration|platform).json`, targets version constant `INTELLISENSE_TARGETS_VERSION = 1`.
- Messages and labels exactly as in spec 8.2 (UI).

## Review Focus

1. A source file listed in two `ClCommandLines` items (one per option set) or in none: the record must be unambiguous and the fallback the project default.
2. Quoting inside command lines: `/D "ENGINE_FLAVOR=\"\""`, `/I"C:\Program Files\x"`, `/FI` with spaces, `/I` with the value in the next token.
3. A configuration switch, a build start or a solution reload in the middle of a pass: no stale result may be written to the cache or the state after cancellation.
4. Hundreds of projects: memory and time of fileIndex lookups and of hashing shared inputs (each file hashed once per pass).
5. A project whose MSBuild run fails or times out: it is reported as failed with the output tail, never retried in a loop, and the rest of the pass goes on.

---

### Task 1: Command lines from MSBuild

**Files:**
- Create: `resources/vssln-intellisense.targets`, `src/intellisense/dump.ts`, `src/intellisense/configuration.ts`
- Create fixture: `test/fixtures/msbuild/intellisense-render.log` (spike output for Render, paths as captured)
- Test: `test/unit/intellisenseDump.test.ts`, `test/unit/intellisenseConfiguration.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // dump.ts
  export interface CommandLineRecord { files: string[]; commandLine: string; projectDefault: boolean }
  export interface ProjectDump { records: CommandLineRecord[]; systemIncludes: string[] }
  export function intellisenseArgs(input: DebugPropertiesInput & { targetsFile: string }): string[]
  export function parseDump(output: string): ProjectDump | undefined   // undefined when no VSSLN| line
  // configuration.ts
  export interface CppConfiguration { includePath: string[]; defines: string[]; forcedInclude: string[]; standard: string; intelliSenseMode: string }
  export function toConfiguration(commandLine: string, systemIncludes: string[], platform: string, file?: string): CppConfiguration
  ```
- [ ] **Step 1: Failing tests.** `parseDump` on the fixture: 2 records (the `/scanModules` ones skipped), `pch.cpp` alone, `render.cpp;frame.cpp` with `projectDefault: true`, system includes without empty entries or duplicates. `toConfiguration`: includes in order then system ones; `/D "ENGINE_FLAVOR=\"\""` → `ENGINE_FLAVOR=""`; `/U X` removes `X`; `/FI` attached and separate; `/I` with the value in the next token; `/std:c++latest` → `c++23`, no `/std` → `c++14`; `/TC` or a `.c` file → C standard (`c17` default, `/std:c11` → `c11`); `Win32` → `windows-msvc-x86`, `ARM64` → `windows-msvc-arm64`; `/Yu` `/Fp` `/Fo` dropped. `intellisenseArgs`: design-time properties present, values escaped like `debugPropertiesArgs`.
- [ ] **Step 2: Watch them fail.**
- [ ] **Step 3: Implement.** The targets file prints with `<Message Importance="High">`; `intellisenseArgs` reuses the property assembly of `debugPropertiesArgs` (extract a shared helper in `debug/properties.ts`).
- [ ] **Step 4: Run all unit tests.**
- [ ] **Step 5: Commit** — `feat: IntelliSense command lines from MSBuild`.

### Task 2: Input files from -preprocess

**Files:** Create `src/intellisense/preprocess.ts`; fixture `test/fixtures/msbuild/preprocess-render.xml` (trimmed spike output: banners and commented imports only); test `test/unit/intellisensePreprocess.test.ts`.

**Interfaces:**
- Produces: `export function parsePreprocess(xml: string, ctx: { projectPath: string; solutionDir: string }, exists: (p: string) => boolean): { inputs: string[]; awaited: string[] }`; `export function preprocessArgs(input: DebugPropertiesInput, outFile: string): string[]`.
- [ ] **Step 1: Failing tests.** Banner paths become inputs (unique, case-insensitive, the project file included); commented imports with `$(MSBuildThisFileDirectory)` / `$(SolutionDir)` resolved, kept only when the file does not exist; any other `$(` skipped; wildcard imports skipped.
- [ ] **Steps 2–5** as above; commit `feat: IntelliSense inputs from -preprocess`.

### Task 3: Cache

**Files:** Create `src/intellisense/cache.ts`; test `test/unit/intellisenseCache.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  export interface CacheKey { msbuildPath: string; projectPath: string; configuration: string; platform: string; solutionPath: string; properties: Record<string, string>; environment: Record<string, string>; targetsVersion: number }
  export interface CacheEntry { key: string; dump: ProjectDump; inputs: { path: string; sha1: string }[]; awaited: string[] }
  export function cacheKey(k: CacheKey): string
  export function cacheFileName(projectPath: string, configuration: string, platform: string): string
  export class Hasher { constructor(read: (p: string) => Promise<Buffer | undefined>); sha1(p: string): Promise<string | undefined> }  // memoized per pass
  export async function isFresh(entry: CacheEntry, key: string, hasher: Hasher, exists: (p: string) => Promise<boolean>): Promise<boolean>
  export interface CacheStore { read(name: string): Promise<CacheEntry | undefined>; write(name: string, entry: CacheEntry): Promise<void>; remove(name: string): Promise<void> }
  export function fileCacheStore(dir: string, fs: …): CacheStore  // atomic temp + rename, corrupt → undefined
  ```
- [ ] Tests: key changes with each field and is stable for property order; fresh / stale by hash / stale by a missing input / stale when an awaited file appears / stale by key; a shared file is read once per `Hasher`; the store writes atomically and reads a corrupt file as a miss. Commit `feat: IntelliSense cache`.

### Task 4: Scheduler

**Files:** Create `src/intellisense/scheduler.ts`; test `test/unit/intellisenseScheduler.test.ts`.

**Interfaces:**
- Produces: `export class Scheduler<T> { constructor(workers: number, run: (item: T, signal: AbortSignal) => Promise<void>, id: (item: T) => string); enqueue(items: T[]): void; prioritize(ids: string[]): void; pause(): void /* aborts running, requeues them first */; resume(): void; cancel(): void; readonly idle: Promise<void> }`.
- [ ] Tests: at most N at once; prioritized ids run first; `pause` aborts running items and requeues them at the front, nothing starts until `resume`; `cancel` aborts and drops everything; a rejected run does not stop the others; `idle` resolves when the queue drains. Commit `feat: IntelliSense scheduler`.

### Task 5: From a file to its configuration

**Files:** Create `src/intellisense/fileIndex.ts`; test `test/unit/intellisenseFileIndex.test.ts`.

**Interfaces:**
- Produces: `export class FileIndex { constructor(s: Pick<AppState, 'solution' | 'projects' | 'startupProjectGuid' | 'configuration'>); projectFor(file: string): string | undefined /* guid */; configurationFor(file: string, dumps: ReadonlyMap<string, ProjectDump>): CppConfiguration | undefined }`.
- [ ] Tests: a source in a record → its record; a header listed by the project → project default; a file listed by two projects → startup first, then solution order; a file in no project inside `Core\Math\` → Math's default; outside every project directory → undefined; a project without a dump → undefined; lookups case- and separator-insensitive; 100k listed files index in under 1 s. Commit `feat: IntelliSense file index`.

### Task 6: Engine and state

**Files:** Create `src/intellisense/engine.ts`; modify `src/state/store.ts` (`AppState.intellisense`); test `test/unit/intellisenseEngine.test.ts`.

**Interfaces:**
- Produces:
  ```ts
  export type ProjectIntelliSense = { status: 'waiting' | 'computing' | 'ready' | 'failed'; fromCache?: boolean; message?: string; seconds?: number }
  export interface IntelliSenseState { projects: Map<string, ProjectIntelliSense>; running: boolean }
  export interface EngineDeps { exec: EnvExec; store: CacheStore; read(p: string): Promise<Buffer | undefined>; exists(p: string): Promise<boolean>; tempFile(): string; cores: number; log(line: string): void; now(): number }
  export class IntelliSenseEngine { constructor(store: Store, deps: EngineDeps, targetsFile: string); start(): void /* new pass for the current state */; recompute(projectGuid?: string): void; prioritize(files: string[]): void; pause(): void; resume(): void; dumps(): ReadonlyMap<string, ProjectDump>; onDidChangeDumps(listener: () => void): { dispose(): void }; dispose(): void }
  ```
- [ ] Tests (fake exec and store): a pass runs both MSBuild calls per mapped existing project and skips missing, unmapped and non-C++ ones; a fresh cache entry is used without MSBuild; a stale one recomputes; a failure records the output tail and the pass goes on; `start` during a pass cancels it and no result of the old pass reaches the state or the cache; `pause` during a run requeues it, `resume` finishes it; `recompute(guid)` removes that entry and recomputes only it; `prioritize` moves the projects of the given files first; state transitions waiting → computing → ready. Commit `feat: IntelliSense engine`.

### Task 7: VS Code wiring

**Files:** Create `src/ui/intellisense.ts`; modify `src/extension.ts`, `src/ui/viewModel.ts` (IntelliSense row, project descriptions, status bar), `src/ui/builds.ts` (pause and resume around builds), `package.json` (commands, menus, `vscode-cpptools` dependency), `docs/manual-checklist.md`; tests in `test/unit/viewModel.test.ts`.

- [ ] Tests (view model): IntelliSense row icon and description for computing, ready, failed; project description suffix while waiting or computing and `IntelliSense failed` with the tail in the tooltip; build description wins; status bar text per state and hidden when ready.
- [ ] Implement the provider (`canProvideConfiguration` from `FileIndex`, `provideConfigurations`, browse declined, `didChangeCustomConfiguration` coalesced to 1 s), engine start on every reload with a ready solution, pause/resume around `Builds.run`, prioritization from visible editors and the active one, the `**/*.{props,targets}` watcher, commands `vssln.recomputeIntelliSense` and `vssln.recomputeIntelliSenseForProject`, the checklist section. Commit `feat: IntelliSense provider and progress in the panel`.

### Task 8: Integration tests on samples/Engine

**Files:** Create `test/engine/intellisense.test.ts`.

- [ ] Tests (real MSBuild and cpptools, skipped without a toolchain): after load every C++ project of Release|x64 is ready; the provider's configuration for `Graphics/Render/render.cpp` has `Core\include` and `out\generated` and `RENDER_EXPORTS`; `Graphics/Render/pch.h` gets the project default; a reload with nothing changed takes every project from the cache (no MSBuild run); touching nothing but changing `Build/Common.props` recomputes the projects that import it; a file with a deliberate error (`int x = "s";`, created by the test) gets a cpptools diagnostic while `#include <engine/render.h>` in the same file gets none (squiggles end to end); a build during a pass pauses it and the pass completes afterwards. Commit `test: IntelliSense on samples/Engine`.
