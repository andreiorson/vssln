import { defineConfig } from '@vscode/test-cli';

// The extension depends on the C/C++ extension (cppvsdbg), so the test profiles install it; they use their own
// extensions folder under .vscode-test, so nothing else is loaded.
const common = {
  installExtensions: ['ms-vscode.cpptools'],
};

export default defineConfig([
  {
    ...common,
    label: 'fixture',
    files: 'out/test/integration/**/*.test.js',
    workspaceFolder: 'test/fixtures/workspace',
    mocha: { ui: 'tdd', timeout: 20000 },
  },
  {
    ...common,
    // Real MSBuild builds and launches of the sample solution; tests skip themselves without Visual Studio.
    label: 'engine',
    files: 'out/test/engine/**/*.test.js',
    workspaceFolder: 'samples/Engine',
    mocha: { ui: 'tdd', timeout: 300000 },
  },
]);
