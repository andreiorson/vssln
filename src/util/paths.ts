import * as path from 'path';

export function samePath(a: string, b: string): boolean {
  return path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();
}

export function isInside(folder: string, p: string): boolean {
  const rel = path.win32.relative(folder.toLowerCase(), p.toLowerCase());
  return rel !== '' && !rel.startsWith('..') && !path.win32.isAbsolute(rel);
}

/** The workspace folder a path belongs to; the deepest one wins for nested folders. */
export function folderOf(folders: string[], p: string): string | undefined {
  return folders.filter(f => isInside(f, p)).sort((a, b) => b.length - a.length)[0];
}
