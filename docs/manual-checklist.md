# Manual checklist: phase 1 (panel and settings)

Run on `samples/Engine` (the "Run extension on samples/Engine" launch configuration in `.vscode/launch.json`), and on a real work solution when one is available. Delete `samples/Engine/.vscode/` afterwards.

## Panel

- [ ] The VS Solution icon appears in the activity bar; the panel has the Status and Projects views.
- [ ] Status shows `Engine.sln` with description `.`, `Release | x64`, and `Game` with description `startup`.
- [ ] The status bar shows `Release|x64` and `Game`; clicking each opens the matching picker.
- [ ] Projects shows the folders `Core`, `Graphics`, `Tests`, `Tools`, then `Audio`, `Game`, `Missing`, the same structure as Solution Explorer in Visual Studio.
- [ ] `Legacy` (`not in Release|x64`) and `Missing` (`file not found`) are greyed out; their tooltips give the reason.
- [ ] Projects have type icons and descriptions (`exe · 1 file · startup`, `dll · 4 files`, …).
- [ ] Typing in the Projects view filters by name; Collapse all works.
- [ ] Context menu of a project: Set as startup project, Open project file, Reveal in File Explorer, Copy path; a folder has no such entries.

## Projects filter

- [ ] The funnel button in the Projects title (or `Ctrl+Alt+F` with the tree focused) opens an input; typing `gra ren` leaves `Core › Graphics › Render` with the folders open, the view title shows `filter: gra ren · 1 of 12`.
- [ ] A folder name (`tools`) keeps every project inside it; `xyz` shows `No projects match "xyz".`.
- [ ] Enter keeps the filter, Escape brings the previous one back, the ✕ button clears it; the full tree comes back with its earlier expansion state.

## Selection and settings file

- [ ] Pick `Debug | x64` in the configuration picker: `.vscode/vssln.json` is created with `"configuration": "Debug|x64"`, and `Legacy` stays greyed out.
- [ ] Right after the file is created, the prompt about `.git/info/exclude` appears once (inside a git repository only); "Add to exclude" adds `/.vscode/vssln.json` to `.git/info/exclude` and not to `.gitignore`.
- [ ] Startup picker lists only `Game`, `Editor`, `AssetCooker`, `MathTests` plus "Show all projects…"; picking `Show all` lists every C++ project; choosing `Math` makes `Math` the startup project.
- [ ] Add a comment line to `vssln.json`, change the configuration again: the comment survives.
- [ ] Edit `vssln.json` by hand (for example `"configuration": "Release|Win32"`): the panel follows without a reload.
- [ ] Set `"configuration": "Profile|x64"`: a warning row appears, the panel falls back to `Release | x64`, the file is not rewritten.
- [ ] Break the JSON (remove a closing brace): an error row appears; changing the configuration shows "vssln.json has a syntax error…" and the file is not touched.
- [ ] Delete `vssln.json`: defaults return.
- [ ] Completion and validation of keys work while editing `vssln.json` (schema).

## Build

- [ ] The Status view title shows Build, Rebuild and Clean buttons without opening a menu; Open settings, Reload solution and Show log are in the `…` menu.
- [ ] Build: a Build row appears with `done/total · m:ss`; projects show `waiting`, `building` (spinning icon), `built · Ns`; the terminal shows a short log (`Math: succeeded`, outputs, summary) and `Build log: …`; the status bar shows `Building n/m`.
- [ ] While building, the title shows only Stop, the solution and configuration rows say `locked during build`, and changing the configuration is refused with a message.
- [ ] Stop during a Rebuild: the build ends as `stopped`, no MSBuild, cl or link process remains in Task Manager.
- [ ] Rebuild and Clean ask for confirmation; Cancel does nothing.
- [ ] Break the build (`"environment": { "CL": "/DENGINE_BREAK_BUILD" }` in `vssln.json`), Build: `Math` turns red with a badge, its tooltip shows the error, `Core` says `1 error`, Problems has the C1189 error and clicking it opens `vector.cpp` at line 4.
- [ ] Hover a project: the hammer builds only that project (and its dependencies); its context menu has Build, Rebuild and Clean project.
- [ ] `Ctrl+Shift+B` offers the VS Solution build tasks.
- [ ] A linker error (`"environment": { "LINK": "/INCLUDE:missing_symbol" }`) shows in Problems on the project file.
- [ ] Windows with another display language (or VS Code started with `DOTNET_CLI_UI_LANGUAGE=ru-RU`): the build terminal is still in English and progress works.
- [ ] A copy of the solution in a folder with Cyrillic letters builds with progress and clickable errors.
- [ ] Ctrl+Shift+B on a running build, then "Restart Task": the old build stops and the new one starts without an error.

## Toolchain

- [ ] With Visual Studio installed and no `toolchain` settings: no error row; the log (Show log) names the Visual Studio instance.
- [ ] Set `"toolchain": { "vsVersion": "[99,100)" }`: an error row "No Visual Studio with MSBuild in version range [99,100)." appears, the project tree is still there; clicking the row opens `vssln.json` at `toolchain`.

## Workspace without a solution

- [ ] Open a folder without `.sln`: the Projects view shows "No solution found in this workspace." with Reload and Open Folder links.

## Watching

- [ ] Delete a project folder (for example `samples/Engine/Tools/Legacy`) and restore it with git: the project turns into `file not found` and back without a manual reload.
- [ ] The configuration and solution pickers mark the current entry with `current`.
