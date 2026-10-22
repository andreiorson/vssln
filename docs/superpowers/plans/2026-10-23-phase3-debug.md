# Phase 3: run and debug from the panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Tracking: https://claude.ai/artifact/ALsMZ1NbWk1xEoUUAd158T (VS-15 is the phase; VS-27 … VS-32 are Tasks 1 … 6)

**Goal:** Debug and Run buttons in the Status view (and Debug/Run for any application project in the tree), F5 / Ctrl+F5 without a `launch.json`: build the project, read its launch parameters from MSBuild (including `.vcxproj.user`), apply the overrides of `vssln.json`, and start the C/C++ extension's `cppvsdbg` debugger.

**Architecture:** A small MSBuild targets file shipped with the extension prints the launch properties of one project (`debug/properties`); pure functions split a Windows command line, expand `%VAR%`, and merge MSBuild values with the settings into a `cppvsdbg` launch configuration (`debug/commandLine`, `debug/launchResolver`); the VS Code layer (`ui/debugging.ts`) builds first through the existing `Builds.run`, then calls `vscode.debug.startDebugging`. A debugger type `vssln` lets a `launch.json` entry name just the project.

**Tech Stack:** as before; the C/C++ extension (`ms-vscode.cpptools`) becomes an `extensionDependencies` entry.

**Spec:** [docs/superpowers/specs/2026-10-22-vssln-extension-design.md](../specs/2026-10-22-vssln-extension-design.md) section 7, and 4.1 (Debug and Run buttons), 5 (`projects.<name>.debug`, `build.buildBeforeDebug`).

## Verified facts (spike on samples/Engine, VS 2026, 2026-10-23)

- `MSBuild <project>.vcxproj -t:VsslnDebugProperties -nologo -v:minimal -p:Configuration=… -p:Platform=… -p:SolutionDir=<dir>\ -p:CustomAfterMicrosoftCommonTargets=<our .targets>` evaluates in about 170 ms and prints one `VSSLN|<Name>|<value>` line per property. The hook is the one the prototype used, so it works with VS 2019 too (unlike `-getProperty`, which needs MSBuild 17.8+).
- MSBuild resolves the defaults: `LocalDebuggerCommand` = `TargetPath`, `LocalDebuggerWorkingDirectory` = `ProjectDir`. `.vcxproj.user` values apply per configuration; `$(…)` macros inside them are expanded.
- `LocalDebuggerEnvironment` holds `NAME=value` lines; the targets file turns line breaks into `\n`. `%VAR%` references are not expanded by MSBuild (Visual Studio does it at launch).
- `LocalDebuggerCommandArguments` is one command-line string (`--level "two words" --x=1`); `cppvsdbg` wants an `args` array.
- `LocalDebuggerMergeEnvironment=false` (start with only the listed variables) cannot be reproduced: `cppvsdbg` only adds to the inherited environment.
- The C/C++ extension 1.34 is installed in the user's VS Code.
- Fixture: `test/fixtures/msbuild/debug-props-release.log` (spike output for a `.vcxproj.user` with arguments in quotes, a multi-line environment with `%PATH%`, `$(OutDir)` as working directory).

## Decisions for your review

1. **Where a console program's output goes** (`console`, overridable per project in `vssln.json`): recommended default `internalConsole`, the Debug Console, so no terminal is created per launch (the reason the build moved to an Output channel). A program that reads keyboard input needs `"console": "externalTerminal"` or `"newExternalWindow"` in its `projects.<name>.debug`.
2. **F5 and Ctrl+F5**: while a solution is loaded and no debug session runs, F5 debugs and Ctrl+F5 runs the startup project (like Visual Studio); during a session F5 keeps its usual meaning (Continue). A workspace with its own `launch.json` can turn this off with `-vssln.debug` in keybindings.json, or use `"type": "vssln"` entries.

## Global Constraints

- Everything from the earlier plans' constraints holds (no machine values in code, pure modules without `vscode`, no shell for child processes, `DOTNET_CLI_UI_LANGUAGE=en-US` + `VSLANG=1033` for MSBuild).
- Launch value order (later wins): MSBuild (`LocalDebugger*`, `TargetPath`, `ProjectDir`) → `projects.<name>.debug` → `projects.<name>.debug.byConfiguration["<Configuration|Platform>"]`. Environment: process environment (inherited by `cppvsdbg`) ← `environment` of `vssln.json` ← `LocalDebuggerEnvironment` ← `debug.env`; `%VAR%` in `LocalDebuggerEnvironment` is expanded against what is set before it.
- Variables `${workspaceFolder}`, `${solutionDir}`, `${projectDir}`, `${targetPath}`, `${configuration}`, `${platform}`, `${env:NAME}` are expanded in `program`, `args`, `cwd` and `env` values of the settings.
- Build before launch unless `build.buildBeforeDebug` is `false`: `Builds.run('Build', project)`; a failed or refused build cancels the launch and reveals Problems.
- Debug and Run buttons in the Status title, visible when `vssln.phase == ready && !vssln.building && !inDebugMode`: Debug `$(debug-alt)`, Run without debugging `$(run)`.
- Messages that name what to do: no program (`Set "program" for <project> in vssln.json`, with an Open settings action), C/C++ extension missing, project not an application without a program.

## Review Focus

1. Arguments with quotes, backslashes before quotes and empty arguments split the way Windows programs see them (`CommandLineToArgvW`). Test in Task 2.
2. `%VAR%` references to undefined variables stay as they are (Visual Studio keeps them literal); `%%` is not an escape. Test in Task 2.
3. A project whose type is not Application and has no `LocalDebuggerCommand` gives a clear message instead of launching a `.dll`. Test in Task 3.
4. A failed build before launch never starts the debugger. Test in Task 6.
5. A `launch.json` entry `{ "type": "vssln", "request": "launch", "project": "Game", "args": ["x"] }` resolves with the entry's own values winning. Test in Task 3.

---

### Task 1: Debug properties from MSBuild

**Files:** Create `resources/vssln-debug.targets`, `src/debug/properties.ts`, `test/unit/debugProperties.test.ts`; modify `.vscodeignore` (`!resources/**`).

**Interfaces:**
- Produces:

```ts
export interface DebugProperties {
  targetPath: string; command: string; arguments: string; workingDirectory: string;
  environment: string[];            // NAME=value lines
  mergeEnvironment: boolean; projectDir: string; configurationType: string;
}
export function debugPropertiesArgs(projectPath: string, config: { configuration: string; platform: string }, solutionDir: string, targetsFile: string, devEnvDir: string): string[];
export function parseDebugProperties(output: string): DebugProperties | undefined; // undefined when TargetPath is missing
export function evaluateDebugProperties(deps: { exec: Exec; msbuildPath: string; env: Record<string, string | undefined> }, args: string[]): Promise<{ properties?: DebugProperties; problem?: string }>;
```

The targets file is the spike's `VsslnDebugProperties` target (one `Message Importance="high"` per property, `\n` for line breaks). Arguments: project, `-t:VsslnDebugProperties`, `-nologo`, `-v:minimal`, `-p:Configuration`, `-p:Platform`, `-p:SolutionDir=<dir with trailing \>`, `-p:DevEnvDir` when known, `-p:CustomAfterMicrosoftCommonTargets=<targets>`. Environment adds `DOTNET_CLI_UI_LANGUAGE=en-US`.

- [ ] Tests: arguments list; parsing the fixture (environment split into 3 lines, `mergeEnvironment` false, trailing spaces trimmed); missing `TargetPath` → undefined; exec failure → problem with the last output lines. Then implement, run, commit `feat: read launch properties of a project from MSBuild`.

### Task 2: Command line and environment helpers

**Files:** Create `src/debug/commandLine.ts`, `test/unit/commandLine.test.ts`.

**Interfaces:**
- Produces: `splitCommandLine(line: string): string[]` (CommandLineToArgvW rules: whitespace separates, `"` toggles quoting, `2n` backslashes + `"` → `n` backslashes and a quote toggle, `2n+1` backslashes + `"` → `n` backslashes and a literal quote, `""` inside quotes → literal quote, `""` alone → empty argument); `expandPercent(value: string, env: Record<string, string | undefined>): string` (case-insensitive names, undefined variables stay literal); `applyEnvironmentLines(lines: string[], base: Record<string, string | undefined>): Record<string, string>` (each `NAME=value` sees the variables set before it; lines without `=` ignored; `NAME=` sets an empty value).

- [ ] Tests for each rule (Review Focus 1, 2), then implement, run, commit `feat: Windows command line splitting and %VAR% expansion`.

### Task 3: Launch resolver

**Files:** Create `src/debug/launchResolver.ts`, `test/unit/launchResolver.test.ts`.

**Interfaces:**
- Consumes: Tasks 1–2, `VsslnSettings`, `expandVariables`.
- Produces:

```ts
export interface LaunchInput {
  project: SlnProject; config: SolutionConfig; settings: VsslnSettings; properties: DebugProperties;
  workspaceFolder: string; solutionDir: string; env: Record<string, string | undefined>; noDebug: boolean;
  /** Values of a launch.json entry of type vssln, which win over everything else. */
  overrides?: { program?: string; args?: string[]; cwd?: string; env?: Record<string, string>; console?: string };
}
export type LaunchResult = { config: CppvsdbgConfiguration } | { problem: string; action?: 'openSettings' };
export interface CppvsdbgConfiguration { type: 'cppvsdbg'; request: 'launch'; name: string; program: string; args: string[]; cwd: string; environment: { name: string; value: string }[]; console: string; noDebug?: boolean }
export const DEFAULT_CONSOLE = 'internalConsole';
export function resolveLaunch(input: LaunchInput): LaunchResult;
```

Rules: value order from Global Constraints; `program` from settings wins over `LocalDebuggerCommand`; if the project is not `Application` and the program is the project's own `TargetPath` (nothing set) → problem `<Project> is a <type>; set "program" for it in vssln.json` with `openSettings`; `environment` lists only variables that differ from the inherited process environment (cppvsdbg adds them); `name` is `Debug <Project>` / `Run <Project>`; `mergeEnvironment: false` adds nothing special (limitation, documented in the spec).

- [ ] Tests: the fixture for Game (args `['--level', 'two words', '--x=1']`, cwd `C:\src\Engine\out\x64\Release\`, `PATH` expanded from the inherited value, `EMPTY` empty); settings override and `byConfiguration` winning; variables in settings values; launch.json overrides winning (Review Focus 5); dll without program → problem (Review Focus 3); dll with a settings program → config. Implement, run, commit `feat: launch configuration from MSBuild values and settings`.

### Task 4: Sample observable launch

**Files:** Modify `samples/Engine/Tools/AssetCooker/cooker.cpp`, `samples/Engine/README.md`, `.gitignore` (`samples/Engine/Tools/AssetCooker/cooked.txt`).

AssetCooker additionally writes `cooked.txt` in its working directory: `assets=<n>`, `args=<args joined by spaces>`, `COOK_MODE=<value or (unset)>`. This lets an integration test see program, cwd, args and environment of a real launch.

- [ ] Build `samples/Engine` Release|x64 (as in the phase 1 plan); run `AssetCooker.exe --fast` with `COOK_MODE=test` from `Tools/AssetCooker`; `cooked.txt` holds the three lines. Commit `test: AssetCooker reports its launch parameters`.

### Task 5: VS Code wiring

**Files:** Create `src/ui/debugging.ts`; modify `src/extension.ts`, `package.json`, `src/ui/builds.ts` (expose `run` for projects is already there), `docs/manual-checklist.md`, spec section 7.

**Interfaces:**
- Consumes: Tasks 1–3, `Builds.run`, `Store`, `findRealToolchain` data in the state.
- Produces: commands `vssln.debug`, `vssln.run`, `vssln.debugProject`, `vssln.runProject`, `vssln.targetPath` / `vssln.startupProject` / `vssln.configuration` (for `${command:…}`); debugger type `vssln`; API `debugging.resolve(projectName, noDebug)` returning the `LaunchResult` (tests).

- [ ] **package.json:** `extensionDependencies: ["ms-vscode.cpptools"]`; `debuggers: [{ type: "vssln", label: "VS Solution", configurationAttributes.launch` with `project` (required), `args`, `cwd`, `env`, `console`, `program` }]`; title buttons Debug/Run (Global Constraints); context menu `^project\.app$` → Debug project, Run project (group `0_debug`), inline Debug `$(debug-alt)` on hover next to the hammer; keybindings `f5` → `vssln.debug` and `ctrl+f5` → `vssln.run` when `vssln.phase == ready && !inDebugMode`.
- [ ] **debugging.ts:** `launch(project, noDebug)`: refuse while building; build first (Global Constraints); evaluate properties (Task 1) with the targets file at `context.asAbsolutePath('resources/vssln-debug.targets')`; resolve (Task 3); on a problem show it with its action; otherwise `vscode.debug.startDebugging(folder, config, { noDebug })`. `DebugConfigurationProvider` for type `vssln`: `resolveDebugConfiguration` turns `{ type: 'vssln', project }` (or an empty config on F5 from the Run view) into the `cppvsdbg` configuration through the same path, returning `undefined` to cancel. The startup project when none is named.
- [ ] **Verify:** typecheck, unit, both integration suites (fixture tests do not need cpptools: see Task 6 for the test configuration).
- [ ] Commit `feat: debug and run from the panel and with F5`.

### Task 6: Integration tests

**Files:** Modify `.vscode-test.mjs` (the engine configuration installs `ms-vscode.cpptools` with `installExtensions` and does not pass `--disable-extensions`; the fixture configuration keeps it and the extension activates without cpptools there only if the dependency is soft — if activation fails without it, the fixture configuration installs it too), `test/engine/debug.test.ts`.

- [ ] Tests (skip without a toolchain): `api.debugging.resolve('Game')` gives `--windowed` and `GAME_MODE=sample` from `Game.vcxproj.user`; Run AssetCooker with `projects.AssetCooker.debug = { args: ['--fast'], env: { COOK_MODE: 'test' }, cwd: '${projectDir}' }` → `cooked.txt` in `Tools/AssetCooker` holds `args=--fast` and `COOK_MODE=test` (session ends by itself); a broken build (`CL=/DENGINE_BREAK_BUILD`) refuses the launch and no debug session starts (Review Focus 4); Audio (dll) gives the "set program" problem.
- [ ] Run all suites, commit `test: debug and run integration tests on samples/Engine`.

## After phase 3

Final whole-branch review (every finding fixed), merge, install for your check. Phase 4 (IntelliSense) gets its own plan.
