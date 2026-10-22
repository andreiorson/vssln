import { expect, test } from 'vitest';
import { addToExclude, isIgnored } from '../../src/settings/gitExclude';
import { Exec } from '../../src/toolchain/vswhere';
import { memoryFs } from './helpers';

const FOLDER = 'C:\\w';
const REL = '.vscode/vssln.json';

function gitReturning(results: Record<string, { code: number; stdout?: string }>) {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    const r = results[args.slice(2).join(' ')];
    if (!r) throw new Error('spawn git ENOENT');
    return { code: r.code, stdout: r.stdout ?? '', stderr: '' };
  };
  return { exec, calls };
}

test('git check-ignore exit 0 means ignored', async () => {
  const git = gitReturning({ [`check-ignore -q ${REL}`]: { code: 0 } });
  expect(await isIgnored(git.exec, FOLDER, REL)).toBe(true);
  expect(git.calls[0]).toEqual(['git', '-C', FOLDER, 'check-ignore', '-q', REL]);
});

test('exit 1 means not ignored', async () => {
  expect(await isIgnored(gitReturning({ [`check-ignore -q ${REL}`]: { code: 1 } }).exec, FOLDER, REL)).toBe(false);
});

test('exit 128 or exec throwing means unknown', async () => {
  expect(await isIgnored(gitReturning({ [`check-ignore -q ${REL}`]: { code: 128 } }).exec, FOLDER, REL)).toBeUndefined();
  expect(await isIgnored(gitReturning({}).exec, FOLDER, REL)).toBeUndefined();
});

test('appends one line to the path from rev-parse --git-path', async () => {
  const git = gitReturning({ 'rev-parse --git-path info/exclude': { code: 0, stdout: '.git/info/exclude\n' }, 'rev-parse --show-prefix': { code: 0, stdout: '\n' } });
  const fs = memoryFs({ 'C:\\w\\.git\\info\\exclude': '# comment' });
  await addToExclude(git.exec, fs, FOLDER, REL);
  expect(fs.files['C:\\w\\.git\\info\\exclude']).toBe('# comment\n/.vscode/vssln.json\n');
});

test('absolute --git-path result and missing exclude file', async () => {
  const git = gitReturning({ 'rev-parse --git-path info/exclude': { code: 0, stdout: 'D:/repo/.git/worktrees/w/info/exclude\n' }, 'rev-parse --show-prefix': { code: 0, stdout: '\n' } });
  const fs = memoryFs({});
  await addToExclude(git.exec, fs, FOLDER, REL);
  expect(fs.files['D:\\repo\\.git\\worktrees\\w\\info\\exclude']).toBe('/.vscode/vssln.json\n');
});

test('workspace in a subfolder of the repository: the line is anchored at the repository root', async () => {
  const git = gitReturning({
    'rev-parse --git-path info/exclude': { code: 0, stdout: 'D:/repo/.git/info/exclude\n' },
    'rev-parse --show-prefix': { code: 0, stdout: 'engine/\n' },
  });
  const fs = memoryFs({});
  await addToExclude(git.exec, fs, 'D:\\repo\\engine', REL);
  expect(fs.files['D:\\repo\\.git\\info\\exclude']).toBe('/engine/.vscode/vssln.json\n');
});

test('does not duplicate an existing line', async () => {
  const git = gitReturning({ 'rev-parse --git-path info/exclude': { code: 0, stdout: '.git/info/exclude\n' }, 'rev-parse --show-prefix': { code: 0, stdout: '\n' } });
  const fs = memoryFs({ 'C:\\w\\.git\\info\\exclude': '/.vscode/vssln.json\n' });
  let writes = 0;
  const counting = { ...fs, async writeText(p: string, t: string) { writes++; await fs.writeText(p, t); } };
  await addToExclude(git.exec, counting, FOLDER, REL);
  expect(writes).toBe(0);
});
