# Filters and files in the Projects tree — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Tracking: https://claude.ai/artifact/ALsMZ1NbWk1xEoUUAd158T (VS-33 is the feature; VS-34 … VS-37 are Tasks 1 … 4)

**Goal:** A C++ project in the Projects tree expands to its filters and files as in Solution Explorer; a click opens a file, missing files are greyed out.

**Architecture:** A pure parser reads the items of a `.vcxproj` and the filter of each item from its `.vcxproj.filters` (`solution/projectItems.ts`); a pure function turns them into filter and file nodes (`solution/itemsTree.ts`); the loader stores the parsed items in `ProjectEntry`; a children provider registered in the existing `ChildrenRegistry` gives project nodes their children, checks file existence on expand and refreshes when a listed file is created or deleted (`ui/projectItems.ts`).

**Tech Stack:** as before (TypeScript, vitest, `@vscode/test-cli`).

**Spec:** [docs/superpowers/specs/2026-10-22-vssln-extension-design.md](../specs/2026-10-22-vssln-extension-design.md) section 4.7 (and 4.2, 4.6).

## Global Constraints

- Everything from the earlier plans' constraints holds (no machine values in code, pure modules without `vscode`, English code and docs).
- Non-file item types: `ProjectConfiguration`, `ProjectReference`, `Reference`, `Filter`, `ProjectCapability`, `PackageReference`, `ProjectTools`, `Service`, `BuildMacro`.
- Substituted macros (case-insensitive): `$(ProjectDir)` and `$(MSBuildThisFileDirectory)` (project directory with a trailing `\`), `$(MSBuildProjectDirectory)` (without), `$(SolutionDir)` (with), `$(ProjectName)`, `$(MSBuildProjectName)`, `$(SolutionName)`.
- Descriptions: `file not found`, `not evaluated`. Node ids: `<project guid>/f/<filter path>` and `<project guid>/i/<absolute path>`, lower case.
- File rows: icon from the file icon theme (`ThemeIcon.File` with a `file:` resource URI), click runs `vscode.open`; missing or not evaluated rows: icon `circle-slash`, greyed by the decoration provider. Filter rows: `ThemeIcon.Folder`.
- Context values: `filter`, `file`, `file.missing`, `file.unevaluated`. Reveal in Explorer for `file`; Copy path for `file` and `file.missing`.

## Review Focus

1. A `.filters` file that spells a path differently from the `.vcxproj` (`.\src\a.cpp` vs `src\A.cpp`) must still place the file in its filter.
2. Items outside the project directory (`..\shared\x.h`, `$(SolutionDir)include\y.h`) show their file name and open the right file.
3. Two files with the same name in one filter (`a\util.h`, `b\util.h`) are two nodes with distinct ids.
4. Reloading the solution (any `.vcxproj` change) keeps expanded filters expanded: ids do not depend on load order.
5. A broken or empty `.filters` file must not hide the files: they go under the project as if there were no filters.

---

### Task 1: Parse items and filters

**Files:**
- Create: `src/solution/projectItems.ts`
- Test: `test/unit/projectItems.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ProjectItem { itemType: string; include: string; path?: string; filter?: string }
  export interface ProjectItems { items: ProjectItem[]; filters: string[] }
  export interface ItemContext { projectPath: string; solutionPath: string }
  export function parseProjectItems(vcxproj: string, filters: string | undefined, ctx: ItemContext): ProjectItems
  ```
  `include` is one decoded entry of the `Include` list; `path` is the normalized absolute path, absent when not evaluated. `filters` lists every filter path declared in the `.filters` file or named by an item, in file order, without duplicates (case-insensitive).

- [ ] **Step 1: Write the failing tests**
  - `items of every file type, without configurations, references and definitions`: a project with `ProjectConfiguration`, `ClCompile` (self-closing and with children), `ClInclude`, `None`, `ResourceCompile`, `ProjectReference`, and an `ItemDefinitionGroup` with `<ClCompile>` → item types `['ClCompile', 'ClCompile', 'ClInclude', 'None', 'ResourceCompile']` with paths under `C:\s\P\`.
  - `include lists, duplicates and conditions`: `Include="a.cpp;b.cpp"` gives two items; `a.cpp` again in a conditioned `ItemGroup` and as `.\A.cpp` is not repeated.
  - `macros, entities and escapes`: `$(SolutionDir)inc\x.h` → `C:\s\inc\x.h`; `$(projectdir)y.h` → `C:\s\P\y.h`; `..\shared\z.h` → `C:\s\shared\z.h`; `a&amp;b.txt` and `my%20file.txt` decode; `$(Other)\q.h` and `src\*.cpp` have no `path` and keep their raw include.
  - `filters by path, ignoring spelling`: `.filters` with declared `Source Files`, `Source Files\Sub`, `Empty`; items `.\src\A.cpp` (in the `.vcxproj` as `src\a.cpp`) → `Source Files\Sub`; an item filter `Undeclared` is added to `filters`; an entry for a file not in the `.vcxproj` is ignored.
  - `no or broken filters file`: `undefined`, `''` and `'<Project><ItemGroup><ClCompile Include="a.cpp"><Filter>X'` give no `filter` on any item and `filters: []`.
  - `the sample Render project`: `samples/Engine/Graphics/Render` files → filters `['Source Files', 'Header Files']`, `pch.cpp`, `render.cpp`, `frame.cpp` in `Source Files`, `pch.h` in `Header Files`.

- [ ] **Step 2: Run them to see them fail** — `npx vitest run test/unit/projectItems.test.ts`; Expected: FAIL, module not found.

- [ ] **Step 3: Implement `parseProjectItems`** — regex over `<ItemGroup …>…</ItemGroup>` blocks (skipping self-closing ones), then elements `<(\w+)\s+Include="…"(/>|>…</\1>)`; decode `&amp; &lt; &gt; &quot; &apos;` and `%XX`; split on `;`; substitute macros; `path.win32.resolve(projectDir, include)`; key for duplicates and filter lookup is the lower-cased path. A `.filters` file is used only when it contains a closing `</Project>`.

- [ ] **Step 4: Run the tests** — Expected: PASS.

- [ ] **Step 5: Commit** — `feat: read project items and their filters`.

### Task 2: Filter and file nodes

**Files:**
- Create: `src/solution/itemsTree.ts`
- Modify: `src/solution/model.ts` (node kinds), `src/ui/viewModel.ts` (rows)
- Test: `test/unit/itemsTree.test.ts`, `test/unit/viewModel.test.ts`

**Interfaces:**
- Consumes: `ProjectItems` from Task 1.
- Produces:
  ```ts
  // model.ts
  export type NodeKind = 'folder' | 'project' | 'filter' | 'file';
  export interface ItemInfo { include: string; path?: string; missing: boolean }
  // TreeNode gains: item?: ItemInfo; projectGuid?: string
  // itemsTree.ts
  export function itemsTree(projectGuid: string, items: ProjectItems, exists: (path: string) => boolean): TreeNode[]
  // viewModel.ts: ProjectRow gains themeIcon?: 'file' | 'folder'; openPath?: string
  export function itemUri(node: TreeNode): string   // vssln-item:/… for rows the decoration provider greys
  ```

- [ ] **Step 1: Write the failing tests**
  - `filters nest by their path and come before files`: filters `Source Files`, `Source Files\Sub`, `Empty`; root has `Empty`, `Source Files`, then root files; `Sub` is inside `Source Files`; labels are the last segment.
  - `files sort by name ignoring case; same names stay apart`: `a\util.h`, `b\Util.h`, `main.cpp` in one filter → labels `['main.cpp', 'util.h', 'Util.h']` sorted case-insensitively with distinct ids.
  - `ids are stable and lower case`: ids `{guid}/f/source files/sub` and `{guid}/i/c:\s\p\src\a.cpp`; building twice gives equal ids.
  - `missing and not evaluated items`: `exists` false → `missing: true`; no `path` → label is the raw include.
  - viewModel: file row `{ label, tooltip: path, icon: 'file', themeIcon: 'file', openPath, contextValue: 'file', inactive: false }`; missing row `{ description: 'file not found', icon: 'circle-slash', contextValue: 'file.missing', inactive: true }`; unevaluated row `{ description: 'not evaluated', contextValue: 'file.unevaluated' }`; filter row `{ icon: 'folder', themeIcon: 'folder', contextValue: 'filter' }`; `projectDecoration` greys `vssln-item:` URIs of inactive rows.

- [ ] **Step 2: Run them to see them fail.**

- [ ] **Step 3: Implement** `itemsTree` and the row branch in `projectRow` (before the folder branch, which must no longer catch filters).

- [ ] **Step 4: Run all unit tests** — `npx vitest run`; Expected: PASS.

- [ ] **Step 5: Commit** — `feat: filter and file nodes`.

### Task 3: Load items with the solution

**Files:**
- Modify: `src/state/store.ts` (`ProjectEntry.items?: ProjectItems`), `src/state/loader.ts`
- Create: `test/fixtures/workspace/Game/Game.vcxproj.filters`, `test/fixtures/workspace/Game/main.cpp`
- Test: `test/unit/loader.test.ts`

**Interfaces:**
- Consumes: `parseProjectItems` from Task 1.
- Produces: `s.projects.get(guid).items` for every existing `.vcxproj`.

- [ ] **Step 1: Write the failing test** `project items and filters are loaded`: Game's items are `main.cpp`, `src\game.cpp` in `Source Files`, `src\game.h` in `Header Files`; filters `['Source Files', 'Header Files', 'Resource Files']`; Math (no `.filters`) has 5 items without filters.
- [ ] **Step 2: Run it to see it fail.**
- [ ] **Step 3: Implement** — `scanProjects` reads `<absPath>.filters` when it exists and passes `{ projectPath, solutionPath }`.
- [ ] **Step 4: Run all unit tests**; Expected: PASS (the Projects view integration test still expects `exe · 3 files`).
- [ ] **Step 5: Commit** — `feat: load project items with the solution`.

### Task 4: Tree wiring, menus and refresh

**Files:**
- Create: `src/ui/projectItems.ts`
- Modify: `src/extension.ts`, `src/ui/projectsView.ts`, `src/ui/decorations.ts`, `src/ui/commands.ts` (`nodePath` covers files), `package.json` (menus), `docs/manual-checklist.md`
- Test: `test/integration/extension.test.ts`

**Interfaces:**
- Consumes: `itemsTree`, rows from Task 2; `ProjectEntry.items` from Task 3.
- Produces:
  ```ts
  export class ProjectItemsProvider implements ChildrenProvider {
    constructor(store: Store, exists: (p: string) => boolean)
    readonly onDidChange: (listener: () => void) => { dispose(): void }
    /** A created or deleted path: refreshes the projects that list it. */
    fileChanged(path: string): void
  }
  // ProjectsView gains refresh(): void
  ```

- [ ] **Step 1: Write the failing integration test** `a project shows its filters and files; a click opens a file`: expand Game in the fixture → `['Header Files', 'Resource Files', 'Source Files']`; `Source Files` → `['game.cpp', 'main.cpp']`; `game.cpp` has description `file not found`; `main.cpp`'s tree item runs `vscode.open` with its URI. Then create `Game/src/game.cpp` and wait until its row has no description; delete it afterwards.
- [ ] **Step 2: Run it to see it fail** — `npm run test:integration` (fixture).
- [ ] **Step 3: Implement** the provider (children cached per `ProjectItems` object and invalidated by `fileChanged`), `ProjectsView.refresh` and file tree items (`ThemeIcon.File`/`Folder`, `resourceUri` = `Uri.file(path)` for present files and `vssln-item:` otherwise, command `vscode.open`), the decoration branch, the `**/*.vcxproj.filters` reload watcher and a `**/*` create/delete watcher that calls `fileChanged`, the menus from the Global Constraints, and a "Filters and files" section in the manual checklist.
- [ ] **Step 4: Run all suites** — `npm run typecheck`, `npx vitest run`, `npm run test:integration`; Expected: all pass.
- [ ] **Step 5: Commit** — `feat: filters and files in the Projects tree`.
