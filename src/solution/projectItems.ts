import * as path from 'path';
import { decodeXml } from '../util/xml';

/** One file of a project; `path` is absent when the include could not be evaluated without MSBuild. */
export interface ProjectItem {
  itemType: string;
  include: string;
  path?: string;
  filter?: string;
}

export interface ProjectItems {
  items: ProjectItem[];
  /** Filter paths declared in the .filters file or named by an item, in file order. */
  filters: string[];
}

export interface ItemContext {
  projectPath: string;
  solutionPath: string;
}

/** Item types that are not files, so Solution Explorer does not show them either. */
const NOT_FILES = new Set(
  [
    'ProjectConfiguration',
    'ProjectReference',
    'Reference',
    'SDKReference',
    'COMReference',
    'COMFileReference',
    'NativeReference',
    'Folder',
    'Filter',
    'ProjectCapability',
    'PackageReference',
    'ProjectTools',
    'Service',
    'BuildMacro',
  ].map(t => t.toLowerCase()),
);

/** Attributes up to the end of a tag; quoted values may contain `>` (conditions such as '$(X)'>'1'). */
const ATTRIBUTES = `((?:[^>"']|"[^"]*"|'[^']*')*?)`;
// The lookbehind skips self-closing <ItemGroup />, which would otherwise run on to the next closing tag.
const ITEM_GROUP = new RegExp(`<ItemGroup\\b${ATTRIBUTES}(?<!\\/)>([\\s\\S]*?)<\\/ItemGroup\\s*>`, 'g');
const ELEMENT = new RegExp(`<([A-Za-z_][\\w.-]*)\\b${ATTRIBUTES}(?:\\/>|>([\\s\\S]*?)<\\/\\1\\s*>)`, 'g');
/** Comments, and targets: their item groups are computed during a build, Solution Explorer does not show them. */
const SKIPPED = new RegExp(`<!--[\\s\\S]*?-->|<Target\\b${ATTRIBUTES}(?:\\/>|>[\\s\\S]*?<\\/Target\\s*>)`, 'g');
const INCLUDE = /\bInclude\s*=\s*(?:"([^"]*)"|'([^']*)')/;
const FILTER = /<Filter>([^<]*)<\/Filter>/;

/** Elements with an Include inside the ItemGroups of an MSBuild file, with the include list split. */
function* includes(xml: string): Generator<{ itemType: string; include: string; body: string }> {
  for (const group of xml.replace(SKIPPED, '').matchAll(ITEM_GROUP)) {
    for (const element of group[2].matchAll(ELEMENT)) {
      const attr = INCLUDE.exec(element[2]);
      if (!attr) continue;
      for (const include of decodeXml(attr[1] ?? attr[2]).split(';')) {
        const trimmed = include.trim();
        if (trimmed) yield { itemType: element[1], include: trimmed, body: element[3] ?? '' };
      }
    }
  }
}

function macros(ctx: ItemContext): Map<string, string> {
  const projectDir = path.win32.dirname(ctx.projectPath);
  const solutionDir = path.win32.dirname(ctx.solutionPath);
  const withSlash = (dir: string) => (dir.endsWith('\\') ? dir : `${dir}\\`);
  const projectName = path.win32.parse(ctx.projectPath).name;
  return new Map([
    ['projectdir', withSlash(projectDir)],
    ['msbuildthisfiledirectory', withSlash(projectDir)],
    ['msbuildprojectdirectory', projectDir],
    ['solutiondir', withSlash(solutionDir)],
    ['projectname', projectName],
    ['msbuildprojectname', projectName],
    ['solutionname', path.win32.parse(ctx.solutionPath).name],
  ]);
}

/** The absolute path of an include, or undefined when it needs MSBuild (unknown macros, item lists, wildcards). */
function evaluate(include: string, ctx: ItemContext, known: Map<string, string>): string | undefined {
  if (/[@%]\(/.test(include)) return undefined;
  let unknown = false;
  const expanded = include.replace(/\$\(([^)]*)\)/g, (_m, name: string) => {
    const value = known.get(name.trim().toLowerCase());
    if (value === undefined) unknown = true;
    return value ?? '';
  });
  if (unknown) return undefined;
  const unescaped = expanded.replace(/%([0-9a-f]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  if (/[*?]/.test(unescaped)) return undefined;
  return path.win32.resolve(path.win32.dirname(ctx.projectPath), unescaped);
}

/**
 * The files of a .vcxproj and the filter of each from its .vcxproj.filters, read as text the way Solution Explorer
 * lists them: conditions are ignored and the same file is listed once. A .filters file that is not complete XML is
 * ignored, so its files still show.
 */
export function parseProjectItems(vcxproj: string, filters: string | undefined, ctx: ItemContext): ProjectItems {
  const known = macros(ctx);
  const key = (include: string) => (evaluate(include, ctx, known) ?? include).toLowerCase();

  const items: ProjectItem[] = [];
  const byKey = new Map<string, ProjectItem>();
  for (const { itemType, include } of includes(vcxproj)) {
    if (NOT_FILES.has(itemType.toLowerCase())) continue;
    const k = key(include);
    if (byKey.has(k)) continue;
    const resolved = evaluate(include, ctx, known);
    const item: ProjectItem = { itemType, include, ...(resolved ? { path: resolved } : {}) };
    items.push(item);
    byKey.set(k, item);
  }

  const filterPaths: string[] = [];
  const seen = new Set<string>();
  const addFilter = (name: string) => {
    if (seen.has(name.toLowerCase())) return;
    seen.add(name.toLowerCase());
    filterPaths.push(name);
  };
  if (filters && /<\/Project\s*>/.test(filters)) {
    for (const { itemType, include, body } of includes(filters)) {
      if (itemType === 'Filter') {
        addFilter(include);
        continue;
      }
      const item = byKey.get(key(include));
      const name = FILTER.exec(body)?.[1].trim();
      if (!item || !name) continue;
      item.filter = decodeXml(name);
      addFilter(item.filter);
    }
  }
  return { items, filters: filterPaths };
}
