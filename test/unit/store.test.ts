import { expect, test } from 'vitest';
import { initialState, Store } from '../../src/state/store';

test('initial state is loading with empty collections', () => {
  expect(initialState.phase).toBe('loading');
  expect(initialState.projects.size).toBe(0);
  expect(initialState.problems).toEqual([]);
  expect(initialState.settingsSyntaxOk).toBe(true);
});

test('store notifies listeners and stops after dispose', () => {
  const store = new Store();
  const seen: string[] = [];
  const sub = store.onDidChange(s => seen.push(s.phase));
  store.set({ ...initialState, phase: 'noSolution' });
  sub.dispose();
  store.set({ ...initialState, phase: 'ready' });
  expect(seen).toEqual(['noSolution']);
  expect(store.state.phase).toBe('ready');
});
