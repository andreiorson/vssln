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

## Filters and files

- [ ] Expand `Graphics › Render`: `Header Files` and `Source Files` (as in Solution Explorer), then `pch.h` under `Header Files` and `frame.cpp`, `pch.cpp`, `render.cpp` under `Source Files`, with the icons of the file icon theme.
- [ ] A click on `render.cpp` opens it as a preview; the row shows the Explorer's git colour once the file is modified.
- [ ] Right-click a file: Reveal in Explorer and Copy path; there is no Build or Set as startup.
- [ ] Rename `Graphics/Render/frame.cpp` on disk: `frame.cpp` turns grey with `file not found`; renaming it back restores it, without a reload.
- [ ] Add `<ClCompile Include="extra.cpp"><Filter>Source Files\Extra</Filter></ClCompile>` to `Render.vcxproj.filters` and `<ClCompile Include="extra.cpp" />` to `Render.vcxproj`: after saving, `Source Files › Extra › extra.cpp` appears (grey), and expanded nodes stay expanded. Undo both edits.
- [ ] Collapse everything, open `Graphics/Render/frame.cpp`, press the ⇄ button (Sync with Active Document) in the Projects title: `Graphics › Render › Source Files` open and `frame.cpp` is selected, the tree has the focus. Switching editors afterwards does not move the selection.
- [ ] Sync with `Engine.sln` or `vssln.json` active: a message says the file is not in any project. With the filter `audio` and `frame.cpp` active: a message says Render is hidden by the filter; Clear filter clears it and selects the file.
- [ ] A project without a `.filters` file shows its files directly under the project; a library project (Audio) expands as well; `Legacy` (greyed, not in Release|x64) still shows its files, like Solution Explorer; `Missing` (file not found) has no arrow.

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
- [ ] Build: a Build row appears with `done/total · m:ss` and a blue spinner; projects show `waiting`, `building` (blue spinner), `built · Ns` (green icon); the `VS Solution: Build` Output channel opens with a short colored log (`Math: succeeded` in green, errors in red, `Build log: …`); no terminal is created; the status bar shows `Building n/m`, then a green `Built m:ss`.
- [ ] While building, the title shows only Stop, the solution and configuration rows say `locked during build`, and changing the configuration is refused with a message.
- [ ] Stop during a Rebuild: the build ends as `stopped`, no MSBuild, cl or link process remains in Task Manager.
- [ ] Rebuild and Clean ask for confirmation; Cancel does nothing.
- [ ] Break the build (`"environment": { "CL": "/DENGINE_BREAK_BUILD" }` in `vssln.json`), Build: `Math` turns red with a badge, its tooltip shows the error, `Core` says `1 error`, Problems has the C1189 error and clicking it opens `vector.cpp` at line 4.
- [ ] Hover a project: the hammer builds only that project (and its dependencies); its context menu has Build, Rebuild and Clean project.
- [ ] `Ctrl+Shift+B` builds the solution directly; pressed again during the build it says the build is already running (no "Configure Build Task" wizard).
- [ ] A linker error (`"environment": { "LINK": "/INCLUDE:missing_symbol" }`) shows in Problems on the project file.
- [ ] Windows with another display language (or VS Code started with `DOTNET_CLI_UI_LANGUAGE=ru-RU`): the build output is still in English and progress works.
- [ ] A copy of the solution in a folder with Cyrillic letters builds with progress and clickable errors.
- [ ] A failed build: the Build row and its icon are red, failed projects have red icons and labels with a badge, projects with warnings are yellow, skipped ones grey; the status bar turns red with the error count; the Rebuild button itself is not green. A successful build with warnings shows a yellow Build row and `⚠ Built m:ss · N warnings`.

- [ ] Problems: an error points at its line (C1189 at `vector.cpp` line 4); a warning repeated by many files appears once; a successful build clears the previous errors; switching the configuration clears them too.
- [ ] Edit `vssln.json` without saving (for example the `environment`), then Build: the build uses the edit.

## Run and debug

- [ ] The Status title shows Debug and Run buttons next to Build, Rebuild and Clean; they hide during a build and while debugging.
- [ ] F5 builds and debugs the startup project (Game): a breakpoint in `Game/main.cpp` is hit; the Debug Console shows `args: --windowed` and `GAME_MODE: sample` from `Game.vcxproj.user` (Release|x64). F5 in the session continues.
- [ ] Ctrl+F5 runs without debugging; no terminal is created, the output is in the Debug Console, followed by `… exited with code 0.`; Stop during a run ends the program and its children.
- [ ] `"console": "newExternalWindow"` for Game: Run opens a console window of its own.
- [ ] With the focus in the integrated terminal, F5 goes to the shell (no launch).
- [ ] Hover AssetCooker: the bug icon debugs it; its context menu has Debug and Run project.
- [ ] With `"projects": { "AssetCooker": { "debug": { "args": ["--fast"], "env": { "COOK_MODE": "manual" }, "cwd": "${projectDir}" } } }`, Run AssetCooker: `Tools/AssetCooker/cooked.txt` shows `argc=1`, `arg[1]=--fast` and `COOK_MODE=manual`. With `"args": ["", "x y"]` it shows `argc=2`, `arg[1]=` and `arg[2]=x y`, both for Run and for Debug.
- [ ] Debug project on Audio (a dll): a message asks to set `program` for it; Open settings opens `vssln.json` with the cursor on `projects.Audio.debug` (created when missing, comments kept).
- [ ] Break the build (`CL=/DENGINE_BREAK_BUILD`), F5: the build fails, Problems opens, the debugger does not start.
- [ ] A `launch.json` entry `{ "type": "vssln", "request": "launch", "name": "Game", "project": "Game", "args": ["x"] }` starts Game with `args: x`.

## Toolchain

- [ ] With Visual Studio installed and no `toolchain` settings: no error row; the log (Show log) names the Visual Studio instance.
- [ ] Set `"toolchain": { "vsVersion": "[99,100)" }`: an error row "No Visual Studio with MSBuild in version range [99,100)." appears, the project tree is still there; clicking the row opens `vssln.json` at `toolchain`.

## Workspace without a solution

- [ ] Open a folder without `.sln`: the Projects view shows "No solution found in this workspace." with Reload and Open Folder links.

## Watching

- [ ] Delete a project folder (for example `samples/Engine/Tools/Legacy`) and restore it with git: the project turns into `file not found` and back without a manual reload.
- [ ] The configuration and solution pickers mark the current entry with `current`.
