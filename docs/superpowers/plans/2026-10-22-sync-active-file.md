# Sync with Active Document — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Tracking: https://claude.ai/artifact/ALsMZ1NbWk1xEoUUAd158T (VS-38)

**Goal:** A Sync with Active Document button in the Projects title selects the active editor's file in the tree, as in Visual Studio.

**Architecture:** Pure helpers find the projects that list a path and the file node under a project (`solution/locate.ts`); the tree learns parents (`ChildrenRegistry.parentOf`, `ProjectsView.getParent`), which `TreeView.reveal` needs; a command in `ui/syncActiveFile.ts` ties them together.

**Tech Stack:** as before.

**Spec:** [docs/superpowers/specs/2026-10-22-vssln-extension-design.md](../specs/2026-10-22-vssln-extension-design.md) section 4.7 (Sync with Active Document).

## Global Constraints

- Earlier constraints hold (pure modules without `vscode`, English code and docs).
- Command `vssln.syncActiveFile`, title `Sync with Active Document`, icon `$(arrow-swap)`, Projects title `navigation@3`, when `view == vssln.projects && vssln.phase == ready`.
- Messages: `No file is open.`, `<file name> is not in any project of <solution file name>.`, `<file name> is in <project>, which the filter hides.` with the action `Clear filter`.
- Reveal options: `{ select: true, focus: true, expand: false }`.

## Review Focus

1. The file is in a project inside nested solution folders while the live filter is on: the folders are filter copies, so the parent chain must use the nodes the view returned.
2. The path of the active editor differs in case or separators from the project's item path.
3. The active editor is not a text editor (an image or a diff): the file of the active tab is used.
4. The project was never expanded: its file nodes are built on demand and existence is checked then.
5. A reload between two clicks: nodes are rebuilt, parents must come from the current tree, not a stale one.

---

### Task 1: Locate files and parents

**Files:**
- Create: `src/solution/locate.ts`
- Modify: `src/solution/model.ts` (`ChildrenProvider.parentOf?`, `ChildrenRegistry.parentOf`), `src/ui/projectItems.ts`, `src/ui/projectsView.ts`
- Test: `test/unit/locate.test.ts`, `test/unit/model.test.ts`, `test/unit/projectItemsProvider.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // locate.ts
  export function projectsListing(s: Pick<AppState, 'solution' | 'projects' | 'startupProjectGuid'>, filePath: string): string[] // guids, startup first, then solution order
  export function findItemNode(nodes: TreeNode[], filePath: string): TreeNode | undefined
  export function parentsOf(roots: TreeNode[]): Map<TreeNode, TreeNode>
  // model.ts
  interface ChildrenProvider { parentOf?(node: TreeNode): TreeNode | undefined }
  ChildrenRegistry.parentOf(node: TreeNode): TreeNode | undefined
  // ProjectsView
  getParent(node: TreeNode): TreeNode | undefined
  findProjectNode(guid: string): TreeNode | undefined   // in the current (maybe filtered) tree
  ```

- [ ] **Step 1: Write the failing tests**
  - `projectsListing`: Game's `main.cpp` in any case and with `/` → `[Game guid]`; a path listed by Game and Math (add the same item to both through a store built from the fixture) → startup Game first; startup not listing it → solution order; unknown path → `[]`; missing projects and items without a path are skipped.
  - `findItemNode`: finds a nested file under filters, case-insensitive; `undefined` for an unevaluated item.
  - `parentsOf`: folders → projects map; roots have no entry.
  - provider `parentOf`: top-level items → the project node passed to `children`; a file under `Source Files` → that filter node; after a reload → `undefined` until rebuilt.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement.** `ProjectsView.getParent` = `registry.parentOf(node) ?? parentsOf(current roots).get(node)` (the map cached per filter result object).
- [ ] **Step 4: Run all unit tests.**
- [ ] **Step 5: Commit** — `feat: tree parents and file lookup for sync`.

### Task 2: The Sync button

**Files:**
- Create: `src/ui/syncActiveFile.ts`
- Modify: `src/extension.ts`, `package.json`, `docs/manual-checklist.md`
- Test: `test/integration/extension.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces: `registerSyncActiveFile(store, view, treeView): vscode.Disposable[]`; `VsslnApi.views.projectsTree` for tests.

- [ ] **Step 1: Write the failing integration test** `Sync with Active Document selects the open file`: open `Game/main.cpp`, run `vssln.syncActiveFile`, `projectsTree.selection[0].label === 'main.cpp'` and its parent chain is `Source Files` → `Game`; with the filter `math` set, running it again leaves the selection unchanged (message path) and the filter stays.
- [ ] **Step 2: Run it to see it fail.**
- [ ] **Step 3: Implement** the command (active text editor, else the active tab's `input.uri`), messages and `Clear filter`, the title button, the checklist lines.
- [ ] **Step 4: Run all suites.**
- [ ] **Step 5: Commit** — `feat: Sync with Active Document in the Projects view`.
