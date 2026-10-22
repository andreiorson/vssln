import * as path from 'path';
import { Exec } from '../toolchain/vswhere';
import { SettingsFs } from './settingsFile';

/** true or false from `git check-ignore`; undefined when the folder is not a repository or git is unavailable. */
export async function isIgnored(exec: Exec, folder: string, relPath: string): Promise<boolean | undefined> {
  try {
    const { code } = await exec('git', ['-C', folder, 'check-ignore', '-q', relPath]);
    if (code === 0) return true;
    if (code === 1) return false;
    return undefined;
  } catch {
    return undefined;
  }
}

/** Adds the path to the repository's local exclude file (never to .gitignore). */
export async function addToExclude(exec: Exec, fs: SettingsFs, folder: string, relPath: string): Promise<void> {
  const gitPath = await exec('git', ['-C', folder, 'rev-parse', '--git-path', 'info/exclude']);
  // Patterns in info/exclude are relative to the repository root, which may be above the workspace folder.
  const prefix = await exec('git', ['-C', folder, 'rev-parse', '--show-prefix']);
  if (gitPath.code !== 0 || prefix.code !== 0) throw new Error('git rev-parse failed');
  const excludePath = path.win32.resolve(folder, gitPath.stdout.trim());
  const line = '/' + prefix.stdout.trim() + relPath.replace(/\\/g, '/');

  const current = (await fs.readText(excludePath)) ?? '';
  if (current.split(/\r?\n/).some(l => l.trim() === line)) return;
  const separator = current === '' || current.endsWith('\n') ? '' : '\n';
  await fs.writeText(excludePath, `${current}${separator}${line}\n`);
}
