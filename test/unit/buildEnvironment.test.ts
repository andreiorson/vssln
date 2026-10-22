import { expect, test } from 'vitest';
import { msbuildEnvironment } from '../../src/build/environment';

const context = {
  folder: 'C:\\w',
  solutionDir: 'C:\\w\\src\\',
  configuration: { name: 'Release|x64', configuration: 'Release', platform: 'x64' },
};

test('settings variables are expanded with the solution context and override case-insensitively', () => {
  const env = msbuildEnvironment({ ...context, settings: { environment: { path: '${solutionDir}bin;${env:PATH}', MODE: '${configuration}' } } }, { Path: 'C:\\bin' });
  expect(env.Path).toBe('C:\\w\\src\\bin;C:\\bin');
  expect(env.MODE).toBe('Release');
  expect(Object.keys(env).filter(k => k.toLowerCase() === 'path')).toEqual(['Path']);
});

test('editor variables are dropped and the output language is English', () => {
  const env = msbuildEnvironment({ ...context, settings: {} }, { ELECTRON_RUN_AS_NODE: '1', VSCODE_PID: '2', KEEP: 'k' });
  expect(env).toEqual({ KEEP: 'k', DOTNET_CLI_UI_LANGUAGE: 'en-US', VSLANG: '1033' });
});
