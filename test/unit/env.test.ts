import { expect, test } from 'vitest';
import { envLookup, setVariable, withVariables } from '../../src/util/env';

test('lookup ignores case', () => {
  expect(envLookup({ Path: 'p' }, 'PATH')).toBe('p');
  expect(envLookup({ Path: 'p' }, 'NOPE')).toBeUndefined();
});

test('setting a variable replaces other spellings, keeping the existing spelling', () => {
  const env: Record<string, string | undefined> = { Path: 'old', A: '1' };
  setVariable(env, 'PATH', 'new');
  expect(env).toEqual({ Path: 'new', A: '1' });
});

test('withVariables layers maps without duplicate spellings', () => {
  expect(withVariables({ Path: 'proc', HOME: 'h' }, { PATH: 'settings' }, { path: 'last' })).toEqual({ Path: 'last', HOME: 'h' });
});
