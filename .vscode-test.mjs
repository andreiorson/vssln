import { defineConfig } from '@vscode/test-cli';

export default defineConfig([
  {
    label: 'fixture',
    files: 'out/test/integration/**/*.test.js',
    workspaceFolder: 'test/fixtures/workspace',
    launchArgs: ['--disable-extensions'],
    mocha: { ui: 'tdd', timeout: 20000 },
  },
  {
    // Real MSBuild builds of the sample solution; tests skip themselves without Visual Studio.
    label: 'engine',
    files: 'out/test/engine/**/*.test.js',
    workspaceFolder: 'samples/Engine',
    launchArgs: ['--disable-extensions'],
    mocha: { ui: 'tdd', timeout: 300000 },
  },
]);
