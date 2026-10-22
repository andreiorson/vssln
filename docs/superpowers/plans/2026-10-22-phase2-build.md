# Phase 2: build from the panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Tracking: https://claude.ai/artifact/ALsMZ1NbWk1xEoUUAd158T (VS-14 is the phase; VS-17 … VS-24 are Tasks 1 … 8 of this plan)

**Goal:** Build, Rebuild, Clean and Stop buttons right in the Status view (and Build/Rebuild/Clean for one project in the tree), running MSBuild on the solution with live per-project progress in the tree, a Build row, errors in Problems and the MSBuild output in a terminal — with nothing to configure.

**Architecture:** Pure modules turn a build request into MSBuild arguments (`build/args`), MSBuild console lines into events and display lines (`build/outputParser`), and events into an immutable build state (`state/build`). `build/runner` owns the child process (injected `spawn`/`kill`), `build/session` glues them and feeds the store. The VS Code layer adds a `TaskProvider` with a pseudoterminal (so `Ctrl+Shift+B` and `$msCompile` work), commands, menus and the view model rows.

**Tech Stack:** as phase 1 (TypeScript, esbuild, vitest, `@vscode/test-cli`).

**Spec:** [docs/superpowers/specs/2026-10-22-vssln-extension-design.md](../specs/2026-10-22-vssln-extension-design.md) sections 4.1, 4.2, 4.3, 6; phase 1 plan for the existing modules: [2026-10-22-phase1-panel-and-settings.md](2026-10-22-phase1-panel-and-settings.md).

## Verified facts (spike on samples/Engine, VS 2026, 2026-10-22)

- `MSBuild.exe Engine.sln -m -nologo -nr:false -v:normal …` prefixes every line with the instance id of the project that wrote it: `6>`; an id can be compound: `5:2>`.
- A project start: `1>Project "D:\…\Engine.sln" (1) is building "D:\…\Core\Math\Math.vcxproj" (6) on node 7 (Rebuild target(s)).` The targets part is `default targets`, `Build target(s)`, `Rebuild target(s)` or `Clean target(s)` for real work; references also cause short calls with other targets (`GetTargetPath`, …), which must not count.
- A project end: `6>Done Building Project "D:\…\Core\Math\Math.vcxproj" (Rebuild target(s)) -- FAILED.` (without ` -- FAILED` on success).
- `Render` is never started by the solution itself: it is built through `Game`'s `ProjectReference` (`5>Project "…\Game.vcxproj" (5) is building "…\Render.vcxproj" (12) …`). Progress is therefore tracked by project path, whoever starts it.
- Errors: `6>D:\…\vector.cpp(4,1): error C1189: #error:  "…" [D:\…\Core\Math\Math.vcxproj]` — the project path is the bracketed suffix. After `Build FAILED.` / `Build succeeded.` MSBuild repeats every diagnostic without the `N>` prefix (summary); those must not be counted twice.
- Single project through the solution: `-t:Graphics\Render`, `-t:Graphics\Render:Rebuild`, `-t:Core\Math:Clean` work and build dependencies; lines for `*.vcxproj.metaproj` appear and are ignored.
- Projects without `Build.0` (`Missing`) and unmapped ones (`Legacy`) are not started; `Release|x64` prints `warning MSB4121` for `Legacy`.

## Global Constraints

- Everything from the phase 1 plan's Global Constraints still holds (no machine values in code, pure modules do not import `vscode`, no shell for child processes).
- MSBuild arguments always include: the `.sln` path, `-t:<target>`, `-m`, `-nologo`, `-nr:false`, `-v:normal`, `-p:Configuration=<c>`, `-p:Platform=<p>`, `-p:DevEnvDir=<dir>` (when known), the `msbuild.properties` of `vssln.json` as `-p:K=V` in key order, and a file logger `-flp:LogFile=<log>;Verbosity=normal;Encoding=UTF-8` with `-fl`.
- The MSBuild process environment is `process.env` + the expanded `environment` of `vssln.json` + `VSLANG=1033` (English tool output: the parser depends on English MSBuild messages, and localized Visual Studio installs exist).
- Only one build at a time. While a build runs: solution, configuration and startup project cannot be changed; Build/Rebuild/Clean are replaced by Stop.
- Clean and Rebuild ask for a modal confirmation (user decision 2026-10-22). Build does not.
- Dirty editors are saved before a build unless `build.saveBeforeBuild` is `false`.
- Stop kills the whole process tree with `taskkill /pid <pid> /t /f`.
- Title buttons of the Status view, in this order, all visible: Build `$(tools)`, Rebuild `$(debug-restart)`, Clean `$(clear-all)`; Stop `$(debug-stop)` while building. Open settings, Reload solution and Show log move to the overflow menu.
- Review minors are fixed in the same pass as the other findings (user rule).

## Review Focus

1. Visual Studio installed in another language: tool output must still parse; `VSLANG=1033` is in the build environment. Test in Task 6.
2. A project built only through a `ProjectReference` (`Render`) gets building/succeeded states like the others. Test in Task 2.
3. Stop in the middle of a build: the whole tree is killed, the build ends as `cancelled`, projects still building become `skipped`, nothing stays "building". Tests in Tasks 3 and 5.
4. A second Build while one runs does not start a second MSBuild. Test in Task 6.
5. Toolchain not found: the build commands explain it and start nothing. Test in Task 6.

---

## File structure

```text
src/build/args.ts            BuildRequest -> MSBuild argument list; solution target names
src/build/outputParser.ts    OutputParser: console line -> events + optional display line
src/state/build.ts           BuildState and its pure transitions (start, apply event, finish)
src/build/runner.ts          BuildRunner: one MSBuild process, line streaming, stop via kill tree
src/build/session.ts         runBuild: state -> args/env -> runner -> parser -> store; refuses second build
src/ui/buildTasks.ts         TaskProvider + pseudoterminal; build commands; Stop; show output
src/state/store.ts           (modify) AppState.build, Store.update
src/ui/viewModel.ts          (modify) Build row, locked rows, project/folder build descriptions, decorations, status bar
src/ui/commands.ts           (modify) selection commands refuse while building; keep build state across reloads
src/extension.ts, package.json (modify) wiring, menus, task definition, context key vssln.building
test/fixtures/msbuild/*.log  captured console output (paths rewritten to C:\src\Engine)
test/engine/*.test.ts        integration tests on samples/Engine (second @vscode/test-cli configuration)
```

---

### Task 1: MSBuild arguments

**Files:** Create `src/build/args.ts`, `test/unit/buildArgs.test.ts`

**Interfaces:**
- Consumes: `ParsedSolution`, `SlnProject`, `SolutionConfig` (phase 1 Task 2), `VsInstance` (phase 1 Task 7).
- Produces:

```ts
export type BuildAction = 'Build' | 'Rebuild' | 'Clean';
export interface BuildRequest { action: BuildAction; project?: SlnProject } // no project = whole solution
export function solutionTargetName(sln: ParsedSolution, project: SlnProject): string;
export interface BuildCommandInput {
  sln: ParsedSolution; config: SolutionConfig; toolchain: VsInstance; request: BuildRequest;
  properties: Record<string, string>; logFile: string;
}
export function buildArgs(input: BuildCommandInput): string[];
```

Target name rule (MSBuild `ProjectInSolution` cleansing): the chain of solution folder names from the root, then the project name, joined with `\`; in every part the characters `% $ @ ; . ( ) '` become `_`.

- [ ] **Step 1: Failing tests**

```ts
test('nested project target name', () => expect(solutionTargetName(engine, project('Render'))).toBe('Graphics\\Render'));
test('root project target name', () => expect(solutionTargetName(engine, project('Game'))).toBe('Game'));
test('special characters are cleansed', () => { /* folder "Third.Party (x)" + project "My.Lib" -> 'Third_Party _x_\\My_Lib' */ });
test('solution build arguments', () => {
  expect(buildArgs({ sln: engine, config: releaseX64, toolchain: VS, request: { action: 'Build' }, properties: { B: '2', A: '1' }, logFile: 'C:\\t\\build.log' })).toEqual([
    'C:\\src\\Engine\\Engine.sln', '-t:Build', '-m', '-nologo', '-nr:false', '-v:normal',
    '-p:Configuration=Release', '-p:Platform=x64', '-p:DevEnvDir=C:\\VS\\Common7\\IDE\\',
    '-p:A=1', '-p:B=2', '-fl', '-flp:LogFile=C:\\t\\build.log;Verbosity=normal;Encoding=UTF-8',
  ]);
});
test('project rebuild and clean targets', () => { /* Render Rebuild -> '-t:Graphics\\Render:Rebuild'; Clean -> ':Clean'; Build -> '-t:Graphics\\Render' */ });
test('no DevEnvDir argument when the toolchain has none', () => { /* devEnvDir '' -> no -p:DevEnvDir */ });
test('platform with a space stays one argument', () => { /* 'Any CPU' -> '-p:Platform=Any CPU' */ });
```

`engine` is `samples/Engine/Engine.sln` parsed with the path `C:\src\Engine\Engine.sln`.

- [ ] **Step 2:** run, see FAIL. **Step 3:** implement. **Step 4:** run, all pass. **Step 5:** commit `feat: MSBuild arguments for solution and project builds`.

---

### Task 2: Output parser

**Files:** Create `src/build/outputParser.ts`, `test/unit/outputParser.test.ts`, `test/fixtures/msbuild/rebuild-failed.log`, `test/fixtures/msbuild/build-incremental.log`, `test/fixtures/msbuild/project-rebuild.log`

**Interfaces:**
- Produces:

```ts
export type BuildEvent =
  | { kind: 'projectStarted'; path: string }
  | { kind: 'projectFinished'; path: string; failed: boolean }
  | { kind: 'diagnostic'; severity: 'error' | 'warning'; projectPath?: string; text: string };
export interface ParsedLine { events: BuildEvent[]; display?: string }
export class OutputParser {
  push(line: string): ParsedLine;   // stateful: knows when the final summary began
}
```

Rules:
- The `N>` / `N:M>` prefix and leading spaces are removed from `display`.
- `projectStarted` / `projectFinished` only for `*.vcxproj` paths and targets `default targets`, `Build target(s)`, `Rebuild target(s)`, `Clean target(s)`.
- `diagnostic` for `<text>: error|warning <CODE>: <message> [<project>]`; `projectPath` from the bracketed suffix. Once a line equals `Build succeeded.` or `Build FAILED.`, later diagnostics produce no events (summary repeats them) but are still displayed.
- `display` (what the terminal shows, roughly Visual Studio's "minimal" output): diagnostics; lines containing ` -> ` (outputs); for `projectFinished`: `<ProjectName>: succeeded` or `<ProjectName>: FAILED`; `Build succeeded.`, `Build FAILED.` and every line after it. Everything else: `undefined`.

Fixtures: the three spike outputs, with `D:\visualizer\samples\Engine` replaced by `C:\src\Engine`.

- [ ] **Step 1: Failing tests**

```ts
test('failed rebuild: starts, finishes and one counted error', () => {
  const events = parseAll('msbuild/rebuild-failed.log');
  expect(started(events)).toContain('C:\\src\\Engine\\Core\\Math\\Math.vcxproj');
  expect(finished(events)).toContainEqual({ path: 'C:\\src\\Engine\\Core\\Math\\Math.vcxproj', failed: true });
  expect(events.filter(e => e.kind === 'diagnostic' && e.severity === 'error')).toEqual([
    { kind: 'diagnostic', severity: 'error', projectPath: 'C:\\src\\Engine\\Core\\Math\\Math.vcxproj', text: expect.stringContaining('C1189') }]);
});
test('a project built through a reference is tracked', () => {
  expect(started(parseAll('msbuild/build-incremental.log'))).toContain('C:\\src\\Engine\\Graphics\\Render\\Render.vcxproj');
});
test('reference calls with other targets and metaproj lines are ignored', () => { /* project-rebuild.log: no event for .metaproj; Math "(Clean target(s))" then "(5:2) … (default targets)" -> starts counted for Clean and default */ });
test('compound instance ids', () => { /* '5:2>Done Building Project "C:\\a\\B.vcxproj" (default targets).' -> projectFinished */ });
test('display lines', () => {
  const p = new OutputParser();
  expect(p.push('     6>Done Building Project "C:\\a\\Math.vcxproj" (Rebuild target(s)) -- FAILED.').display).toBe('Math: FAILED');
  expect(p.push('  Game.vcxproj -> C:\\out\\Game.exe').display).toBe('Game.vcxproj -> C:\\out\\Game.exe');
  expect(p.push('     1>Project "C:\\a\\E.sln" (1) is building "C:\\a\\Math.vcxproj" (6) on node 7 (Rebuild target(s)).').display).toBeUndefined();
});
test('warning MSB4121 is a warning without a project path', () => { /* sln.metaproj line -> severity warning, projectPath 'C:\\…\\Engine.sln' or undefined */ });
```

- [ ] **Step 2:** FAIL. **Step 3:** implement. **Step 4:** pass. **Step 5:** commit `feat: parse MSBuild console output into build events`.

---

### Task 3: Build state

**Files:** Create `src/state/build.ts`, `test/unit/buildState.test.ts`; modify `src/state/store.ts` (`AppState.build: BuildState`, `initialState.build = idleBuild`, `Store.update(fn: (s: AppState) => AppState): void`)

**Interfaces:**
- Consumes: `BuildEvent` (Task 2), `BuildRequest`, `BuildAction` (Task 1).
- Produces:

```ts
export type ProjectBuildStatus = 'waiting' | 'building' | 'succeeded' | 'failed' | 'skipped';
export interface ProjectBuild { status: ProjectBuildStatus; errors: number; warnings: number; messages: string[]; startedAt?: number; finishedAt?: number }
export interface BuildState {
  status: 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  action?: BuildAction;
  projectName?: string;            // set for a single-project build
  startedAt?: number; finishedAt?: number;
  total: number; done: number; errors: number; warnings: number;
  projects: Map<string, ProjectBuild>;   // by project guid
  logFile?: string;
}
export const idleBuild: BuildState;
export function startBuild(request: BuildRequest, expectedGuids: string[], logFile: string, now: number): BuildState;
export function applyBuildEvent(b: BuildState, e: BuildEvent, guidByPath: (path: string) => string | undefined, now: number): BuildState;
export function finishBuild(b: BuildState, outcome: { exitCode: number | null; cancelled: boolean }, now: number): BuildState;
export function expectedProjects(sln: ParsedSolution, config: SolutionConfig, projects: Map<string, ProjectEntry>): string[]; // C++ guids with Build.0 whose file exists
```

Rules: `startBuild` puts every expected guid in `waiting`; `total` = expected count, raised when a not-expected project starts. `projectStarted` → `building`. `projectFinished` → `succeeded`/`failed`, `done` counts both. A diagnostic adds to the project's counters (and the build's), keeps at most 5 `messages` per project. `finishBuild`: `cancelled` when cancelled, otherwise `succeeded` when exit code 0 else `failed`; projects still `waiting`/`building` become `skipped`. Unknown paths are ignored. All functions return new objects.

- [ ] **Step 1: Failing tests** — one per rule, plus: `expectedProjects(engine Release|x64)` gives the 10 buildable projects (not `Legacy`, not `Missing`); replaying `rebuild-failed.log` through `applyBuildEvent` and `finishBuild({exitCode: 1})` leaves `Math` failed with 1 error, `Game` failed with 0 errors, `Render` skipped, `Audio` succeeded, status `failed`; cancel while `Math` builds → `cancelled`, `Math` skipped.
- [ ] **Step 2:** FAIL. **Step 3:** implement; store gets `update`. **Step 4:** pass (whole suite). **Step 5:** commit `feat: build state and transitions`.

---

### Task 4: View model for builds

**Files:** Modify `src/ui/viewModel.ts`, `test/unit/viewModel.test.ts`

**Interfaces:**
- Consumes: `BuildState` (Task 3).
- Produces: `statusRows` gains the Build row; `projectRow`, `projectDecoration`, `statusBarItems` read `s.build`; new `clock(ms: number): string` (local `HH:MM`) and `duration(ms: number): string` (`m:ss`).

| Thing | Value |
| --- | --- |
| Build row position | after the startup row, before problems; absent while `build.status` is `idle` |
| Build row label | `Build` / `Rebuild` / `Clean`, plus ` <project>` for a project build |
| Running | icon `loading~spin`, description `<done>/<total> · <elapsed>` + ` · <n> errors` when errors > 0, contextValue `status.build.running`, command `vssln.showBuildOutput` |
| Succeeded | icon `pass`, description `succeeded · <clock(finishedAt)> · <duration>` |
| Failed | icon `error`, description `failed · <n> errors · <clock(finishedAt)>` |
| Cancelled | icon `circle-slash`, description `stopped · <clock(finishedAt)>` |
| Finished rows | contextValue `status.build`, command `vssln.showBuildOutput` |
| Locked rows while running | solution and configuration rows: description `locked during build` (solution row keeps its path in the tooltip) |
| Project in a build | description: `waiting`, `building`, `built · <seconds>s`, `<n> errors` (failed with errors), `failed` (failed without errors), `skipped`; building icon `loading~spin`, otherwise the type icon |
| Folder in a build | description `building <n>` while descendants build, else `<n> errors` when descendants failed, else none |
| Decoration | failed project: `{ color: 'list.errorForeground', badge: '<errors, max 99>' or '!', tooltip: first message }`; warnings only: `{ color: 'list.warningForeground' }`; inactive stays as in phase 1 |
| Status bar build entry | running `$(sync~spin) Building <done>/<total>`; failed `$(error) <errors>` (command `workbench.actions.view.problems`); otherwise none |

`Decoration` gains `badge?: string` and the color union grows by the two list colors.

- [ ] Steps: failing tests for every row of the table (build states made with Task 3 functions over the fixture state), FAIL, implement, pass, commit `feat: build progress in the panel`.

---

### Task 5: Build runner

**Files:** Create `src/build/runner.ts`, `test/unit/runner.test.ts`

**Interfaces:**
- Produces:

```ts
export interface ChildProcessLike { pid?: number; onLine(cb: (line: string) => void): void; onExit(cb: (code: number | null) => void): void }
export type Spawn = (file: string, args: string[], env: Record<string, string | undefined>) => ChildProcessLike;
export type KillTree = (pid: number) => Promise<void>;
export class BuildRunner {
  constructor(spawn: Spawn, kill: KillTree);
  get running(): boolean;
  run(file: string, args: string[], env: Record<string, string | undefined>, onLine: (line: string) => void): Promise<{ exitCode: number | null; cancelled: boolean }>;
  stop(): Promise<void>;   // no-op when idle
}
export function realSpawn(): Spawn;      // child_process.spawn, shell false, windowsHide, stdout+stderr split into lines (UTF-8)
export function realKillTree(): KillTree; // execFile('taskkill', ['/pid', String(pid), '/t', '/f'])
```

- [ ] **Step 1: Failing tests** (fake spawn/kill): lines are forwarded in order; exit code returned; `running` true during and false after; `stop()` calls kill with the pid and the result is `{ cancelled: true }`; `run` while running throws `Error('A build is already running.')`; a line split across two chunks arrives once (test the line splitter helper `splitLines()` exported for this).
- [ ] Steps 2–4 as usual. **Step 5:** commit `feat: MSBuild process runner with tree kill`.

---

### Task 6: Build session

**Files:** Create `src/build/session.ts`, `test/unit/session.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5, `Store`, `expandVariables` (phase 1), `projectEntry` data from `AppState`.
- Produces:

```ts
export interface SessionDeps {
  store: Store; runner: BuildRunner; now(): number; logDir: string; env: Record<string, string | undefined>;
  write(line: string): void;               // terminal sink
}
export type SessionResult = { started: false; reason: string } | { started: true; outcome: BuildState };
export function runBuild(deps: SessionDeps, request: BuildRequest): Promise<SessionResult>;
```

Behaviour: refuses (no spawn) when `store.state.phase !== 'ready'`, when there is no toolchain (`reason` names Configure toolchain), or when a build runs (`'A build is already running.'`). Otherwise: environment = `env` + expanded `settings.environment` + `VSLANG=1033`; log file `<logDir>/build.log`; writes a header line `<Action> <solution file or project> (<Configuration|Platform>)`; sets `startBuild` into the store with `expectedProjects(...)` for a solution build or `[project.guid]` for a project build (dependencies join as they start); for each line pushes it through one `OutputParser`, applies events (path → guid via the solution's projects, case-insensitive), writes `display` lines; at exit applies `finishBuild` and writes `Build log: <path>`; store updates are coalesced by the caller's views, not here.

- [ ] **Step 1: Failing tests** with a fake runner replaying `rebuild-failed.log`: final state `failed`, `Math` 1 error; written lines contain `Math: FAILED` and the C1189 line; env passed to the runner has `VSLANG: '1033'` and the expanded `environment` from settings (Review Focus 1); second call while running → `started: false` and the runner was spawned once (Review Focus 4); no toolchain → `started: false`, no spawn (Review Focus 5); `phase !== 'ready'` → refused.
- [ ] Steps 2–4. **Step 5:** commit `feat: build session from request to state`.

---

### Task 7: VS Code wiring

**Files:** Create `src/ui/buildTasks.ts`; modify `src/extension.ts`, `src/ui/commands.ts`, `src/ui/statusView.ts`, `package.json`, `docs/manual-checklist.md`

**Interfaces:**
- Consumes: Task 6 `runBuild`, Task 5 `BuildRunner`/`realSpawn`/`realKillTree`.
- Produces: commands `vssln.build`, `vssln.rebuild`, `vssln.clean`, `vssln.stop`, `vssln.buildProject`, `vssln.rebuildProject`, `vssln.cleanProject`, `vssln.showBuildOutput`; task type `vssln` (`taskDefinitions`: `action` enum `Build|Rebuild|Clean`, optional `project` string = project name); context key `vssln.building`.

- [ ] **Step 1: package.json.** Commands with the icons from Global Constraints. `view/title` of `vssln.status`: build/rebuild/clean `navigation@1..3` when `vssln.phase == ready && !vssln.building`, stop `navigation@1` when `vssln.building`; open settings, reload, show log move to group `1_vssln`. `view/item/context`: `status.build.running` → inline stop; `^project\.(app|lib)$` → inline `vssln.buildProject` (`$(tools)`) and context group `0_build` with Build/Rebuild/Clean project. `taskDefinitions` for type `vssln`. Problem matcher for the tasks: `$msCompile`.
- [ ] **Step 2: `buildTasks.ts`.** `TaskProvider.provideTasks` returns Build (group Build), Rebuild (group Rebuild), Clean (group Clean) for the solution; `resolveTask` accepts the definition with `project`. Execution: `CustomExecution` → pseudoterminal; `open` calls `runBuild` with `write` = terminal write (`\r\n` line ends); `close` stops the runner; the pseudoterminal closes with exit code 0/1 at the end; a refused build writes the reason and closes with 1 and also shows it as an error message. Commands run `vscode.tasks.executeTask`. Before execution: refuse if building; save all dirty editors unless `build.saveBeforeBuild === false`; Clean/Rebuild show a modal warning (`Rebuild the whole solution? This discards incremental build state.` / `Clean …?`, button `Rebuild`/`Clean`). `vssln.stop` calls `runner.stop()`. `vssln.showBuildOutput` shows the last build terminal.
- [ ] **Step 3: locking and reloads.** Selection commands and `setAsStartup` refuse while `build.status === 'running'` with `Wait for the build to finish or stop it.`. `Controller.reload` keeps `build` from the previous state unless the solution path or configuration changed (then `idleBuild`). The Status view refreshes every second while a build runs (elapsed time). `vssln.building` follows `build.status === 'running'`.
- [ ] **Step 4: Verify** `npm run typecheck`, `npm test`, `npm run test:integration` (phase 1 tests still pass).
- [ ] **Step 5:** update the manual checklist with a Build section (buttons visible, progress, Stop, Clean/Rebuild confirmation, Problems, `Ctrl+Shift+B`), commit `feat: build, rebuild, clean and stop from the panel`.

---

### Task 8: Integration tests on samples/Engine

**Files:** Modify `.vscode-test.mjs` (array of two configurations: `unit-fixture` as today, `engine` with `workspaceFolder: 'samples/Engine'`, `files: 'out/test/engine/**/*.test.js'`, mocha timeout 300000); create `test/engine/build.test.ts`, `test/engine/tsconfig.json`; modify `package.json` script `test:integration` to compile both test folders.

- [ ] **Step 1: Tests** (each skips itself when `api.getState().toolchain` is undefined, so machines without Visual Studio stay green):

```ts
test('Build task builds the solution and reports every project', async () => {
  const task = (await vscode.tasks.fetchTasks({ type: 'vssln' })).find(t => t.definition.action === 'Build')!;
  await vscode.tasks.executeTask(task);
  await waitFor(() => api.getState().build.status !== 'running' && api.getState().build.status !== 'idle', 240000);
  const b = api.getState().build;
  assert.strictEqual(b.status, 'succeeded');
  assert.strictEqual(b.done, 10);
  assert.strictEqual(b.projects.get(guidOf('Render'))!.status, 'succeeded');
});
test('a broken build fails in Math and fills Problems', async () => {
  // write samples/Engine/.vscode/vssln.json: {"environment": {"CL": "/DENGINE_BREAK_BUILD"}}, run the Rebuild task (no confirmation: it is the task, not the command)
  // expect status 'failed', Math failed with 1 error, vscode.languages.getDiagnostics(vector.cpp) has a C1189 error
  // teardown: delete samples/Engine/.vscode and rebuild is not needed (next Build is incremental)
});
```

- [ ] **Step 2:** run `npm run test:integration`. Expected: the fixture configuration passes as before, the engine configuration reports 2 passing. **Step 3:** commit `test: build integration tests on samples/Engine`.

---

## After phase 2

Phase 3 (debug: Debug and Run buttons, `F5` without `launch.json`) gets its own plan after your check of phase 2.
