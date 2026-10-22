# VS Solution extension: design

Date: 2026-10-22. Status: approved in conversation, awaiting written-spec review.

Companion document: [README.md](../../../README.md) (the IntelliSense prototype brief). Everything the brief says about MSBuild design-time evaluation, caching, scheduling and the cpptools provider stays valid; this spec builds the full extension around it and only repeats the brief where the design changes it.

## 1. Goal

A VS Code extension that lets a developer work with a Visual Studio C++ solution the way Visual Studio does: see the solution structure, pick a solution configuration and a startup project, build, run and debug, and get correct IntelliSense, without any machine- or user-specific values baked into the extension or into user settings.

Success criterion: open a folder that contains a `.sln` on any Windows machine with Visual Studio installed, pick a configuration, build and debug the startup project, with nothing configured by hand.

## 2. Scope

In v1:

- C++ projects (`.vcxproj`) only. Other project types listed in the `.sln` are shown greyed out and have no actions.
- Side bar with a status view and a project tree (solution folders and projects).
- Build, Rebuild, Clean for the solution and for a single project; Stop.
- Debug and Run without debugging for the startup project or any application project.
- Personal per-workspace settings file; automatic toolchain discovery.
- The IntelliSense pipeline from the brief.

Not in v1 (the design must leave room for them):

- Filters (`.vcxproj.filters`), files and references nodes under a project.
- Editing projects (adding files, changing properties).
- C# and other project types; non-Windows platforms.
- Batch build, multiple startup projects.

## 3. Principles

- **No personal values in code or in VS Code settings.** Every value is resolved by a chain; the first source that has it wins:
  1. the workspace settings file `.vscode/vssln.json`;
  2. the `.sln` and MSBuild evaluation (configurations, project mapping, `TargetPath`, `LocalDebugger*` including a `.vcxproj.user` if present, `IncludePath`);
  3. automatic discovery (Visual Studio and MSBuild through `vswhere`, `DevEnvDir` of the found instance);
  4. built-in defaults.
- **Native VS Code mechanisms first.** Tree views, QuickPick, tasks, debug configuration providers, problem matchers. No webview in v1.
- **Thin VS Code layer.** Logic lives in pure modules with injected dependencies (as in the brief, section 11).

## 4. User interface

Native `TreeView`s in an own view container (activity bar icon). Chosen over a full webview (the prototype's approach) and over a webview header plus tree hybrid: the native tree gives keyboard navigation, context menus, inline actions, theming, accessibility and performance on hundreds of projects for free, and deeper levels (filters, files, references) are added as new node kinds instead of new UI code. The only thing lost is a real drop-down; QuickPick with search replaces it.

### 4.1 Status view

A short tree with a fixed set of rows:

| Row | Content | Click | Inline action |
| --- | --- | --- | --- |
| Solution | file name, directory as description | QuickPick of all `.sln` in the workspace | edit (pencil) |
| Configuration | `Configuration \| Platform` | QuickPick of solution configurations | edit |
| Startup project | project name | QuickPick of application projects; "show all" lists every C++ project | edit |
| Build | last result (succeeded / failed, time, duration) or live progress (done / total, elapsed, error count) | shows build output | Stop while building |
| IntelliSense | readiness icon (running, ok, partial, error) and counter as in the brief | shows log | Recompute |

View title buttons, all visible without opening a menu (user feedback after phase 1: everything needed to build and debug must be right in the panel): Build (incremental), Rebuild, Clean, Debug, Run without debugging; while a build runs they are replaced by Stop. Debug and Run arrive with phase 3. Overflow menu: Recompute IntelliSense, Open settings, Reload solution, Show log.

While a build runs the solution and configuration rows are locked (description says so) and IntelliSense computation is paused.

Default configuration when nothing is saved: `Release|x64` if present, otherwise the first one (brief, section 9). Default startup project when nothing is saved: the first application project in solution order.

### 4.2 Projects view

- Tree of solution folders and projects, nesting from the `NestedProjects` section of the `.sln`. Inside a folder: folders first, then projects, each alphabetical. The order never depends on build or IntelliSense progress, so rows do not jump.
- Project icon by `ConfigurationType`: application, dynamic library, static library, utility. Non-C++ projects, projects without a mapping for the current solution configuration, and projects whose file is missing are greyed out with the reason as description.
- Description: type and file count at rest; build or IntelliSense status while active (`building`, `built · 3s`, `2 errors`, `waiting`). The startup project's description includes `startup`.
- Error and warning state is shown as label colour and badge through a `FileDecorationProvider` (each project node has a synthetic `resourceUri`), the same mechanism the Explorer uses. Tooltip of a failed project shows the tail of the MSBuild output.
- A collapsed folder's description summarises its children when something is active (`building 3`, `1 error`).
- Inline actions on hover: Build project; Debug for application projects.
- Context menu: Build, Rebuild, Clean project; Set as startup project; Debug; Run without debugging; Open project file; Reveal in Explorer; Recompute IntelliSense for project; Copy path.
- View title: filter (by name, and "problems only"), Collapse all.

### 4.3 Status bar

Three compact items: configuration, startup project, IntelliSense counter. During a build: progress and error count. Clicking an item opens the matching QuickPick or focuses the panel.

### 4.4 Empty and error states

- No `.sln` in the workspace: welcome content in the Projects view (`viewsWelcome`) with a "Select solution" button.
- Visual Studio or MSBuild not found: the Status view shows an error row with a "Configure toolchain" action that opens `vssln.json` at the `toolchain` key.
- Invalid `vssln.json`: the JSON schema reports problems in the editor; the extension falls back to defaults for invalid values and shows a warning row in the Status view.

### 4.5 Integration with VS Code mechanisms

- Every action is a command and is available from the command palette.
- `Ctrl+Shift+B` works through a `TaskProvider` (section 6).
- `F5` works through a `DebugConfigurationProvider` (section 7) with no `launch.json`.
- Compiler errors reach the Problems panel through the `$msCompile` problem matcher.

### 4.6 Extensibility of the tree

Node model: every node has a kind and a children provider. v1 kinds: solution folder, project. Planned kinds: filter, file, references group, reference. A project node becomes collapsible when a children provider for it is registered; nothing else in the views changes.

## 5. Settings file

Location: `.vscode/vssln.json` in each workspace folder. Personal: not meant to be committed. The file is optional; without it everything works from sources 2 to 4 of the chain. It is created on the first change of a selection in the panel or by the "Open settings" command. When it is created inside a git repository and is not ignored, the extension offers to add it to `.git/info/exclude` (a local ignore; the shared `.gitignore` is never touched).

The panel writes selections into the file with `jsonc-parser` edits, so comments and formatting written by hand are preserved. A JSON schema is contributed through `jsonValidation` for completion and validation.

```jsonc
{
  // current selection, written by the panel
  "solution": "src/Engine.sln",            // relative to the workspace folder
  "configuration": "Release|x64",
  "startupProject": "Game",                // project name as in the .sln

  // toolchain: optional, vswhere by default
  "toolchain": {
    "vsVersion": "[16,17)",                // vswhere version range, or "latest" (default)
    "msbuildPath": null                    // explicit override, normally not needed
  },

  // applied to build, IntelliSense and debug; part of the IntelliSense cache key
  "environment": { "ENGINE_SDK": "${workspaceFolder}/sdk" },

  "build": {
    "buildBeforeDebug": true
  },

  "msbuild": {
    "properties": { "UseMultiToolTask": "true" },   // extra -p: for real builds
    "maxParallelism": 0                              // IntelliSense workers, 0 = cores / 2
  },

  // per-project overrides; anything not set comes from MSBuild
  "projects": {
    "Game": {
      "debug": {
        "program": null,                   // default: LocalDebuggerCommand, then TargetPath
        "args": ["--windowed"],
        "cwd": "${projectDir}",
        "env": { "LOG_LEVEL": "debug" },
        "console": "integratedTerminal",
        "byConfiguration": {
          "Debug|x64": { "args": ["--windowed", "--validate"] }
        }
      }
    }
  }
}
```

Rules:

- Paths are relative to the workspace folder or use variables. Variables: `${workspaceFolder}`, `${solutionDir}`, `${projectDir}`, `${targetPath}`, `${configuration}`, `${platform}`, `${env:NAME}`.
- `byConfiguration` entries override the project's `debug` block key by key for that solution configuration.
- `environment` replaces the brief's `envKeys`: its keys and values are part of the IntelliSense cache key automatically. This also removes the brief's caveat that a build depended on the environment VS Code was started with.
- Multi-root workspaces: one file per workspace folder; the solution QuickPick lists `.sln` files from all folders; settings come from the folder of the selected solution.
- The file is watched; external edits are applied without reload.

## 6. Build

Every build action is a VS Code task produced by a `TaskProvider` with `CustomExecution` and a pseudoterminal. Output goes to the task terminal, `$msCompile` fills the Problems panel, and the pseudoterminal also feeds the output parser that drives the tree.

- Solution: `MSBuild.exe <sln> -t:Build|Rebuild|Clean -p:Configuration=<c> -p:Platform=<p> -p:DevEnvDir=<dir> -m -nologo`, a file logger, extra properties from `msbuild.properties`, environment from `environment`. Spawned from Node with an argument array, no shell (brief, section 13).
- Single project: the same command on the `.sln` with a solution target, `-t:<Folder\Path\Project>` or `-t:<Folder\Path\Project>:Rebuild|Clean`, so the solution's configuration mapping and project dependencies apply as in Visual Studio. Target names follow MSBuild's solution target naming (characters such as `.` replaced by `_`).
- Progress: parsed from MSBuild console output (project started, project finished, errors, warnings) into per-project build states. This format is the main risk of this part and is verified first against a real solution; fallback is to show only the final result and the error list.
- Dirty editors are saved by VS Code before every task (its `task.saveBeforeRun` setting). Clean and Rebuild ask for a modal confirmation. Stop kills the whole process tree (`taskkill /t /f`).
- Mutual exclusion: a build pauses the IntelliSense computation and resumes it afterwards; the solution and configuration cannot be changed during a build; only one build runs at a time.

## 7. Run and debug

Triggered by `F5`, the Debug and Run buttons, or the project context menu.

1. Build first (`build.buildBeforeDebug`): the target project with its dependencies through the solution target. A failed build cancels the launch and reveals the Problems panel.
2. Resolve launch parameters for the project and the current configuration. Base values come from MSBuild through the same design-time custom target used for IntelliSense, cached with the same hash-based freshness:
   - `program`: `LocalDebuggerCommand`, falling back to `TargetPath`;
   - `args`: `LocalDebuggerCommandArguments`;
   - `cwd`: `LocalDebuggerWorkingDirectory`, falling back to `ProjectDir`;
   - `env`: `LocalDebuggerEnvironment` (parsed, honouring its merge flag) merged over `environment`.
   Then overrides from `projects.<name>.debug` and its `byConfiguration` entry are applied, and variables are expanded.
3. Start a `cppvsdbg` session with `program`, `args`, `cwd`, `environment`, `console`. Run without debugging uses the same configuration with `noDebug: true`.

A user may still write a `launch.json` entry with `"type": "vssln", "project": "Game"` (other fields optional); the provider's resolver fills in the rest. Commands usable as variables are contributed: `${command:vssln.targetPath}`, `${command:vssln.startupProject}`, `${command:vssln.configuration}`.

`ms-vscode.cpptools` is declared in `extensionDependencies`: it supplies `cppvsdbg` and the IntelliSense provider API.

## 8. IntelliSense

As in the brief (sections 2 to 8), with these changes:

- The solution and configuration come from the shared selection (section 4.1), not from the panel of the prototype.
- MSBuild and `DevEnvDir` come from `toolchain/vswhere` unless overridden.
- `envKeys` is replaced by `environment` (section 5).
- Progress and per-project status feed the Status row, project descriptions and decorations instead of a webview.
- Pausing during a build is driven by the coordinator (section 9).

The open question of the brief (cpptools re-query after `didChangeCustomConfiguration`, automatic provider selection) is verified at the start of phase 4.

## 9. Architecture

| Module | Responsibility | Seam for tests |
| --- | --- | --- |
| `solution/slnParser` | projects, solution folders (`NestedProjects`), solution configurations and mapping, project dependencies | pure |
| `solution/model` | node kinds and children providers | pure |
| `settings/file` | read, validate, write (jsonc edits), watch | injected fs |
| `settings/resolver` | value chain, variable expansion | pure |
| `toolchain/vswhere` | locate Visual Studio, MSBuild, `DevEnvDir` | injected `exec` |
| `msbuild/*` | as in the brief, plus project properties for debugging (`TargetPath`, `LocalDebugger*`) from the same custom target | injected `exec` / `exists` |
| `build/args` | MSBuild command lines for solution and project targets | pure |
| `build/outputParser` | console output to per-project build events | pure |
| `build/task` | `TaskProvider`, pseudoterminal, process tree kill | injected `spawn` / `kill` |
| `debug/launchResolver` | properties plus overrides to a `cppvsdbg` configuration | pure |
| `debug/provider` | `DebugConfigurationProvider`, command variables | thin |
| `intellisense/*` | engine, cache, scheduler, invalidator, fileIndex, provider (brief, section 11) | as in the brief |
| `state/store` | single application state: selection, build state, IntelliSense progress, per-project status; change events | pure |
| `state/coordinator` | mutual exclusion of build and IntelliSense, selection locking | injected engine and build runner |
| `ui/viewModel` | state to tree items, decorations, status bar items | pure |
| `ui/*` | tree data providers, QuickPicks, status bar, welcome views | manual |
| `extension` | wiring only | manual |

Data flow: `settings/file` and `solution/slnParser` feed `state/store`; user actions go through commands to `state/coordinator`, which starts build tasks, debug sessions or IntelliSense work; all of them report back into `state/store`; `ui/viewModel` derives what the views show, and view updates are coalesced.

Stack as in the brief: TypeScript, esbuild bundle, vitest, `vscode-cpptools` types, `vsce package --no-dependencies`; plus `jsonc-parser`.

## 10. Error handling

- Toolchain missing: error row with a "Configure toolchain" action; build, debug and IntelliSense commands explain the problem instead of failing silently.
- Settings file invalid: schema diagnostics, defaults for invalid values, warning row.
- Project missing on disk or without mapping: greyed node with reason; skipped by IntelliSense (brief, section 6); build actions hidden.
- A failure in one project (IntelliSense or debug property evaluation) never stops the others; the node shows the error, the tooltip shows the MSBuild output tail.
- Build failure: Build row and project nodes show errors; Problems panel has the diagnostics.
- Debug launch failure (program not found, build failed): error message naming the resolved program path and where each value came from (MSBuild or settings file).

## 11. Testing

- Unit tests (vitest) for every pure module with fixtures: `.sln` files with nested folders, non-C++ projects, missing mappings; captured MSBuild console output for builds with and without errors; sample `vssln.json` files including invalid ones; captured design-time property dumps.
- A small integration test with `@vscode/test-electron`: the extension activates on a fixture workspace and the Projects view shows the fixture tree.
- A manual checklist on a real solution: build, rebuild, clean, stop, project build, debug, run, IntelliSense readiness, configuration switch.

## 12. Phases

1. Skeleton, `.sln` parser, model, settings file and resolver, `vswhere`, both views, status bar, QuickPicks.
2. Build: task provider, output parser, per-project progress, Problems integration. Starts by verifying the MSBuild output format.
3. Debug: debug property evaluation, launch resolver, debug configuration provider, build before launch.
4. IntelliSense: port of the brief's pipeline into the shared state; starts by verifying the brief's open question about cpptools re-query and provider selection.

## 13. Risks

- MSBuild console output may not identify projects reliably under `-m`; fallback described in section 6.
- `LocalDebuggerEnvironment` format and merge semantics need verification against a real `.vcxproj.user`.
- cpptools re-query behaviour (brief, section 14).
- Only the VS 2019 toolset was exercised by the prototype; `vswhere` range defaults to the latest instance, which may be newer.
