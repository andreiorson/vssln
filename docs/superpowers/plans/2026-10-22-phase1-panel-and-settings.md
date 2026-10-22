# Phase 1: skeleton, solution panel and settings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Tracking: https://claude.ai/artifact/ALsMZ1NbWk1xEoUUAd158T

| Ticket | Task |
| --- | --- |
| VS-0 | Design spec (done) |
| VS-1 … VS-13 | Tasks 1 … 13 of this plan, same numbers |
| VS-14 | Phase 2: build (own plan) |
| VS-15 | Phase 3: debug (own plan) |
| VS-16 | Phase 4: IntelliSense (own plan) |

**Goal:** A VS Code extension that finds the `.sln` in the workspace, shows its solution folders and C++ projects in a native side bar, lets the user pick solution, configuration and startup project, and stores those choices in a personal `.vscode/vssln.json` without any machine-specific values in code.

**Architecture:** Pure modules (parser, static project scan, tree model, settings, resolver, toolchain discovery, view model) with injected I/O are unit-tested with vitest; a thin VS Code layer (`src/ui/*`, `src/extension.ts`) turns the view model into `TreeView`s, decorations, status bar items and QuickPicks. One `Store` holds the application state; a loader builds it from the workspace.

**Tech Stack:** TypeScript (strict), esbuild (single CommonJS bundle), vitest, `jsonc-parser`, `@vscode/test-cli` + `@vscode/test-electron`, `@vscode/vsce`.

**Spec:** [docs/superpowers/specs/2026-10-22-vssln-extension-design.md](../specs/2026-10-22-vssln-extension-design.md); background in [README.md](../../../README.md).

## Global Constraints

- Windows only; C++ projects are those whose project path ends in `.vcxproj` (case-insensitive). Everything else in the `.sln` is shown greyed out without actions.
- No absolute paths, user names or machine values in source code or in VS Code settings contributions. Values come from: `.vscode/vssln.json` → `.sln`/project files → `vswhere` → built-in defaults.
- Modules under `src/` except `src/extension.ts` and `src/ui/*` must not import `vscode` (they are tested by vitest without VS Code).
- Runtime dependency: `jsonc-parser` only (bundled). `engines.vscode`: `^1.90.0`.
- Child processes are spawned with an argument array and no shell.
- The panel writes `.vscode/vssln.json` only on an explicit user choice, never for defaults, and never over a file that has syntax errors.
- Default configuration: `Release|x64` if present, otherwise the first solution configuration.
- Default startup project: the first project in `.sln` order whose type in the current configuration is `Application`.
- Tree order inside a folder: folders first, then projects, each case-insensitive alphabetical; order never depends on state.
- Settings file schema keys exactly as in spec section 5: `solution`, `configuration`, `startupProject`, `toolchain.vsVersion`, `toolchain.msbuildPath`, `environment`, `build.saveBeforeBuild`, `build.buildBeforeDebug`, `msbuild.properties`, `msbuild.maxParallelism`, `projects.<name>.debug.{program,args,cwd,env,console,byConfiguration}`.
- Variables: `${workspaceFolder}`, `${solutionDir}`, `${projectDir}`, `${targetPath}`, `${configuration}`, `${platform}`, `${env:NAME}`.
- Out of phase 1: Build and IntelliSense status rows, build/debug commands and menus, `extensionDependencies` on cpptools (added in phase 3), "problems only" filter (phase 2, needs build state). Name filtering uses the tree's built-in find (type to filter), so no custom name filter is written.

## Review Focus

1. `.sln` saved by Visual Studio with a UTF-8 BOM, CRLF line endings and tab indentation, and configuration names containing dots (`Release.Static|x64`): parsed exactly like a plain file. Test in Task 2.
2. `vssln.json` names a solution, configuration or startup project that no longer exists (branch switch): the extension falls back to defaults, shows a warning row, and does not rewrite the file. Test in Task 6.
3. `vssln.json` written by hand with comments and trailing commas: it is read, and a selection change keeps the comments; a file with a syntax error is never overwritten. Test in Task 5.
4. No Visual Studio installed, `vswhere.exe` absent, or no instance in the `vsVersion` range: the project tree still appears and an error row offers "Configure toolchain". Tests in Tasks 7 and 9.
5. Several `.sln` files in the workspace and no saved choice: the shallowest path wins, ties broken alphabetically, and nothing is written to disk. Test in Task 6.

---

## File structure

```text
package.json, tsconfig.json, esbuild.mjs, vitest.config.ts, .vscode-test.mjs, .vscodeignore, .gitignore
media/vssln.svg                      activity bar icon
schemas/vssln.schema.json            JSON schema for .vscode/vssln.json
src/extension.ts                     activation, wiring only
src/solution/slnParser.ts            .sln text -> ParsedSolution
src/solution/projectScan.ts          .vcxproj text -> VcxprojScan (static, no MSBuild)
src/solution/model.ts                ParsedSolution -> TreeNode[]; children provider registry
src/settings/settings.ts             VsslnSettings types, parseSettings, applySelectionEdit
src/settings/settingsFile.ts         SettingsFile: read / writeSelection with injected fs
src/settings/resolver.ts             expandVariables, resolveSolutionPath/Configuration/StartupProject
src/settings/gitExclude.ts           isIgnored, addToExclude via git
src/toolchain/vswhere.ts             findToolchain
src/state/store.ts                   AppState, Problem, Store
src/state/loader.ts                  loadWorkspace(deps) -> AppState
src/ui/viewModel.ts                  statusRows, projectRow, projectDecoration, statusBarItems
src/ui/pickItems.ts                  QuickPick item builders
src/ui/statusView.ts, src/ui/projectsView.ts, src/ui/decorations.ts, src/ui/statusBar.ts, src/ui/commands.ts
test/unit/*.test.ts                  vitest
test/fixtures/sln/*.sln, test/fixtures/settings/*.json
test/fixtures/workspace/             Sample.sln + project files, used by unit and integration tests
test/integration/extension.test.ts   @vscode/test-electron
samples/Engine/                      buildable sample solution (10 projects + edge cases), manual checks and phases 2-4
```

Environment of this machine (for verification only, never written into code): Visual Studio Community 2026 (version 18) with the C++ workload; the prototype was only exercised with VS 2019, so the sample also checks a newer toolset.

---

### Task 1: Project skeleton

**Files:**
- Create: `package.json`, `tsconfig.json`, `esbuild.mjs`, `vitest.config.ts`, `.vscodeignore`, `.gitignore`, `media/vssln.svg`, `src/extension.ts`, `test/unit/smoke.test.ts`

**Interfaces:**
- Produces: npm scripts `build`, `watch`, `typecheck`, `test`, `test:integration`, `package`; `activate(context): VsslnApi` and `deactivate()` exported from `src/extension.ts`, where `interface VsslnApi { getState(): unknown }` (typed in Task 11).

- [ ] **Step 1: Write `package.json`**

`name: "vssln"`, `displayName: "VS Solution"`, `publisher: "local"`, `main: "./dist/extension.js"`, `engines.vscode: "^1.90.0"`, `activationEvents: ["workspaceContains:**/*.sln"]`, dependency `jsonc-parser`; devDependencies `typescript`, `esbuild`, `vitest`, `@types/node@20`, `@types/vscode@1.90`, `@vscode/test-cli`, `@vscode/test-electron`, `@vscode/vsce`. Scripts: `build` = `node esbuild.mjs`, `watch` = `node esbuild.mjs --watch`, `typecheck` = `tsc --noEmit`, `test` = `vitest run`, `test:integration` = `npm run build && vscode-test`, `package` = `vsce package --no-dependencies`. No `contributes` yet beyond the view container (Task 11 fills it).

- [ ] **Step 2: Write `tsconfig.json`, `esbuild.mjs`, `vitest.config.ts`, `.gitignore`, `.vscodeignore`**

TS: `strict`, `target ES2022`, `module commonjs`, `moduleResolution node`, `rootDir .`, include `src`, `test`. esbuild: entry `src/extension.ts`, `bundle`, `platform node`, `format cjs`, `external ['vscode']`, `outfile dist/extension.js`, `sourcemap`. vitest: `test.include = ['test/unit/**/*.test.ts']`. `.gitignore`: `node_modules/`, `dist/`, `out/`, `.vscode-test/`, `*.vsix`. `.vscodeignore`: everything except `dist/`, `media/`, `schemas/`, `package.json`, `README.md`.

- [ ] **Step 3: Write `src/extension.ts` with empty `activate`/`deactivate` and `test/unit/smoke.test.ts`** asserting `1 + 1 === 2` (proves the runner works).

- [ ] **Step 4: Verify**

Run: `npm install; npm run typecheck; npm test; npm run build; npm run package`
Expected: no type errors, 1 test passed, `dist/extension.js` exists, a `.vsix` file is produced.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json tsconfig.json esbuild.mjs vitest.config.ts .vscodeignore .gitignore media src test
git commit -m "chore: scaffold extension project"
```

---

### Task 2: Solution parser

**Files:**
- Create: `src/solution/slnParser.ts`, `test/unit/slnParser.test.ts`, `test/fixtures/workspace/Sample.sln`, `test/fixtures/sln/dotted-config.sln`

**Interfaces:**
- Produces:

```ts
export type ProjectKind = 'vcxproj' | 'other';
export interface SlnProject {
  guid: string;            // upper-case, with braces
  typeGuid: string;        // upper-case, with braces
  name: string;
  relPath: string;         // as written in the .sln
  absPath: string;         // path.win32.resolve(slnDir, relPath)
  kind: ProjectKind;       // 'vcxproj' iff relPath ends with .vcxproj (case-insensitive)
  parentGuid?: string;     // from NestedProjects
  dependencies: string[];  // guids from ProjectSection(ProjectDependencies)
  order: number;           // index of appearance in the .sln
}
export interface SlnFolder { guid: string; name: string; parentGuid?: string; order: number }
export interface SolutionConfig { name: string; configuration: string; platform: string } // name = "Release|x64"
export interface ProjectConfigMapping { configuration: string; platform: string; build: boolean }
export interface ParsedSolution {
  path: string; dir: string;
  projects: SlnProject[]; folders: SlnFolder[];
  configurations: SolutionConfig[];                                   // in file order
  mapping: Map<string, Map<string, ProjectConfigMapping>>;            // projectGuid -> solution config name -> mapping
}
export const SOLUTION_FOLDER_TYPE = '{2150E333-8FDC-42A3-9474-1A3956D46DE8}';
export function parseSln(text: string, slnPath: string): ParsedSolution;
export function projectConfigFor(sln: ParsedSolution, projectGuid: string, solutionConfig: string): ProjectConfigMapping | undefined;
```

- [ ] **Step 1: Write the fixture `test/fixtures/workspace/Sample.sln`**

Save with UTF-8 BOM and CRLF line endings, tab indentation (Review Focus 1). Content:

```text
Microsoft Visual Studio Solution File, Format Version 12.00
# Visual Studio Version 16
VisualStudioVersion = 16.0.31702.278
MinimumVisualStudioVersion = 10.0.40219.1
Project("{8BC9CEB8-8B4A-11D0-8D11-00A0C91BC942}") = "Game", "Game\Game.vcxproj", "{11111111-1111-1111-1111-111111111111}"
	ProjectSection(ProjectDependencies) = postProject
		{22222222-2222-2222-2222-222222222222} = {22222222-2222-2222-2222-222222222222}
	EndProjectSection
EndProject
Project("{2150E333-8FDC-42A3-9474-1A3956D46DE8}") = "Core", "Core", "{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}"
EndProject
Project("{2150E333-8FDC-42A3-9474-1A3956D46DE8}") = "Graphics", "Graphics", "{BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB}"
EndProject
Project("{8BC9CEB8-8B4A-11D0-8D11-00A0C91BC942}") = "Math", "Core\Math\Math.vcxproj", "{22222222-2222-2222-2222-222222222222}"
EndProject
Project("{8BC9CEB8-8B4A-11D0-8D11-00A0C91BC942}") = "Render", "Core\Render\Render.vcxproj", "{33333333-3333-3333-3333-333333333333}"
EndProject
Project("{2150E333-8FDC-42A3-9474-1A3956D46DE8}") = "Tools", "Tools", "{CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC}"
EndProject
Project("{8BC9CEB8-8B4A-11D0-8D11-00A0C91BC942}") = "Legacy", "Tools\Legacy\Legacy.vcxproj", "{44444444-4444-4444-4444-444444444444}"
EndProject
Project("{9A19103F-16F7-4668-BE54-9A1E7A4F7556}") = "Docs", "Docs\Docs.csproj", "{55555555-5555-5555-5555-555555555555}"
EndProject
Project("{8BC9CEB8-8B4A-11D0-8D11-00A0C91BC942}") = "Missing", "Missing\Missing.vcxproj", "{66666666-6666-6666-6666-666666666666}"
EndProject
Global
	GlobalSection(SolutionConfigurationPlatforms) = preSolution
		Debug|Win32 = Debug|Win32
		Debug|x64 = Debug|x64
		Release|Win32 = Release|Win32
		Release|x64 = Release|x64
	EndGlobalSection
	GlobalSection(ProjectConfigurationPlatforms) = postSolution
		{11111111-1111-1111-1111-111111111111}.Debug|x64.ActiveCfg = Debug|x64
		{11111111-1111-1111-1111-111111111111}.Debug|x64.Build.0 = Debug|x64
		{11111111-1111-1111-1111-111111111111}.Release|x64.ActiveCfg = Release|x64
		{11111111-1111-1111-1111-111111111111}.Release|x64.Build.0 = Release|x64
		{22222222-2222-2222-2222-222222222222}.Debug|x64.ActiveCfg = Debug|x64
		{22222222-2222-2222-2222-222222222222}.Debug|x64.Build.0 = Debug|x64
		{22222222-2222-2222-2222-222222222222}.Release|x64.ActiveCfg = Release|x64
		{22222222-2222-2222-2222-222222222222}.Release|x64.Build.0 = Release|x64
		{33333333-3333-3333-3333-333333333333}.Release|x64.ActiveCfg = Release|x64
		{44444444-4444-4444-4444-444444444444}.Debug|Win32.ActiveCfg = Debug|Win32
		{44444444-4444-4444-4444-444444444444}.Debug|Win32.Build.0 = Debug|Win32
		{55555555-5555-5555-5555-555555555555}.Release|x64.ActiveCfg = Release|Any CPU
		{55555555-5555-5555-5555-555555555555}.Release|x64.Build.0 = Release|Any CPU
		{66666666-6666-6666-6666-666666666666}.Release|x64.ActiveCfg = Release|x64
		{66666666-6666-6666-6666-666666666666}.Release|x64.Build.0 = Release|x64
	EndGlobalSection
	GlobalSection(NestedProjects) = preSolution
		{BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB} = {AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}
		{22222222-2222-2222-2222-222222222222} = {AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}
		{33333333-3333-3333-3333-333333333333} = {BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB}
		{44444444-4444-4444-4444-444444444444} = {CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC}
	EndGlobalSection
EndGlobal
```

`test/fixtures/sln/dotted-config.sln`: LF endings, no BOM, lower-case GUIDs, one C++ project `{aaaaaaaa-0000-0000-0000-000000000001}` named `Lib` at `Lib.vcxproj`, solution configurations `Release.Static|x64` and `Debug|x64`, mapping `Release.Static|x64.ActiveCfg = Release Static|x64` plus `.Build.0`.

- [ ] **Step 2: Write the failing tests** in `test/unit/slnParser.test.ts`:

```ts
const sln = parseSln(readFixture('workspace/Sample.sln'), 'C:\\src\\Sample.sln');
test('lists projects and folders in file order', () => {
  expect(sln.projects.map(p => p.name)).toEqual(['Game','Math','Render','Legacy','Docs','Missing']);
  expect(sln.folders.map(f => f.name)).toEqual(['Core','Graphics','Tools']);
});
test('classifies kinds and resolves paths', () => {
  expect(sln.projects.find(p => p.name === 'Docs')!.kind).toBe('other');
  expect(sln.projects.find(p => p.name === 'Math')!.absPath).toBe('C:\\src\\Core\\Math\\Math.vcxproj');
});
test('nests folders and projects', () => {
  expect(sln.folders.find(f => f.name === 'Graphics')!.parentGuid).toBe('{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}');
  expect(sln.projects.find(p => p.name === 'Render')!.parentGuid).toBe('{BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB}');
  expect(sln.projects.find(p => p.name === 'Game')!.parentGuid).toBeUndefined();
});
test('reads dependencies', () => {
  expect(sln.projects.find(p => p.name === 'Game')!.dependencies).toEqual(['{22222222-2222-2222-2222-222222222222}']);
});
test('reads solution configurations in order', () => {
  expect(sln.configurations.map(c => c.name)).toEqual(['Debug|Win32','Debug|x64','Release|Win32','Release|x64']);
  expect(sln.configurations[3]).toEqual({ name: 'Release|x64', configuration: 'Release', platform: 'x64' });
});
test('maps project configurations, Build.0 sets build', () => {
  expect(projectConfigFor(sln, '{33333333-3333-3333-3333-333333333333}', 'Release|x64')).toEqual({ configuration: 'Release', platform: 'x64', build: false });
  expect(projectConfigFor(sln, '{55555555-5555-5555-5555-555555555555}', 'Release|x64')).toEqual({ configuration: 'Release', platform: 'Any CPU', build: true });
  expect(projectConfigFor(sln, '{44444444-4444-4444-4444-444444444444}', 'Release|x64')).toBeUndefined();
});
test('handles dotted config names, lower-case guids, LF', () => {
  const d = parseSln(readFixture('sln/dotted-config.sln'), 'C:\\d\\x.sln');
  expect(d.configurations.map(c => c.name)).toEqual(['Release.Static|x64','Debug|x64']);
  expect(projectConfigFor(d, '{AAAAAAAA-0000-0000-0000-000000000001}', 'Release.Static|x64'))
    .toEqual({ configuration: 'Release Static', platform: 'x64', build: true });
});
```

`readFixture(rel)` is a helper in `test/unit/helpers.ts` reading from `test/fixtures` as UTF-8 (BOM kept, so the parser must strip it).

- [ ] **Step 3: Run** `npx vitest run test/unit/slnParser.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 4: Implement `parseSln` and `projectConfigFor`.** Strip a leading `\uFEFF`, split on `/\r?\n/`, trim each line. In `ProjectConfigurationPlatforms`, the key `{GUID}.<solutionConfig>.<suffix>` is split as: GUID = up to the first `}`; suffix = `ActiveCfg` or `Build.0` matched at the end (ignore `Deploy.0` and anything else); the solution config is what is between. GUIDs are normalised to upper case everywhere.

- [ ] **Step 5: Run** the test file — Expected: 7 passed.

- [ ] **Step 6: Commit** — `git commit -m "feat: parse .sln projects, folders, configurations"`

---

### Task 3: Static project scan

**Files:**
- Create: `src/solution/projectScan.ts`, `test/unit/projectScan.test.ts`, `test/fixtures/workspace/Game/Game.vcxproj`, `.../Core/Math/Math.vcxproj`, `.../Core/Render/Render.vcxproj`, `.../Tools/Legacy/Legacy.vcxproj`, `.../Docs/Docs.csproj`

**Interfaces:**
- Produces:

```ts
export type ConfigurationType = 'Application' | 'DynamicLibrary' | 'StaticLibrary' | 'Utility' | 'Makefile' | 'unknown';
export interface VcxprojScan {
  types: Record<string, ConfigurationType>; // key "Release|x64" from Condition "'$(Configuration)|$(Platform)'=='Release|x64'"
  defaultType?: ConfigurationType;          // from a ConfigurationType without a configuration condition
  sources: number;                          // <ClCompile Include=...> items
  headers: number;                          // <ClInclude Include=...> items
}
export function scanVcxproj(text: string): VcxprojScan;
export function typeFor(scan: VcxprojScan | undefined, projectConfig: string): ConfigurationType; // types[cfg] ?? defaultType ?? 'unknown'
```

- [ ] **Step 1: Write fixtures.** Minimal real-shaped `.vcxproj` files: `Game` = `Application` for `Debug|x64` and `Release|x64`, 2 `ClCompile` + 1 `ClInclude`; `Math` = `StaticLibrary` via an unconditioned `<PropertyGroup Label="Configuration">`, 3 sources + 2 headers; `Render` = `DynamicLibrary` in `Release|x64` only, 1 source; `Legacy` = `Utility` in `Debug|Win32`, no items. Condition strings use the exact VS form `Condition="'$(Configuration)|$(Platform)'=='Release|x64'"`, plus one with spaces around `==` to test tolerance. `Missing.vcxproj` is intentionally not created.

- [ ] **Step 2: Write the failing tests**

```ts
test('reads per-configuration type', () => {
  const s = scanVcxproj(readFixture('workspace/Game/Game.vcxproj'));
  expect(typeFor(s, 'Release|x64')).toBe('Application');
  expect(s.sources).toBe(2); expect(s.headers).toBe(1);
});
test('falls back to unconditioned type', () => {
  expect(typeFor(scanVcxproj(readFixture('workspace/Core/Math/Math.vcxproj')), 'Debug|x64')).toBe('StaticLibrary');
});
test('unknown when nothing matches', () => {
  expect(typeFor(scanVcxproj(readFixture('workspace/Core/Render/Render.vcxproj')), 'Debug|x64')).toBe('unknown');
  expect(typeFor(undefined, 'Release|x64')).toBe('unknown');
});
test('tolerates spaces around == in conditions', () => { /* Legacy: typeFor(s, 'Debug|Win32') === 'Utility' */ });
```

- [ ] **Step 3: Run** — Expected: FAIL.
- [ ] **Step 4: Implement** with regular expressions over the text (no XML library): find each `<PropertyGroup ...>…</PropertyGroup>` and `<ConfigurationType>` inside it; read the condition's right-hand side between quotes after `==`. Unknown values map to `'unknown'`.
- [ ] **Step 5: Run** — Expected: 4 passed.
- [ ] **Step 6: Commit** — `git commit -m "feat: static scan of vcxproj type and item counts"`

---

### Task 4: Tree model

**Files:**
- Create: `src/solution/model.ts`, `test/unit/model.test.ts`

**Interfaces:**
- Consumes: `ParsedSolution`, `SlnProject`, `SlnFolder` (Task 2).
- Produces:

```ts
export type NodeKind = 'folder' | 'project';            // later: 'filter' | 'file' | 'references' | 'reference'
export interface TreeNode { id: string; kind: NodeKind; label: string; children: TreeNode[]; project?: SlnProject; folder?: SlnFolder }
export function buildTree(sln: ParsedSolution): TreeNode[];  // id = guid
export interface ChildrenProvider { appliesTo(node: TreeNode): boolean; children(node: TreeNode): TreeNode[] }
export class ChildrenRegistry {
  register(p: ChildrenProvider): void;
  childrenOf(node: TreeNode): TreeNode[];   // node.children concatenated with all applicable providers' children
  hasChildren(node: TreeNode): boolean;
}
```

- [ ] **Step 1: Write the failing tests**

```ts
const roots = buildTree(parseSln(readFixture('workspace/Sample.sln'), 'C:\\src\\Sample.sln'));
test('root order: folders first, then projects, alphabetical', () => {
  expect(roots.map(n => n.label)).toEqual(['Core','Tools','Docs','Game','Missing']);
});
test('nested order', () => {
  const core = roots[0];
  expect(core.children.map(n => n.label)).toEqual(['Graphics','Math']);
  expect(core.children[0].children.map(n => n.label)).toEqual(['Render']);
});
test('alphabetical is case-insensitive', () => { /* sln with projects "beta", "Alpha" -> ['Alpha','beta'] */ });
test('a project whose parent guid is unknown goes to the root', () => { /* NestedProjects pointing at a missing folder */ });
test('registry adds provider children and makes projects expandable', () => {
  const reg = new ChildrenRegistry();
  const game = roots.find(n => n.label === 'Game')!;
  expect(reg.hasChildren(game)).toBe(false);
  reg.register({ appliesTo: n => n.kind === 'project', children: () => [{ id: 'x', kind: 'folder', label: 'X', children: [] }] });
  expect(reg.childrenOf(game).map(n => n.label)).toEqual(['X']);
});
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** Sort with `a.localeCompare(b, undefined, { sensitivity: 'base' })`. **Step 4: Run** — 5 passed.
- [ ] **Step 5: Commit** — `git commit -m "feat: solution tree model with children registry"`

---

### Task 5: Settings model, edits and schema

**Files:**
- Create: `src/settings/settings.ts`, `src/settings/settingsFile.ts`, `schemas/vssln.schema.json`, `test/unit/settings.test.ts`, `test/fixtures/settings/commented.json`, `test/fixtures/settings/broken.json`, `test/fixtures/settings/wrong-types.json`

**Interfaces:**
- Produces:

```ts
export interface DebugSettings { program?: string | null; args?: string[]; cwd?: string; env?: Record<string, string>; console?: 'integratedTerminal' | 'externalTerminal' | 'internalConsole' | 'newExternalWindow' }
export interface ProjectSettings { debug?: DebugSettings & { byConfiguration?: Record<string, DebugSettings> } }
export interface VsslnSettings {
  solution?: string; configuration?: string; startupProject?: string;
  toolchain?: { vsVersion?: string; msbuildPath?: string | null };
  environment?: Record<string, string>;
  build?: { saveBeforeBuild?: boolean; buildBeforeDebug?: boolean };
  msbuild?: { properties?: Record<string, string>; maxParallelism?: number };
  projects?: Record<string, ProjectSettings>;
}
export type SelectionKey = 'solution' | 'configuration' | 'startupProject';
export interface ParsedSettings { settings: VsslnSettings; syntaxOk: boolean; problems: string[] }
export function parseSettings(text: string): ParsedSettings;
export function applySelectionEdit(text: string, key: SelectionKey, value: string): string;

// settingsFile.ts
export interface SettingsFs { readText(p: string): Promise<string | undefined>; writeText(p: string, text: string): Promise<void> }
export const SETTINGS_RELATIVE_PATH = '.vscode/vssln.json';
export class SettingsSyntaxError extends Error {}
export class SettingsFile {
  constructor(folder: string, fs: SettingsFs);
  readonly path: string;                       // path.join(folder, '.vscode', 'vssln.json')
  read(): Promise<ParsedSettings & { exists: boolean }>;
  writeSelection(key: SelectionKey, value: string): Promise<{ created: boolean }>; // throws SettingsSyntaxError if the existing file does not parse
}
```

- [ ] **Step 1: Write fixtures.** `commented.json`: the spec section 5 example verbatim (comments, nested objects) plus a trailing comma after the last property. `broken.json`: `{ "solution": "a.sln", ` (unterminated). `wrong-types.json`: `{"configuration": 5, "environment": {"A": 1, "B": "x"}, "msbuild": {"maxParallelism": "4"}, "startupProject": "Game"}`.

- [ ] **Step 2: Write the failing tests**

```ts
test('reads jsonc with comments and trailing commas', () => {
  const r = parseSettings(readFixture('settings/commented.json'));
  expect(r.syntaxOk).toBe(true);
  expect(r.settings.configuration).toBe('Release|x64');
  expect(r.settings.projects!.Game.debug!.byConfiguration!['Debug|x64'].args).toEqual(['--windowed', '--validate']);
});
test('syntax error yields empty settings and a problem with a line number', () => {
  const r = parseSettings(readFixture('settings/broken.json'));
  expect(r.syntaxOk).toBe(false); expect(r.settings).toEqual({});
  expect(r.problems[0]).toMatch(/line 1/);
});
test('wrong-typed values are dropped with a problem each, valid ones kept', () => {
  const r = parseSettings(readFixture('settings/wrong-types.json'));
  expect(r.settings).toEqual({ environment: { B: 'x' }, startupProject: 'Game', msbuild: {} });
  expect(r.problems).toHaveLength(3);   // configuration, environment.A, msbuild.maxParallelism
});
test('selection edit keeps comments', () => {
  const out = applySelectionEdit(readFixture('settings/commented.json'), 'configuration', 'Debug|x64');
  expect(out).toContain('// current selection');
  expect(parseSettings(out).settings.configuration).toBe('Debug|x64');
});
test('selection edit on empty text creates an object', () => {
  expect(JSON.parse(applySelectionEdit('', 'solution', 'src/A.sln'))).toEqual({ solution: 'src/A.sln' });
});
test('writeSelection refuses to overwrite a broken file', async () => {
  const fs = memoryFs({ 'C:\\w\\.vscode\\vssln.json': readFixture('settings/broken.json') });
  await expect(new SettingsFile('C:\\w', fs).writeSelection('configuration', 'Debug|x64')).rejects.toBeInstanceOf(SettingsSyntaxError);
  expect(fs.files['C:\\w\\.vscode\\vssln.json']).toBe(readFixture('settings/broken.json'));
});
test('writeSelection creates the file and reports it', async () => {
  const fs = memoryFs({});
  expect(await new SettingsFile('C:\\w', fs).writeSelection('startupProject', 'Game')).toEqual({ created: true });
});
```

`memoryFs` lives in `test/unit/helpers.ts`: a `SettingsFs` over a plain object `files`.

- [ ] **Step 3: Run** — FAIL.
- [ ] **Step 4: Implement.** `jsonc-parser` `parse` with `{ allowTrailingComma: true }` and its `errors` array (line from `getLocation`/offset → line by counting newlines); field validation is a small hand-written walk following `VsslnSettings` (no schema library). Edits: `modify(text, [key], value, { formattingOptions: { insertSpaces: true, tabSize: 2 } })` + `applyEdits`. `writeText` must create the `.vscode` directory (the real fs in Task 11 does `mkdir -p`).
- [ ] **Step 5: Write `schemas/vssln.schema.json`** (draft-07) describing exactly the keys of `VsslnSettings`, `additionalProperties: false` at top level, `console` as enum, `maxParallelism` integer ≥ 0, descriptions in English. Add a test that loads the schema and checks its top-level `properties` keys equal `['solution','configuration','startupProject','toolchain','environment','build','msbuild','projects']`.
- [ ] **Step 6: Run** — 8 passed.
- [ ] **Step 7: Commit** — `git commit -m "feat: settings file parsing, comment-preserving edits, schema"`

---

### Task 6: Resolver

**Files:**
- Create: `src/settings/resolver.ts`, `test/unit/resolver.test.ts`

**Interfaces:**
- Consumes: `VsslnSettings` (Task 5), `ParsedSolution`, `SolutionConfig`, `projectConfigFor` (Task 2), `VcxprojScan`, `typeFor` (Task 3).
- Produces:

```ts
export interface VariableContext { workspaceFolder: string; solutionDir?: string; projectDir?: string; targetPath?: string; configuration?: string; platform?: string; env: Record<string, string | undefined> }
export function expandVariables(value: string, ctx: VariableContext): { value: string; unknown: string[] }; // unknown variables stay literal and are listed
export type Source = 'settings' | 'default';
export interface Resolved<T> { value?: T; source: Source; problem?: string }
export function resolveSolutionPath(settings: VsslnSettings, folder: string, discovered: string[]): Resolved<string>;
export function resolveConfiguration(settings: VsslnSettings, sln: ParsedSolution): Resolved<SolutionConfig>;
export function resolveStartupProject(settings: VsslnSettings, sln: ParsedSolution, config: SolutionConfig, scans: Map<string, VcxprojScan | undefined>): Resolved<SlnProject>;
```

- [ ] **Step 1: Write the failing tests**

```ts
test('expands known variables, keeps unknown', () => {
  const r = expandVariables('${workspaceFolder}\\sdk;${env:SDK};${nope}', { workspaceFolder: 'C:\\w', env: { SDK: 'D:\\s' } });
  expect(r).toEqual({ value: 'C:\\w\\sdk;D:\\s;${nope}', unknown: ['nope'] });
});
test('missing env variable expands to empty string', () => { /* ${env:NONE} -> '' and not in unknown */ });
test('solution from settings, relative to folder', () => {
  expect(resolveSolutionPath({ solution: 'src/A.sln' }, 'C:\\w', ['C:\\w\\src\\A.sln', 'C:\\w\\B.sln']))
    .toEqual({ value: 'C:\\w\\src\\A.sln', source: 'settings' });
});
test('several solutions without settings: shallowest, then alphabetical', () => {
  expect(resolveSolutionPath({}, 'C:\\w', ['C:\\w\\x\\A.sln', 'C:\\w\\Z.sln', 'C:\\w\\B.sln']).value).toBe('C:\\w\\B.sln');
});
test('settings solution that no longer exists falls back with a problem', () => {
  const r = resolveSolutionPath({ solution: 'gone.sln' }, 'C:\\w', ['C:\\w\\B.sln']);
  expect(r.value).toBe('C:\\w\\B.sln'); expect(r.source).toBe('default'); expect(r.problem).toMatch(/gone\.sln/);
});
test('configuration default prefers Release|x64 over the first entry', () => {
  expect(resolveConfiguration({}, sample).value!.name).toBe('Release|x64');
});
test('configuration default without Release|x64 is the first', () => { /* dotted-config.sln -> 'Release.Static|x64' */ });
test('unknown configuration in settings falls back with a problem', () => {
  const r = resolveConfiguration({ configuration: 'Profile|x64' }, sample);
  expect(r.value!.name).toBe('Release|x64'); expect(r.problem).toMatch(/Profile\|x64/);
});
test('startup default is the first Application project in sln order', () => {
  expect(resolveStartupProject({}, sample, releaseX64, scans).value!.name).toBe('Game');
});
test('startup from settings matches case-insensitively', () => {
  expect(resolveStartupProject({ startupProject: 'game' }, sample, releaseX64, scans).value!.name).toBe('Game');
});
test('unknown startup project falls back with a problem', () => { /* 'Gone' -> Game, problem mentions Gone */ });
```

`sample` = parsed `Sample.sln`; `scans` = scans of the fixture projects keyed by guid (Missing → `undefined`).

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** Path comparisons are case-insensitive (`toLowerCase()` on Windows paths); depth = number of separators after `path.win32.relative(folder, p)`. **Step 4: Run** — 11 passed.
- [ ] **Step 5: Commit** — `git commit -m "feat: resolve selection with defaults and variable expansion"`

---

### Task 7: Toolchain discovery

**Files:**
- Create: `src/toolchain/vswhere.ts`, `test/unit/vswhere.test.ts`, `test/fixtures/vswhere/vs2019.json`, `test/fixtures/vswhere/empty.json`

**Interfaces:**
- Produces:

```ts
export type Exec = (file: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
export interface VsInstance { installationPath: string; installationVersion: string; displayName: string; msbuildPath: string; devEnvDir: string } // devEnvDir ends with '\'
export interface ToolchainResult { instance?: VsInstance; problem?: string }
export interface ToolchainDeps { exec: Exec; exists(p: string): Promise<boolean>; programFilesX86: string | undefined }
export function findToolchain(opts: { vsVersion?: string; msbuildPath?: string | null }, deps: ToolchainDeps): Promise<ToolchainResult>;
```

- [ ] **Step 1: Write fixtures.** `vs2019.json`: a real-shaped `vswhere -format json` array with one instance, `installationPath` `C:\\VS\\2019\\Professional`, `installationVersion` `16.11.34`, `displayName` `Visual Studio Professional 2019`. `empty.json`: `[]`.

- [ ] **Step 2: Write the failing tests**

```ts
test('calls vswhere with -latest by default and derives paths', async () => {
  const deps = fakeDeps({ vswhere: 'vs2019.json', existing: ['C:\\VS\\2019\\Professional\\MSBuild\\Current\\Bin\\MSBuild.exe'] });
  const r = await findToolchain({}, deps);
  expect(deps.calls[0].args).toEqual(['-latest', '-products', '*', '-requires', 'Microsoft.Component.MSBuild', '-format', 'json', '-utf8']);
  expect(r.instance).toMatchObject({ msbuildPath: 'C:\\VS\\2019\\Professional\\MSBuild\\Current\\Bin\\MSBuild.exe', devEnvDir: 'C:\\VS\\2019\\Professional\\Common7\\IDE\\' });
});
test('version range is passed as -version', async () => { /* vsVersion '[16,17)' -> args include '-version', '[16,17)' and '-latest' */ });
test('vsVersion "latest" is the same as omitted', async () => { /* no -version */ });
test('falls back to MSBuild\\15.0\\Bin when Current is absent', async () => { /* existing has only the 15.0 path */ });
test('explicit msbuildPath wins and derives devEnvDir', async () => {
  const r = await findToolchain({ msbuildPath: 'E:\\VS\\MSBuild\\Current\\Bin\\MSBuild.exe' }, fakeDeps({ existing: ['E:\\VS\\MSBuild\\Current\\Bin\\MSBuild.exe'] }));
  expect(r.instance!.devEnvDir).toBe('E:\\VS\\Common7\\IDE\\');
});
test('explicit msbuildPath that does not exist is a problem', async () => { /* problem mentions the path */ });
test('missing vswhere.exe is a problem, not a throw', async () => { /* existing: [] -> problem /vswhere/ */ });
test('no instance in range is a problem naming the range', async () => { /* empty.json, vsVersion '[18,19)' -> problem contains '[18,19)' */ });
```

- [ ] **Step 3: Run** — FAIL. **Step 4: Implement.** vswhere path: `path.win32.join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')`; `programFilesX86` undefined → problem. Pick the first array element. For an explicit `msbuildPath`, the install root is the parent of the `MSBuild` directory found by walking up; if there is none, `devEnvDir` is `''` and a problem says `DevEnvDir` could not be derived. **Step 5: Run** — 8 passed.
- [ ] **Step 6: Commit** — `git commit -m "feat: locate Visual Studio and MSBuild through vswhere"`

---

### Task 8: Git exclude helper

**Files:**
- Create: `src/settings/gitExclude.ts`, `test/unit/gitExclude.test.ts`

**Interfaces:**
- Consumes: `Exec` (Task 7).
- Produces:

```ts
export function isIgnored(exec: Exec, folder: string, relPath: string): Promise<boolean | undefined>; // undefined: not a repo or git unavailable
export function addToExclude(exec: Exec, fs: { readText(p: string): Promise<string | undefined>; writeText(p: string, t: string): Promise<void> }, folder: string, relPath: string): Promise<void>;
```

- [ ] **Step 1: Write the failing tests**

```ts
test('git check-ignore exit 0 means ignored', async () => { /* exec returns code 0 for ['-C', folder, 'check-ignore', '-q', relPath] -> true */ });
test('exit 1 means not ignored', async () => { /* -> false */ });
test('exit 128 or exec throwing means unknown', async () => { /* -> undefined */ });
test('appends one line to the path from rev-parse --git-path', async () => {
  // exec(['-C', folder, 'rev-parse', '--git-path', 'info/exclude']) -> stdout '.git/info/exclude\n' (relative to folder)
  // existing content '# comment' (no trailing newline) -> '# comment\n/.vscode/vssln.json\n'
});
test('does not duplicate an existing line', async () => { /* content already has '/.vscode/vssln.json' -> unchanged, no write */ });
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement**; the exclude line is `'/' + relPath` with forward slashes; a relative `--git-path` result is resolved against `folder`. **Step 4: Run** — 5 passed.
- [ ] **Step 5: Commit** — `git commit -m "feat: add personal settings file to git info/exclude"`

---

### Task 9: State store and workspace loader

**Files:**
- Create: `src/state/store.ts`, `src/state/loader.ts`, `test/unit/store.test.ts`, `test/unit/loader.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 3, 5, 6, 7.
- Produces:

```ts
// store.ts
export interface Problem { severity: 'error' | 'warning'; message: string; action?: 'configureToolchain' | 'openSettings' | 'selectSolution' }
export interface ProjectEntry { exists: boolean; scan?: VcxprojScan }
export interface AppState {
  phase: 'loading' | 'noSolution' | 'ready';
  folder?: string;                         // workspace folder whose vssln.json applies
  solutions: string[];                     // all discovered .sln, absolute
  solution?: ParsedSolution;
  configuration?: SolutionConfig;
  startupProjectGuid?: string;
  projects: Map<string, ProjectEntry>;     // by project guid, C++ projects only
  toolchain?: VsInstance;
  settings: VsslnSettings;
  settingsSyntaxOk: boolean;
  problems: Problem[];
}
export const initialState: AppState;       // phase 'loading', empty collections, settings {}, settingsSyntaxOk true
export class Store {
  get state(): AppState;
  set(next: AppState): void;               // replaces and notifies
  onDidChange(listener: (s: AppState) => void): { dispose(): void };
}

// loader.ts
export interface LoaderDeps {
  folders: string[];
  findSolutions(): Promise<string[]>;      // absolute paths in all folders
  readText(p: string): Promise<string | undefined>;
  exists(p: string): Promise<boolean>;
  findToolchain(opts: { vsVersion?: string; msbuildPath?: string | null }): Promise<ToolchainResult>;
}
export function loadWorkspace(deps: LoaderDeps): Promise<AppState>;
```

Folder choice: the first folder whose `vssln.json` has a `solution` that resolves to an existing discovered `.sln`; otherwise the folder containing the default solution (Task 6 rule applied to all discovered paths, depth measured from that path's own folder). Problems from settings parsing, every resolver, and the toolchain are collected in `problems`; a toolchain problem gets `action: 'configureToolchain'`, settings problems get `action: 'openSettings'`.

- [ ] **Step 1: Write the failing tests**

```ts
test('store notifies listeners and stops after dispose', () => { /* set twice, dispose between -> listener called once */ });
test('no .sln: phase noSolution, no throw', async () => {
  expect((await loadWorkspace(fakeLoaderDeps({ solutions: [] }))).phase).toBe('noSolution');
});
test('loads the fixture workspace with defaults', async () => {
  const s = await loadWorkspace(fixtureDeps());           // reads test/fixtures/workspace from disk
  expect(s.phase).toBe('ready');
  expect(s.configuration!.name).toBe('Release|x64');
  expect(s.solution!.projects.find(p => p.guid === s.startupProjectGuid)!.name).toBe('Game');
  expect(s.projects.get('{66666666-6666-6666-6666-666666666666}')).toEqual({ exists: false });
  expect(s.projects.has('{55555555-5555-5555-5555-555555555555}')).toBe(false); // Docs is not C++
});
test('missing toolchain still loads the tree and reports an actionable error', async () => {
  const s = await loadWorkspace(fixtureDeps({ toolchain: { problem: 'vswhere.exe not found' } }));
  expect(s.phase).toBe('ready');
  expect(s.problems).toContainEqual({ severity: 'error', message: 'vswhere.exe not found', action: 'configureToolchain' });
});
test('stale settings produce warnings and keep settingsSyntaxOk', async () => {
  // vssln.json: {"configuration": "Profile|x64", "startupProject": "Gone"}
  // -> configuration Release|x64, startup Game, two warning problems with action 'openSettings'
});
test('broken settings file: defaults, settingsSyntaxOk false, error problem', async () => { /* broken.json */ });
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** Scans run for every C++ project in parallel (`Promise.all`); a project whose file does not exist gets `{ exists: false }`. **Step 4: Run** — 6 passed.
- [ ] **Step 5: Commit** — `git commit -m "feat: application state store and workspace loader"`

---

### Task 10: View model and pick items

**Files:**
- Create: `src/ui/viewModel.ts`, `src/ui/pickItems.ts`, `test/unit/viewModel.test.ts`, `test/unit/pickItems.test.ts`

**Interfaces:**
- Consumes: `AppState` (Task 9), `TreeNode` (Task 4), `typeFor` (Task 3), `projectConfigFor` (Task 2).
- Produces:

```ts
export interface StatusRow { id: 'solution' | 'configuration' | 'startup' | `problem:${number}`; label: string; description?: string; tooltip?: string; icon: string; command?: string; contextValue: string }
export function statusRows(s: AppState): StatusRow[];
export interface ProjectRow { label: string; description?: string; tooltip?: string; icon: string; contextValue: string; resourceUri: string; inactive: boolean }
export function projectRow(node: TreeNode, s: AppState): ProjectRow;
export function projectUri(guid: string): string;                    // 'vssln-project:/' + guid without braces, lower case
export interface Decoration { color?: 'disabledForeground'; tooltip?: string }
export function projectDecoration(uri: string, s: AppState): Decoration | undefined;
export interface StatusBarEntry { id: 'configuration' | 'startup'; text: string; tooltip: string; command: string }
export function statusBarItems(s: AppState): StatusBarEntry[];

// pickItems.ts
export interface PickItem<T> { label: string; description?: string; detail?: string; picked?: boolean; value: T }
export function solutionItems(solutions: string[], folders: string[], current?: string): PickItem<string>[];
export function configurationItems(s: AppState): PickItem<string>[];
export function startupItems(s: AppState, showAll: boolean): PickItem<string | 'showAll'>[];
```

Exact values:

| Thing | Value |
| --- | --- |
| Status rows (order) | solution, configuration, startup, then one row per problem |
| Solution row | label = file name, description = directory relative to the folder (or `.`), icon `file-code`, command `vssln.selectSolution`, contextValue `status.solution` |
| Configuration row | label `Release | x64` (spaces around the bar), icon `settings-gear`, command `vssln.selectConfiguration`, contextValue `status.configuration` |
| Startup row | label = project name, description `startup`, icon `rocket`, command `vssln.selectStartupProject`, contextValue `status.startup`; no startup project → label `None`, description `no application project` |
| Problem row | label = message, icon `error` or `warning`, command from action: `vssln.configureToolchain` / `vssln.openSettings` / `vssln.selectSolution`; contextValue `status.problem` |
| Folder row | icon `folder`, contextValue `folder`, no description |
| Project type lookup | `typeFor(scan, mapping.configuration + '|' + mapping.platform)` with the project mapping of the current solution configuration |
| Project icon by type | Application `window`, DynamicLibrary `extensions`, StaticLibrary `library`, Utility `tools`, Makefile `tools`, unknown `file-code` |
| Project type short name | `exe`, `dll`, `lib`, `utility`, `makefile`, `` for unknown |
| Active project description | `<short> · <sources+headers> files`, startup project appends ` · startup` |
| Inactive reasons (description, icon `circle-slash`) | not C++: `not a C++ project`; file missing: `file not found`; no mapping: `not in Release|x64` (current config name) |
| contextValue | `project.app` (Application), `project.lib` (other active C++), `project.inactive` |
| Decoration | inactive project → `{ color: 'disabledForeground', tooltip: <reason> }`; otherwise `undefined` |
| Status bar | configuration: text `$(settings-gear) Release|x64`, command `vssln.selectConfiguration`; startup: text `$(rocket) Game`, command `vssln.selectStartupProject`; none when phase ≠ `ready` |
| Startup pick | Application projects in tree order; current one `picked` with description `current`; last item `Show all projects…` with value `'showAll'` unless `showAll` |
| Configuration pick | all configurations in file order, current `picked` |
| Solution pick | label = file name, description = path relative to its workspace folder |

- [ ] **Step 1: Write the failing tests** covering every row of the table with the loaded fixture state (Task 9 `fixtureDeps`), for example:

```ts
test('status rows for the fixture', () => {
  expect(statusRows(s).map(r => [r.id, r.label, r.description])).toEqual([
    ['solution', 'Sample.sln', '.'], ['configuration', 'Release | x64', undefined], ['startup', 'Game', 'startup']]);
});
test('inactive reasons', () => {
  expect(projectRow(node('Legacy'), s)).toMatchObject({ description: 'not in Release|x64', inactive: true, contextValue: 'project.inactive' });
  expect(projectRow(node('Missing'), s).description).toBe('file not found');
  expect(projectRow(node('Docs'), s).description).toBe('not a C++ project');
});
test('active project description', () => {
  expect(projectRow(node('Game'), s)).toMatchObject({ description: 'exe · 3 files · startup', icon: 'window', contextValue: 'project.app' });
});
test('decoration greys inactive projects only', () => { /* Legacy -> disabledForeground; Game -> undefined */ });
test('problem rows carry their command', () => { /* state with toolchain problem -> last row command 'vssln.configureToolchain' */ });
test('startup items with and without show all', () => { /* default: ['Game', 'Show all projects…']; showAll: ['Render', 'Math', 'Legacy', 'Game', 'Missing'] (C++ projects in tree order) */ });
```

- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — all pass.
- [ ] **Step 5: Commit** — `git commit -m "feat: view model for status, projects, status bar and pickers"`

---

### Task 11: VS Code wiring

**Files:**
- Create: `src/ui/statusView.ts`, `src/ui/projectsView.ts`, `src/ui/decorations.ts`, `src/ui/statusBar.ts`, `src/ui/commands.ts`
- Modify: `src/extension.ts`, `package.json` (`contributes`)

**Interfaces:**
- Consumes: everything above.
- Produces: `activate(context): VsslnApi` with `interface VsslnApi { getState(): AppState }`; commands `vssln.selectSolution`, `vssln.selectConfiguration`, `vssln.selectStartupProject`, `vssln.setAsStartup`, `vssln.openSettings`, `vssln.configureToolchain`, `vssln.openProjectFile`, `vssln.revealInExplorer`, `vssln.copyPath`, `vssln.refresh`, `vssln.showLog`; context key `vssln.phase` (`loading` / `noSolution` / `ready`).

- [ ] **Step 1: `package.json` contributions**

View container `vssln` in the activity bar (title `VS Solution`, icon `media/vssln.svg`) with views `vssln.status` (`Status`) and `vssln.projects` (`Projects`). `viewsWelcome` for `vssln.projects` when `vssln.phase == noSolution`: text `No solution found in this workspace.` and a `[Select solution](command:vssln.selectSolution)` link. `jsonValidation`: `fileMatch: ".vscode/vssln.json"`, `url: "./schemas/vssln.schema.json"`. Menus: `view/title` of `vssln.status` → `vssln.openSettings` (navigation), `vssln.refresh`, `vssln.showLog` (overflow); `view/title` of `vssln.projects` → `workbench.actions.treeView.vssln.projects.collapseAll` is provided by `showCollapseAll: true`; `view/item/context` for `viewItem =~ /^status\.(solution|configuration|startup)$/` → inline edit (pencil, `$(edit)`) running the row's select command; for `viewItem =~ /^project\.(app|lib)$/` → `vssln.setAsStartup` (only `project.app` unless the user opened "show all" — keep it on both), `vssln.openProjectFile`, `vssln.revealInExplorer`, `vssln.copyPath`; for `project.inactive` → open/reveal/copy only. All commands get `category: "VS Solution"`.

- [ ] **Step 2: Views.** `StatusView` and `ProjectsView` implement `TreeDataProvider`, map `StatusRow`/`ProjectRow` to `TreeItem` (`new ThemeIcon(row.icon)`, `resourceUri = Uri.parse(row.resourceUri)`), refresh on `store.onDidChange`, coalescing refreshes with a 50 ms timer. Projects use `ChildrenRegistry.childrenOf`. `decorations.ts` registers a `FileDecorationProvider` for scheme `vssln-project` mapping `Decoration.color` to `new ThemeColor(...)`, firing `onDidChangeFileDecorations` on store change. `statusBar.ts` keeps two `StatusBarItem`s in sync with `statusBarItems`.

- [ ] **Step 3: Commands and reload.** `commands.ts`: select commands show `window.showQuickPick` with items from Task 10; on a choice call `SettingsFile.writeSelection`. On `SettingsSyntaxError` show `vssln.json has a syntax error. Fix it before changing the selection.` with an `Open settings` button, and write nothing. When `created` is true and `isIgnored` returns `false`, ask `Keep .vscode/vssln.json out of git? It's added to .git/info/exclude, not .gitignore.` with `Add to exclude` / `Not now`. `vssln.configureToolchain` opens the settings file (creating `{}` + a `toolchain` key via `applySelectionEdit`-style `modify` if absent) and reveals the `toolchain` key. `vssln.refresh` reloads. `vssln.showLog` shows a `LogOutputChannel` named `VS Solution` that receives every problem and every reload.
  Reload triggers: activation, `vssln.refresh`, a `FileSystemWatcher` on `**/.vscode/vssln.json` and `**/*.sln` (debounced 300 ms), workspace folder changes. Each reload runs `loadWorkspace` with real deps (`workspace.findFiles('**/*.sln', '**/node_modules/**')`, `fs.promises`, `child_process.execFile` without shell, `process.env['ProgramFiles(x86)']`) and `store.set`. `writeText` creates the parent directory.

- [ ] **Step 4: Verify by hand** — `npm run build`, then press F5 in VS Code with `test/fixtures/workspace` opened as the extension host workspace (add a `.vscode/launch.json` `extensionHost` configuration with `args: ["${workspaceFolder}/test/fixtures/workspace", "--extensionDevelopmentPath=${workspaceFolder}"]`).
  Expected: the tree shows `Core › Graphics › Render`, `Core › Math`, `Tools › Legacy` greyed, `Docs` and `Missing` greyed at the root, `Game` with `exe · 3 files · startup`; selecting `Debug | x64` creates `test/fixtures/workspace/.vscode/vssln.json` with `"configuration": "Debug|x64"` and Render becomes `not in Debug|x64`. Delete that file after checking.

- [ ] **Step 5: Run** `npm run typecheck; npm test` — Expected: clean, all unit tests pass.
- [ ] **Step 6: Commit** — `git commit -m "feat: side bar views, commands, status bar and settings wiring"`

---

### Task 12: Buildable sample solution

A synthetic but real solution that MSBuild builds, used for manual checks now and as the test bed of phases 2 to 4 (build progress, errors, debug parameters, IntelliSense). It is separate from the small unit-test fixtures, which stay deterministic and do not need Visual Studio.

**Files:**
- Create: `samples/Engine/**` (layout below), `samples/Engine/README.md`
- Modify: `.gitignore` (add `samples/Engine/out/` and `.vs/`)

**Layout and what each part exercises:**

| Solution folder | Project | Type | Exercises |
| --- | --- | --- | --- |
| (root) | `Game` | Application, console | startup default; depends on `Render`, `Audio`, `Platform`; committed `Game.vcxproj.user` with `LocalDebuggerCommandArguments` `--windowed` and `LocalDebuggerEnvironment` `GAME_MODE=sample` (phase 3); prints its args, cwd and `GAME_MODE` |
| (root) | `Audio` | DynamicLibrary | dll icon, dependency of `Game` |
| `Core` | `Math` | StaticLibrary | `#error` when `ENGINE_BREAK_BUILD` is defined (phase 2 error reporting) |
| `Core` | `Containers` | StaticLibrary | mostly headers (header-to-source mapping, phase 4) |
| `Core` | `Platform` | StaticLibrary | define `ENGINE_FLAVOR` fed from the environment variable of the same name (environment in cache key, phase 4) |
| `Graphics` | `Render` | DynamicLibrary | precompiled header `pch.h` (`/Yc` on `pch.cpp`, `/Yu` elsewhere); depends on `Math` |
| `Graphics` | `Shaders` | Utility | custom build step that writes a generated header into `out/` |
| `Tools` | `Editor` | Application | second application for the startup picker |
| `Tools` | `AssetCooker` | Application, console | reads `assets.txt` relative to its working directory (debug `cwd`, phase 3) |
| `Tools` | `Legacy` | StaticLibrary | mapped only in `Debug|Win32` (inactive in other configurations) |
| `Tests` | `MathTests` | Application, console | exits non-zero on failure |
| (root) | `Missing` | listed in the `.sln`, no file on disk | "file not found" |

Solution configurations in this order: `Debug|Win32`, `Debug|x64`, `Release|x64`, `Release|Win32` (the first entry is not the default; Review Focus 5 of the brief). Every project except `Legacy` and `Missing` is mapped and built in all four.

Rules for the project files, so the sample has no machine-specific values:
- `PlatformToolset` is `$(DefaultPlatformToolset)` and `WindowsTargetPlatformVersion` is `10.0`, so any installed Visual Studio builds it.
- Every project imports `$(SolutionDir)Build\Common.props` (verifies that `SolutionDir` is passed, brief section 4.1). It sets `LanguageStandard` `stdcpp20`, the include directory `$(SolutionDir)Core\include`, the define `ENGINE_FLAVOR="$(ENGINE_FLAVOR)"`, `OutDir` `$(SolutionDir)out\$(Platform)\$(Configuration)\` and `IntDir` `$(SolutionDir)out\obj\$(ProjectName)\$(Platform)\$(Configuration)\`.
- Project GUIDs are fixed, written in the files; source files are a few lines each.

- [ ] **Step 1: Write the solution, `Build/Common.props`, the projects, their `.vcxproj.filters` (phase-later filters node) and sources** following the table.

- [ ] **Step 2: Build it with the installed Visual Studio** (PowerShell; MSBuild is located through `vswhere`, not a fixed path):

```powershell
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$msbuild = & $vswhere -latest -requires Microsoft.Component.MSBuild -find 'MSBuild\**\Bin\MSBuild.exe' | Select-Object -First 1
& $msbuild samples\Engine\Engine.sln -m -nologo -p:Configuration=Release -p:Platform=x64
& $msbuild samples\Engine\Engine.sln -m -nologo -p:Configuration=Debug -p:Platform=Win32
```

Expected: both builds succeed; the warning for `Missing` (project file not found) is the only warning MSBuild prints about the solution structure.

- [ ] **Step 3: Check the outputs**

Run: `samples\Engine\out\x64\Release\Game.exe a b` → prints `args: a b`; `samples\Engine\out\x64\Release\MathTests.exe; $LASTEXITCODE` → `0`.

- [ ] **Step 4: Check the error path**

Run: `$env:CL='/DENGINE_BREAK_BUILD'; & $msbuild samples\Engine\Engine.sln -m -nologo -p:Configuration=Release -p:Platform=x64; Remove-Item Env:CL`
Expected: build fails with a `fatal error C1189` in `Math`.

- [ ] **Step 5: Open the sample in the extension** (extension host launched on `samples/Engine`) and compare with the table: folders, greyed `Legacy` and `Missing`, `Game` as default startup, `Release | x64` as default configuration.

- [ ] **Step 6: Write `samples/Engine/README.md`** (what each project exercises, the table above in short) and commit — `git commit -m "test: buildable sample solution for manual and phase tests"`

---

### Task 13: Integration test and manual checklist

**Files:**
- Create: `.vscode-test.mjs`, `test/integration/extension.test.ts`, `docs/manual-checklist.md`
- Modify: `package.json` (devDependency `mocha` types if `@vscode/test-cli` needs them)

**Interfaces:**
- Consumes: `VsslnApi` (Task 11).

- [ ] **Step 1: Write `.vscode-test.mjs`** with `files: 'out/test/integration/**/*.test.js'`, `workspaceFolder: 'test/fixtures/workspace'`, `mocha: { timeout: 20000 }`; compile integration tests with `tsc -p test/integration` into `out/` (add a small `test/integration/tsconfig.json`); `test:integration` = `npm run build && tsc -p test/integration && vscode-test`.

- [ ] **Step 2: Write the test**

```ts
suite('activation', () => {
  test('loads the fixture solution', async () => {
    const ext = vscode.extensions.getExtension<VsslnApi>('local.vssln')!;
    const api = await ext.activate();
    await waitFor(() => api.getState().phase === 'ready', 10000);
    const s = api.getState();
    assert.strictEqual(s.configuration!.name, 'Release|x64');
    assert.deepStrictEqual(s.solution!.projects.map(p => p.name), ['Game','Math','Render','Legacy','Docs','Missing']);
  });
  test('views are registered', async () => {
    await vscode.commands.executeCommand('vssln.projects.focus');   // throws if the view is not contributed
  });
});
```

- [ ] **Step 3: Run** `npm run test:integration` — Expected: 2 passing (downloads a VS Code build on first run).

- [ ] **Step 4: Write `docs/manual-checklist.md`** for `samples/Engine` (Task 12) and, when available, a real work solution: open the folder; tree matches Solution Explorer folder structure; default configuration is `Release|x64`; switch configuration and startup project, file created and git exclude prompt appears once; add a comment to `vssln.json`, switch again, comment survives; set `toolchain.vsVersion` to `[99,100)` → error row with Configure toolchain, tree still visible; corrupt the file → error, no overwrite; delete the file → defaults return.

- [ ] **Step 5: Commit** — `git commit -m "test: integration test and manual checklist for phase 1"`

---

## After phase 1

Phases 2 (build), 3 (debug) and 4 (IntelliSense) get their own plans, each written when the phase starts, because each begins with a verification against a real MSBuild (spec sections 6, 7, 8 and 13) whose result shapes the tasks. The board carries one ticket per phase until its plan exists.
