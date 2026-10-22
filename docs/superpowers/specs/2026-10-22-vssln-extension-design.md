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

- References nodes under a project (filters and files were added after v1, section 4.7).
- Editing projects (adding files, changing properties).
- C# and other project types; non-Windows platforms.
- Batch build, multiple startup projects.

## 3. Principles

- **No personal values in code or in VS Code settings.** Every value is resolved by a chain; the first source that has it wins:
  1. the workspace settings file `.vscode/vssln.json`;
  2. the `.sln` and MSBuild evaluation (configurations, project mapping, `TargetPath`, `LocalDebugger*` including a `.vcxproj.user` if present, `IncludePath`);
  3. automatic discovery (Visual Studio and MSBuild through `vswhere`, `DevEnvDir` of the found instance);
  4. built-in defaults.
- **Native VS Code mechanisms first.** Tree views, QuickPick, Output channels, the Problems collection, debug configuration providers. No webview in v1.
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

Three compact items: configuration, startup project, IntelliSense counter. During a build: progress and error count. After a build: `✓ Built m:ss` (`Rebuilt`, `Cleaned`; `⚠ … · N warnings` when there were warnings), or a red background with the error count (`Build failed` when MSBuild failed without a recognised error). No text colors: green on the blue or orange (debugging) status bar is unreadable.

### 4.4 Empty and error states

- No `.sln` in the workspace: welcome content in the Projects view (`viewsWelcome`) with a "Select solution" button.
- Visual Studio or MSBuild not found: the Status view shows an error row with a "Configure toolchain" action that opens `vssln.json` at the `toolchain` key.
- Invalid `vssln.json`: the JSON schema reports problems in the editor; the extension falls back to defaults for invalid values and shows a warning row in the Status view.

### 4.5 Integration with VS Code mechanisms

- Every action is a command and is available from the command palette.
- `Ctrl+Shift+B` runs Build solution while a solution is loaded (keybinding `vssln.build`, when `vssln.phase == ready`; during a build it says the build is already running). It takes the place of the workspace's default build task while a solution is loaded; `-vssln.build` in keybindings.json gives it back. From a focused terminal the keys go to the shell unless `vssln.build` is added to `terminal.integrated.commandsToSkipShell`.
- `F5` works through a `DebugConfigurationProvider` (section 7) with no `launch.json`.
- Compiler and linker errors reach the Problems panel through the extension's own diagnostic collection (source `MSBuild`); errors without a source position are shown on the project file.

### 4.6 Extensibility of the tree

Node model: every node has a kind and a children provider. v1 kinds: solution folder, project; then filter and file (section 4.7). Planned kinds: references group, reference. A project node becomes collapsible when a children provider for it is registered; nothing else in the views changes.

### 4.7 Filters and files

- A C++ project whose file exists expands to its filters and files, as in Solution Explorer. Filters come from `.vcxproj.filters` (`Source Files\Sub` becomes nested nodes); a file sits under the filter its `<Filter>` names. Files without a filter, and all files when there is no `.filters` file, sit directly under the project. Inside a node: filters first, then files, each alphabetical ignoring case. Declared filters without files are shown, empty.
- Items: every element with an `Include` inside an `<ItemGroup>` of the `.vcxproj` (not inside a `<Target>`, whose items exist only during a build, and not in comments), except item types that are not files (`ProjectConfiguration`, `ProjectReference`, `Reference`, `SDKReference`, `COMReference`, `COMFileReference`, `NativeReference`, `Folder`, `Filter`, `ProjectCapability`, `PackageReference`, `ProjectTools`, `Service`, `BuildMacro`). UTF-8 and UTF-16 project files are read. An `Include` with `;` gives several items; conditions are ignored (every configuration shows the same files, like Solution Explorer); the same path twice is one node. Items from imported `.props`/`.targets` are not shown: the project file is read as text, without MSBuild.
- Paths are relative to the project directory. `$(ProjectDir)`, `$(MSBuildProjectDirectory)`, `$(MSBuildThisFileDirectory)`, `$(SolutionDir)`, `$(ProjectName)`, `$(MSBuildProjectName)` and `$(SolutionName)` are substituted (names ignore case); XML entities and MSBuild `%XX` escapes are decoded. An item with any other `$(...)`, `@(...)` or a wildcard keeps its raw text as label, the description `not evaluated`, and cannot be opened.
- File node: label is the file name, tooltip the full path, icon from the file icon theme, a click opens the file (as a preview, like the Explorer). A file missing on disk is greyed out with the description `file not found`. Context menu: Reveal in Explorer, Copy path. Filter node: folder icon from the theme, no description.
- Node ids are stable across reloads (`<project guid>/f/<filter path>`, `<project guid>/i/<file path>`, lower case), so expanded nodes stay expanded.
- Reading: the `.vcxproj.filters` is read with its `.vcxproj` when the solution loads (both are small); whether files exist is checked when a project is expanded, and again when it is collapsed and expanded (for files outside the workspace, which no watcher sees). A change of a `.vcxproj.filters` reloads like a `.vcxproj` change; creating or deleting a file a project lists, or a folder above one (restoring a deleted folder is one event), refreshes the tree without a reload.
- The live filter still matches projects and folders; a matching project keeps all its files.
- Sync with Active Document, as in Visual Studio: a button in the Projects title (`$(arrow-swap)`, also in the command palette) selects the active editor's file in the tree, expanding its project and filters, and focuses the tree. Nothing follows the editor on its own. A file listed by several projects is shown in the startup project when it lists the file, otherwise in the first one in solution order. A file in no project of the solution, or no file open, gets an information message saying so. When the live filter hides the project, the message offers Clear filter, which clears it and selects the file.
- Later: Compile file (`Ctrl+F7`), filtering by file names, the references node.

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

Build output goes to one Output channel, `VS Solution: Build`, cleared at the start of every build and colored by a small grammar (errors red, warnings yellow, results green or red, project headers blue). It shows the build as Visual Studio's minimal output does (user feedback: the first version showed only results): projects numbered in the order they start work with a header (`2>------ Rebuild All started: Project: Render, Configuration: Release x64 ------`), then every line of the project prefixed with its number (compiled files, custom build messages, linker messages, `X.vcxproj -> …`, diagnostics) and its result (`2>Render: succeeded`), then MSBuild's summary. MSBuild's bookkeeping is hidden: target names, tool command lines and the object files echoed after them (absolute or relative), `.tlog` and directory messages, up-to-date notes, the solution's own start line and the batch wrapper Visual Studio puts around build events (`setlocal`, `:VCEnd`, …). Only the work of the action is numbered and gets a header: a Clean that a Rebuild calls on a reference on the side does not. User feedback after phase 2 replaced the earlier VS Code tasks: every task opened its own terminal. The extension fills Problems itself from the parsed diagnostics. Results are also colored in the panel (green, yellow, red icons; red label and badge for failed projects; green or red Build row) and in the status bar (green `Built m:ss`, red background with the error count).

- Solution: `MSBuild.exe <sln> -t:Build|Rebuild|Clean -p:Configuration=<c> -p:Platform=<p> -p:DevEnvDir=<dir> -m -nologo`, a file logger, extra properties from `msbuild.properties`, environment from `environment`. Spawned from Node with an argument array, no shell (brief, section 13).
- Single project: the same command on the `.sln` with a solution target, `-t:<Folder\Path\Project>` or `-t:<Folder\Path\Project>:Rebuild|Clean`, so the solution's configuration mapping and project dependencies apply as in Visual Studio. Target names follow MSBuild's solution target naming (characters such as `.` replaced by `_`).
- Progress: parsed from MSBuild console output (project started, project finished, errors, warnings) into per-project build states. This format is the main risk of this part and is verified first against a real solution; fallback is to show only the final result and the error list.
- Dirty editors are saved before every build, as Visual Studio does. Clean and Rebuild ask for a modal confirmation. Stop kills the whole process tree (`taskkill /t /f`).
- Mutual exclusion: a build pauses the IntelliSense computation and resumes it afterwards; the solution and configuration cannot be changed during a build; only one build runs at a time.

## 7. Run and debug

Triggered by `F5`, the Debug and Run buttons, or the project context menu.

1. Build first (`build.buildBeforeDebug`): the target project with its dependencies through the solution target. A failed build cancels the launch and reveals the Problems panel.
2. Resolve launch parameters for the project and the current configuration. Base values come from MSBuild, read on every launch (no cache: one evaluation takes about 0.2 s) in the same context a solution build gives the project (its mapped `Configuration|Platform`, the `Solution*` properties, `msbuild.properties` and the settings environment):
   - `program`: `LocalDebuggerCommand`, falling back to `TargetPath`;
   - `args`: `LocalDebuggerCommandArguments`;
   - `cwd`: `LocalDebuggerWorkingDirectory`, falling back to `ProjectDir`;
   - `env`: `LocalDebuggerEnvironment` (one `NAME=value` per line, `%VAR%` expanded like Visual Studio) applied over `environment`.
   Then overrides from `projects.<name>.debug` and its `byConfiguration` entry are applied, and variables are expanded. Relative paths from the settings resolve against the workspace folder, those from MSBuild against the project directory.
3. Debug: start a `cppvsdbg` session with `program`, `args`, `cwd`, `environment`, `console` (default `internalConsole`, the Debug Console, so no terminal opens per launch). `args` goes to cppvsdbg as one command line, because an args array loses empty arguments: the `.vcxproj.user` string as written, or listed arguments joined with Windows quoting. Run without debugging uses the extension's own small debug adapter (type `vssln`), which starts the program without a shell, shows its output in the Debug Console and stops the whole process tree on Stop; terminal consoles go through the `runInTerminal` request. F5 / Ctrl+F5 debug / run the startup project while a solution is loaded and no session runs. `-vssln.debug` / `-vssln.run` in keybindings.json give the keys back to VS Code; with the focus in the integrated terminal the keys go to the shell, as for any extension command. The launch properties come from a small targets file (`resources/vssln-debug.targets`) hooked in through `CustomAfterMicrosoftCommonTargets`, which also works with VS 2019. `%VAR%` in `LocalDebuggerEnvironment` is expanded like Visual Studio does; `LocalDebuggerMergeEnvironment=false` cannot be reproduced (cppvsdbg only adds variables); a warning in the log says so.

A user may still write a `launch.json` entry with `"type": "vssln", "project": "Game"` (other fields optional); the provider's resolver fills in the rest. Build before launch goes through the same build path as the panel (`Builds.run`); there are no VS Code tasks to use as `preLaunchTask` (they were removed with the move to the Output channel).

`ms-vscode.cpptools` is declared in `extensionDependencies`: it supplies `cppvsdbg` and the IntelliSense provider API.

## 8. IntelliSense

As in the brief (sections 2 to 8), with the changes below. The solution and configuration come from the shared selection (section 4.1), MSBuild and `DevEnvDir` from `toolchain/vswhere`, `envKeys` is replaced by `environment` (section 5), and progress feeds the Status view, project rows and the status bar instead of a webview.

### 8.1 Verified at the start of phase 4 (VS 2026, MSBuild 18, toolset v145, cpptools 1.34.4, `samples/Engine`)

- **No hand-copied task call.** The stock `GetClCommandLines` target (`Microsoft.Cpp.DesignTime.targets`) returns one `ClCommandLines` item per option set, and each item carries the sources it applies to in `%(Files)`. A targets file of our own (`resources/vssln-intellisense.targets`, hooked in through `CustomAfterMicrosoftCommonTargets`, as for debugging) depends on `GetProjectDirectories;GetClCommandLines` and prints `VSSLN|CL|<ConfigurationOptions>|<files>|<command line>`, `VSSLN|IncludePath|…`, `VSSLN|ExternalIncludePath|…` with `<Message>`, which keeps `;` intact (the brief's `WriteLinesToFile` trap does not arise). The brief's per-file target with a copied `CLCommandLine` parameter list is not needed.
- The item with `ConfigurationOptions=true` (the stock target adds a fake `__temporary.cpp` for it) is the project's default command line: the one Visual Studio uses for headers. Its `Files` are the real sources that share those options.
- Items with `/scanModules` (the standard library modules `std.ixx`, `std.compat.ixx`) are not project files and are skipped.
- `$(IncludePath)` holds the MSVC, ATL/MFC and Windows SDK include directories; `$(ExternalIncludePath)` holds the same here. The command line has none of them, so both are appended (without duplicates).
- One project takes about 0.5 s for the command lines and 0.2 s for `-preprocess` (310 imported files for a plain C++ project).
- **cpptools needs no provider selection.** With no `C_Cpp.default.configurationProvider` and no `c_cpp_properties.json`, cpptools 1.34 asks a registered provider for every opened file. After `didChangeCustomConfiguration` it asks again about files it was refused before (`canProvideConfiguration` false, then true) and takes their configuration. The brief's open question is closed; the setting is not written by the extension.

### 8.2 Design

- **Run.** Per project, two MSBuild runs in the context a solution build gives it (mapped `Configuration|Platform`, `Solution*` properties, `DevEnvDir`, `msbuild.properties`, the settings `environment`, English output), plus the design-time properties of the brief (4.1): the command lines with `-t:VsslnIntelliSense`, and `-preprocess` for the input files. No shell, argument arrays, a timeout per run.
- **Records.** A command line is split with the MSVC rules (`debug/commandLine`) and mapped to `includePath` (`/I`, then the system directories), `defines` (`/D`; `/U` removes), `forcedInclude` (`/FI`), `standard` (`/std:c++14|17|20` → the same, `/std:c++23preview|latest` and any newer C++ value → `c++23`, `/std:c11|c17|clatest` for C files compiled with `/TC` or a `.c` extension; default `c++14` / `c17`), `intelliSenseMode` from the platform (`x64` → `windows-msvc-x64`, `Win32` → `windows-msvc-x86`, `ARM64` → `windows-msvc-arm64`). Precompiled header switches are dropped (cpptools reads the `#include` instead). Relative `/I`, `/external:I` and `/FI` paths are resolved against the project folder, where cl runs.
- **From a file to its configuration.** A source file listed in a record has that record. A file of a project without a record of its own (headers, excluded sources) gets the project's default command line. A file listed by several projects takes the startup project when it lists the file, otherwise the first in solution order (the rule of Sync with Active Document). A file in no project but inside a project's directory takes the nearest such project's default command line. A file in neither (a header in a shared folder such as `Core\include\engine\render.h`) takes the default command line of a project whose own include directories (`/I`, not the system ones) hold it, the startup project first, then solution order. Other files get no answer, so cpptools uses its defaults. Project membership comes from the items already loaded for the tree (section 4.7), so it is known before any MSBuild run.
- **Cache.** One JSON file per project and configuration under the extension's workspace storage, written atomically; a corrupt file is a miss. Key: MSBuild path, project path, its mapped configuration and platform, solution path, `msbuild.properties`, `environment`, and a version of the targets file. Inputs: the files `-preprocess` names, with SHA-1 content hashes, plus commented-out imports that resolve to a path that does not exist (watched for appearing), as in the brief (4.6), plus `Directory.Build.props` and `Directory.Build.targets` in the project folder and every folder above it that do not exist (MSBuild looks for them there through `$(DirectoryBuildPropsPath)`, which `-preprocess` leaves unexpanded). A cache entry that cannot be written (a locked folder) is logged; the data is used anyway. An entry is fresh when the key matches, every input has the same hash and no awaited file appeared. Hashes of shared files are computed once per pass.
- **Scheduling.** All C++ projects that exist and are mapped in the current configuration, `msbuild.maxParallelism` workers (0: half the cores, at least 1). Projects of open editors first; switching the active editor moves its project to the front. A failure never stops the others. A configuration or solution change cancels the pass (kills the processes, writes nothing) and starts a new one; cache files of other configurations stay, so switching back is instant.
- **Builds.** A build and the computation never run at the same time: starting a build cancels the running MSBuild processes of the pass (their projects go back to the queue); the pass resumes when the build ends.
- **Freshness while working.** A solution reload (a `.vcxproj`, `.filters`, `.sln` or `vssln.json` change) re-checks every project against its cache entry and recomputes the stale ones. A change of a `.props` or `.targets` inside the workspace re-checks the projects that list it as an input or await it, and starts the running ones over (MSBuild may have read the file before it changed). A reload that finds the same data does not make cpptools ask about the open files again. Inputs outside the workspace (Visual Studio itself) are re-checked on every reload and by Recompute.
- **cpptools.** The provider (`vscode-cpptools` API v6) is registered when the extension starts and answers `canProvideConfiguration` with true only for files that have a configuration now; browse configuration is declined. After projects become ready, `didChangeCustomConfiguration` is sent, coalesced to at most one per second.
- **UI.**
  - Status view: an IntelliSense row: icon `sync~spin` while computing, `check` (green) when everything is ready, `warning` when some projects failed; description `12 / 15 ready`, `computing 3 · 12 / 15`, `2 failed · 13 / 15`; click shows the log; inline action Recompute.
  - Project rows: while the pass runs, a project without data shows `IntelliSense: waiting` or `IntelliSense: computing` after its usual description; a failed one shows `IntelliSense failed` with the MSBuild output tail in the tooltip. Build state wins over IntelliSense state in the description.
  - Status bar: `$(sync~spin) IntelliSense 12/15` while computing; `$(warning) IntelliSense 2 failed` after failures; hidden when all is ready.
  - Commands: Recompute IntelliSense (Status overflow menu and IntelliSense row: drops the cache entries of the current configuration and recomputes everything with MSBuild, whatever the cache says) and Recompute IntelliSense for project (project context menu; a running project starts over).
- **Log.** One line per computed project (`Render: 0.7 s`, `Render: from cache`, `Audio: failed, see below` with the output tail) in the VS Solution log channel.

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
| `ui/builds` | Output channel, Problems collection, confirmation, Stop | manual (integration tests) |
| `debug/launchResolver` | properties plus overrides to a `cppvsdbg` configuration | pure |
| `debug/provider` | `DebugConfigurationProvider`, command variables | thin |
| `intellisense/*` | engine, cache, scheduler, invalidator, fileIndex, provider (brief, section 11) | as in the brief |
| `state/store` | single application state: selection, build state, IntelliSense progress, per-project status; change events | pure |
| `state/coordinator` | mutual exclusion of build and IntelliSense, selection locking | injected engine and build runner |
| `ui/viewModel` | state to tree items, decorations, status bar items | pure |
| `ui/*` | tree data providers, QuickPicks, status bar, welcome views | manual |
| `extension` | wiring only | manual |

Data flow: `settings/file` and `solution/slnParser` feed `state/store`; user actions go through commands to `state/coordinator`, which starts builds, debug sessions or IntelliSense work; all of them report back into `state/store`; `ui/viewModel` derives what the views show, and view updates are coalesced.

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
2. Build: MSBuild arguments, output parser, per-project progress, Output channel with colors, Problems collection, Stop. Starts by verifying the MSBuild output format.
3. Debug: debug property evaluation, launch resolver, debug configuration provider, build before launch.
4. IntelliSense: port of the brief's pipeline into the shared state; starts by verifying the brief's open question about cpptools re-query and provider selection.

## 13. Risks

- MSBuild console output may not identify projects reliably under `-m`; fallback described in section 6.
- `LocalDebuggerEnvironment` format and merge semantics need verification against a real `.vcxproj.user`.
- cpptools re-query behaviour (brief, section 14).
- Only the VS 2019 toolset was exercised by the prototype; `vswhere` range defaults to the latest instance, which may be newer.
