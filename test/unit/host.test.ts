import * as fs from 'fs';
import * as path from 'path';
import { expect, test } from 'vitest';
import { cachedToolchain, ToolchainResult } from '../../src/toolchain/vswhere';
import { deletionAffects, isSolutionCandidate } from '../../src/util/paths';

test('solution candidates skip dependency and tool folders', () => {
  expect(isSolutionCandidate('C:\\w\\Engine.sln')).toBe(true);
  expect(isSolutionCandidate('C:\\w\\src\\Tools.sln')).toBe(true);
  expect(isSolutionCandidate('C:\\w\\node_modules\\pkg\\x.sln')).toBe(false);
  expect(isSolutionCandidate('C:\\w\\.vs\\x.sln')).toBe(false);
  expect(isSolutionCandidate('C:\\w\\.git\\x.sln')).toBe(false);
});

test('deleting a folder matters when it holds the solution, a project or the settings file', () => {
  const s = {
    folder: 'C:\\w',
    solution: { path: 'C:\\w\\src\\E.sln', projects: [{ absPath: 'C:\\w\\src\\Game\\Game.vcxproj' }] },
  };
  expect(deletionAffects('C:\\w\\src\\Game', s)).toBe(true);
  expect(deletionAffects('c:\\W\\SRC', s)).toBe(true);
  expect(deletionAffects('C:\\w\\.vscode', s)).toBe(true);
  expect(deletionAffects('C:\\w\\src\\Game\\obj', s)).toBe(false);
  expect(deletionAffects('C:\\w\\docs', s)).toBe(false);
});

test('toolchain lookups are cached per options until cleared', async () => {
  let calls = 0;
  const result: ToolchainResult = { problem: 'none' };
  const cache = cachedToolchain(async () => {
    calls++;
    return result;
  });
  await cache.find({ vsVersion: '[16,17)' });
  await cache.find({ vsVersion: '[16,17)' });
  expect(calls).toBe(1);
  await cache.find({});
  expect(calls).toBe(2);
  cache.clear();
  await cache.find({ vsVersion: '[16,17)' });
  expect(calls).toBe(3);
});

test('the welcome view offers actions that work without a .sln', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  const welcome = pkg.contributes.viewsWelcome.find((w: { view: string }) => w.view === 'vssln.projects');
  expect(welcome.contents).toContain('command:vssln.refresh');
  expect(welcome.contents).toContain('command:vscode.openFolder');
  expect(welcome.contents).not.toContain('command:vssln.selectSolution');
});
