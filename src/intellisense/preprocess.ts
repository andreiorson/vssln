import * as path from 'path';
import { DebugPropertiesInput, projectContextArgs } from '../debug/properties';
import { pathKey } from '../util/paths';
import { DESIGN_TIME } from './dump';

/** MSBuild arguments that write the evaluated project, with every import inlined, to a file (nothing is built). */
export function preprocessArgs(input: DebugPropertiesInput, outFile: string): string[] {
  return [input.projectPath, '-nologo', `-preprocess:${outFile}`, ...projectContextArgs(input, DESIGN_TIME)];
}

const RULE = /^\s*={20,}\s*$/;
const COMMENTED_IMPORT = /^\s*<!--\s*<Import\s+Project\s*=\s*"([^"]*)"/;

/**
 * The files an evaluation read, from -preprocess output: each import is wrapped in a banner of "=" lines whose last
 * line names the file. Imports skipped by their condition stay as comments; those that resolve to a file that does
 * not exist are awaited, since creating it can change the result. A commented import whose file exists was skipped
 * on purpose (a condition such as !exists) and is not awaited, or the cache would never be fresh.
 */
export function parsePreprocess(xml: string, ctx: { projectPath: string; solutionDir: string }, exists: (p: string) => boolean): { inputs: string[]; awaited: string[] } {
  const inputs: string[] = [];
  const awaited: string[] = [];
  const seen = new Set<string>();
  const add = (list: string[], p: string) => {
    if (seen.has(pathKey(p))) return;
    seen.add(pathKey(p));
    list.push(p);
  };

  let current = ctx.projectPath;
  let inBanner = false;
  let last = '';
  for (const line of xml.split(/\r?\n/)) {
    if (RULE.test(line)) {
      // The closing rule: the line before it names the file read from here on.
      if (inBanner && last) {
        current = last;
        add(inputs, current);
      }
      inBanner = !inBanner;
      last = '';
      continue;
    }
    if (inBanner) {
      if (line.trim()) last = line.trim();
      continue;
    }
    const commented = COMMENTED_IMPORT.exec(line);
    if (!commented) continue;
    const dir = path.win32.dirname(current);
    const resolved = commented[1]
      .replace(/\$\(MSBuildThisFileDirectory\)/gi, `${dir}\\`)
      .replace(/\$\(SolutionDir\)/gi, ctx.solutionDir.endsWith('\\') ? ctx.solutionDir : `${ctx.solutionDir}\\`);
    if (resolved.includes('$(') || /[*?]/.test(resolved)) continue;
    const absolute = path.win32.resolve(dir, resolved);
    if (!exists(absolute)) add(awaited, absolute);
  }
  return { inputs, awaited };
}
