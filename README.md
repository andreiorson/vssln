# VS Solution

Work with Visual Studio C++ solutions (`.sln` and `.vcxproj`) in VS Code: a solution panel, build, debug, and IntelliSense that uses the compiler flags of the real build.

The extension reads the solution the way Visual Studio does and asks MSBuild for everything else, so property sheets, conditions and per-file settings work without a `compile_commands.json` or a CMake port.

## Features

- **Solution panel.** Pick the solution, the `Configuration|Platform` and the startup project. The Projects view shows solution folders, projects, and their filters and files, like Solution Explorer. Projects that the configuration doesn't build or that are missing are greyed out. `Ctrl+Alt+F` filters the tree; Sync with Active Document selects the open file.
- **Build.** Build, Rebuild, Clean and Stop for the solution or one project (`Ctrl+Shift+B` builds the solution). The output reads like Visual Studio's, with colours. Errors and warnings go to Problems, and each project shows its result in the tree and the status bar.
- **Build order in waves.** The solution builds in waves along the project dependencies (`.sln` dependencies and `ProjectReference` items, including ones that shared property sheets add), so a project is read by MSBuild only after the projects it depends on are built. A project that imports a file another project generates, such as conan's `conandeps.props`, then builds from a clean state.
- **Debug and Run.** `F5` debugs the startup project with the C/C++ extension's Visual Studio debugger, and `Ctrl+F5` runs it without debugging. The command, arguments, working directory and environment come from MSBuild and the project's `.vcxproj.user`, like in Visual Studio.
- **IntelliSense.** Every C++ project gets the include paths, defines, forced includes and language standard of its real build, through Visual Studio's design-time build. The C/C++ extension uses them as its configuration provider. Results are cached and recomputed only for projects whose inputs changed.

## Requirements

- Windows with Visual Studio 2019 16.7 or later, or the Build Tools, with the C++ workload. The extension finds MSBuild through `vswhere`.
- The [C/C++ extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools) (`ms-vscode.cpptools`). VS Code installs it with this extension.

## Installation

Download the `.vsix` file from [Releases](https://github.com/andreiorson/vssln/releases) and install it:

```
code --install-extension vssln-<version>.vsix
```

Or in VS Code: Extensions view → `…` → Install from VSIX.

## Getting started

Open a folder that contains a `.sln` file. The VS Solution icon appears in the activity bar. If the folder has several solutions, pick one in the panel. Your choices are stored in `.vscode/vssln.json`, which is a personal file, so the extension offers to add it to `.git/info/exclude`.

## Settings

Settings live in `.vscode/vssln.json`; the file has a JSON schema, so VS Code completes and checks it. Everything is optional.

```jsonc
{
  "solution": "src/Engine.sln",
  "configuration": "Release|x64",
  "startupProject": "Game",
  // Visual Studio and MSBuild: found through vswhere when omitted.
  "toolchain": { "vsVersion": "[17,18)" },
  // Applied to builds, IntelliSense and debugging.
  "environment": { "CONAN_HOME": "D:\\conan" },
  "build": { "buildBeforeDebug": true, "waves": true },
  "msbuild": { "properties": { "UseMultiToolTask": "true" }, "maxParallelism": 0 },
  "projects": {
    "Game": { "debug": { "args": ["--windowed"], "env": { "GAME_MODE": "dev" } } }
  }
}
```

- `build.waves`: set it to `false` to build in one MSBuild run, as in older versions. The build is then more parallel across projects but needs every generated file to exist before it starts.
- `msbuild.properties`: extra `-p:` properties for builds.
- `msbuild.maxParallelism`: how many MSBuild processes compute IntelliSense at once. `0` means half the CPU cores.

## Known limitations

- Windows only, and C++ projects (`.vcxproj`) only. Other project types in the solution are built but not shown in detail.
- Items that only MSBuild can compute, such as wildcards or items added by targets, don't appear in the tree.
- The build order sees `ProjectReference` items that can be read without running MSBuild. When a reference can't be read, the build output names it.

## Building from source

```
npm install
npm run build
npm test
npx vsce package --no-dependencies
```

`samples/Engine` is a sample solution the tests build. It needs Visual Studio with the C++ workload.

## License

[MIT](LICENSE)
