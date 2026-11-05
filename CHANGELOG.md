# Changelog

All notable changes to the VS Solution extension. Versions follow the development phases; the package version goes up with every package build.

## 0.5.3 — 2026-11-05

### Changed

- Published on GitHub under the MIT license, with a README. The extension id is now `andreiorson.vssln`: uninstall the earlier `local.vssln` after installing this version.
- A new side bar icon: the letters VS in a frame.

## 0.5.2 — 2026-10-23

### Fixed

- **Build output stopped after a project printed "Build succeeded."** A project whose build runs other builds (conan building packages) prints those words itself; they were taken for MSBuild's final summary, and in waves the rest of that run was hidden. Only MSBuild's own summary, at the start of a line, counts now.

## 0.5.1 — 2026-10-23

### Fixed

- **Build in waves sees references added by property sheets.** A `ProjectReference` that a shared `.props` adds (for example every project's reference to a conan project) did not order the waves, so such projects ran in the first wave beside the project they depend on. References are now read when a build starts the way MSBuild evaluates them for the configuration: through imported sheets and `Directory.Build.props`, with properties, environment variables, the build's global properties, conditions, `Choose` and the common path functions. A reference also names its project by the `<Project>` guid when its path needs MSBuild.
- The output names each reference that could not be read without MSBuild (`Game: the project reference … could not be read without MSBuild; the build order does not include it.`).
- Stop during the first moment of a build (while references are read) stops it.

## 0.5.0 — 2026-10-23

### Added

- **Build in waves.** Build and Rebuild of the solution run MSBuild once per level of the dependency graph (`.sln` project dependencies and `ProjectReference`s), each on a generated solution filter, so a project that imports a file another project produces (for example conan's `conandeps.props`) is evaluated only after that project has built. Before, MSBuild evaluated every project up front and failed with `MSB4019` on a clean checkout.
  - The output shows `Wave i/n: …` before each run, keeps one project numbering and ends with one summary.
  - When a project fails, the projects that depend on it are not built and say why; the others go on.
  - A dependency cycle, or MSBuild older than 16.7 (Visual Studio 2019 16.7), falls back to one run with a message; `"build": { "waves": false }` in `vssln.json` turns waves off.
- The sample solution has a producer project (`Tools/Deps`) whose generated sheet `Platform` imports.

### Changed

- Build results and the output follow every project type of the solution (utility and other `*proj` projects), not only C++ projects.
- IntelliSense tries again a project that could not be read because an imported sheet was missing (`MSB4019`) once property sheets change, for example after a build wrote it.
- The side bar icon is the Visual Studio mark.

## 0.4.0 — 2026-10-22

### Added

- **IntelliSense from MSBuild.** Every C++ project of the selected solution configuration gets the compiler flags of the real build (include directories, defines, forced includes, language standard) through Visual Studio's design-time command lines, and the C/C++ extension uses them as a custom configuration provider; no provider selection is needed.
  - Headers get their project's default options; a header in a shared folder (for example `Core\include`) takes a project whose include directories hold it, the startup project first.
  - Results are cached by the content of every file the evaluation read; a reload takes unchanged projects from the cache, and a changed `.props`/`.targets` or a new `Directory.Build.props` recomputes only the projects that depend on it.
  - The Status view shows an IntelliSense row (spinner and `computing N · k / n ready`, a green check when ready, a warning on failures), project rows show their IntelliSense state while it runs, and the status bar counts too.
  - Recompute IntelliSense (Status view) and Recompute IntelliSense for Project (project context menu).
  - A build pauses the computation; it resumes when the build ends.
- **Filters and files in the Projects tree.** A C++ project expands to the filters of its `.vcxproj.filters` and its files, as in Solution Explorer; a click opens a file, missing files are greyed out and come back when created, without a reload. Reveal in Explorer and Copy path work on files.
- **Sync with Active Document.** A button in the Projects title selects the active editor's file in the tree, expanding its project and filters.

### Changed

- **Build output reads like Visual Studio's.** Projects are numbered with a header (`2>------ Rebuild All started: Project: Render, Configuration: Release x64 ------`), followed by compiled files, linker and build event messages, outputs and the project result; MSBuild's bookkeeping (target names, tool command lines, object file lists, `.tlog` notes) is hidden.

## 0.3.0 — 2026-10-22

### Added

- **Debug and Run.** Debug and Run buttons in the Status view, Debug and Run for application projects in the Projects tree, `F5` / `Ctrl+F5` for the startup project. The project is built first; a failed build cancels the launch and opens Problems.
- Launch settings come from MSBuild in the context of a solution build (`TargetPath`, `LocalDebugger*` and the project's `.vcxproj.user`), with `%VAR%` expanded like Visual Studio does, then from `projects.<name>.debug` in `vssln.json`.
- Debugging uses the C/C++ extension's `cppvsdbg` with arguments passed exactly; Run without debugging uses the extension's own small debug adapter: output in the Debug Console, no terminal, Stop ends the whole process tree.
- `launch.json` entries of type `vssln` that name a project; other fields go through to `cppvsdbg`.
- Open settings goes to `projects.<name>.debug` when a project needs a program to start.

## 0.2.0 — 2026-10-22

### Added

- **Build, Rebuild, Clean and Stop** right in the Status view (Rebuild and Clean ask first), for the solution and for single projects, and `Ctrl+Shift+B`.
- Build progress per project in the panel and in the status bar; results in green, yellow and red.
- Build output in its own Output channel with colors, and compiler and linker errors in Problems; MSBuild output in English whatever the system language.
- Live filter for the Projects tree (`Ctrl+Alt+F`).

## 0.1.0 — 2026-10-22

### Added

- Side bar with the Status view (solution, configuration, startup project) and the Projects view (solution folders and projects as in Solution Explorer, project type icons and file counts, greyed-out inactive projects).
- Personal settings in `.vscode/vssln.json`, edited without losing comments, with a JSON schema; it is offered for `.git/info/exclude`.
- Visual Studio and MSBuild found through `vswhere`, or set in the settings.
- Solution, configuration and startup project pickers; the solution reloads when its files change.
