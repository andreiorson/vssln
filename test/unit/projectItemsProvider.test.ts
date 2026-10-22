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
  provider.fileChanged(gameCpp.replace(/\\src\\game\.cpp$/, ''));
  expect(refreshed()).toBe(0);

  provider.fileChanged(gameCpp.toUpperCase());
  expect(refreshed()).toBe(1);
  provider.children(game);
  expect(checked).toHaveLength(6);

  // A deleted folder matches the files inside it.
  provider.fileChanged(gameCpp.replace(/\\game\.cpp$/, ''), true);
  expect(refreshed()).toBe(2);
});

test('a reload starts afresh', async () => {
  const { provider, checked, find, store } = await setup();
  provider.children(find('Game'));
  store.set(await loadFixtureState());
  provider.children(find('Game'));
  expect(checked).toHaveLength(6);
});
