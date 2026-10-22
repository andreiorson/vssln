import { expect, test } from 'vitest';
import { buildTree, TreeNode } from '../../src/solution/model';
import { Store } from '../../src/state/store';
import { ProjectItemsProvider } from '../../src/ui/projectItems';
import { loadFixtureState } from './helpers';

async function setup() {
  const store = new Store();
  store.set(await loadFixtureState());
  const checked: string[] = [];
  const provider = new ProjectItemsProvider(store, p => {
    checked.push(p);
    return p.endsWith('main.cpp');
  });
  let refreshed = 0;
  provider.onDidChange(() => refreshed++);
  const find = (label: string) => {
    const visit = (nodes: TreeNode[]): TreeNode | undefined => nodes.map(n => (n.label === label ? n : visit(n.children))).find(Boolean);
    return visit(buildTree(store.state.solution!))!;
  };
  return { store, provider, checked, refreshed: () => refreshed, find };
}

test('C++ projects with files expand; missing and other projects do not', async () => {
  const { provider, find } = await setup();
  expect(provider.appliesTo(find('Game'))).toBe(true);
  expect(provider.appliesTo(find('Missing'))).toBe(false);
  expect(provider.appliesTo(find('Docs'))).toBe(false);
  expect(provider.appliesTo(find('Core'))).toBe(false);
});

test('existence is checked when a project is expanded, once', async () => {
  const { provider, checked, find } = await setup();
  expect(checked).toEqual([]);
  const first = provider.children(find('Game'));
  expect(checked).toHaveLength(3);
  expect(provider.children(find('Game'))).toBe(first);
  expect(checked).toHaveLength(3);
});

test('only events for listed files of expanded projects refresh', async () => {
  const { provider, checked, refreshed, find, store } = await setup();
  const game = find('Game');
  provider.children(game);
  const gameCpp = store.state.projects.get(game.project!.guid)!.items!.items[1].path!;

  provider.fileChanged(gameCpp.replace('game.cpp', 'other.cpp'));
  // Build output next to the sources: not a file of the project, not a folder holding one.
  provider.fileChanged(gameCpp.replace(/\\src\\game\.cpp$/, '\\obj\\game.obj'));
  provider.fileChanged(gameCpp.replace(/\\src\\game\.cpp$/, '\\obj'));
  expect(refreshed()).toBe(0);

  provider.fileChanged(gameCpp.toUpperCase());
  expect(refreshed()).toBe(1);
  provider.children(game);
  expect(checked).toHaveLength(6);
});

test('a folder that appears or goes away in one event refreshes the files inside it', async () => {
  const { provider, refreshed, find, store } = await setup();
  const game = find('Game');
  provider.children(game);
  const src = store.state.projects.get(game.project!.guid)!.items!.items[1].path!.replace(/\\game\.cpp$/, '');
  provider.fileChanged(src);
  expect(refreshed()).toBe(1);
  provider.children(game);
  provider.fileChanged(`${src}\\`);
  expect(refreshed()).toBe(2);
});

test('file events before any project was expanded cost nothing and refresh nothing', async () => {
  const { provider, refreshed, find, store } = await setup();
  const game = find('Game');
  provider.fileChanged(store.state.projects.get(game.project!.guid)!.items!.items[1].path!);
  expect(refreshed()).toBe(0);
});

test('collapsing a project checks its files again on the next expand', async () => {
  const { provider, checked, find } = await setup();
  const game = find('Game');
  provider.children(game);
  provider.collapsed(game);
  provider.children(game);
  expect(checked).toHaveLength(6);
});

test('parents of filters and files lead back to the project node', async () => {
  const { provider, find, store } = await setup();
  const game = find('Game');
  const nodes = provider.children(game);
  const sourceFiles = nodes.find(n => n.label === 'Source Files')!;
  expect(provider.parentOf(sourceFiles)).toBe(game);
  expect(provider.parentOf(sourceFiles.children.find(n => n.label === 'main.cpp')!)).toBe(sourceFiles);
  expect(provider.parentOf(game)).toBeUndefined();
  store.set(await loadFixtureState());
  expect(provider.parentOf(sourceFiles)).toBeUndefined();
});

test('a reload starts afresh', async () => {
  const { provider, checked, find, store } = await setup();
  provider.children(find('Game'));
  store.set(await loadFixtureState());
  provider.children(find('Game'));
  expect(checked).toHaveLength(6);
});
