import * as path from 'path';

/** A Windows path in one spelling: normalized separators and dot segments, lower case. */
export function pathKey(p: string): string {
  return path.win32.normalize(p).toLowerCase();
}

export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

export function isInside(folder: string, p: string): boolean {
  const rel = path.win32.relative(folder.toLowerCase(), p.toLowerCase());
  return rel !== '' && !rel.startsWith('..') && !path.win32.isAbsolute(rel);
}

const SKIPPED_DIRS = new Set(['node_modules', '.git', '.vs']);

/** A found .sln that is not inside a dependency or tool folder. */
export function isSolutionCandidate(p: string): boolean {
  return !p.split(/[\\/]/).some(part => SKIPPED_DIRS.has(part.toLowerCase()));
}

/**
 * Whether deleting `deleted` (a file or a whole folder) removes something the loaded state depends on.
 * Folder deletions arrive as one event for the folder, so file globs alone miss them.
 */
export function deletionAffects(
  deleted: string,
  s: { folder?: string; solution?: { path: string; projects: { absPath: string }[] } },
): boolean {
  const watched = [
    ...(s.folder ? [path.win32.join(s.folder, '.vscode', 'vssln.json')] : []),
    ...(s.solution ? [s.solution.path, ...s.solution.projects.map(p => p.absPath)] : []),
  ];
  return watched.some(p => samePath(p, deleted) || isInside(deleted, p));
}

/** The workspace folder a path belongs to; the deepest one wins for nested folders. */
export function folderOf(folders: string[], p: string): string | undefined {
  return folders.filter(f => isInside(f, p)).sort((a, b) => b.length - a.length)[0];
}
