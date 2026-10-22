import * as path from 'path';

export type ProjectKind = 'vcxproj' | 'other';

export interface SlnProject {
  guid: string;
  typeGuid: string;
  name: string;
  relPath: string;
  absPath: string;
  kind: ProjectKind;
  parentGuid?: string;
  dependencies: string[];
  order: number;
}

export interface SlnFolder {
  guid: string;
  name: string;
  parentGuid?: string;
  order: number;
}

export interface SolutionConfig {
  name: string;
  configuration: string;
  platform: string;
}

export interface ProjectConfigMapping {
  configuration: string;
  platform: string;
  build: boolean;
}

export interface ParsedSolution {
  path: string;
  dir: string;
  projects: SlnProject[];
  folders: SlnFolder[];
  configurations: SolutionConfig[];
  mapping: Map<string, Map<string, ProjectConfigMapping>>;
  /** Problems found while parsing that do not stop it. */
  warnings: string[];
}

export const SOLUTION_FOLDER_TYPE = '{2150E333-8FDC-42A3-9474-1A3956D46DE8}';

const PROJECT_LINE = /^Project\("(\{[^}]+\})"\)\s*=\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"(\{[^}]+\})"/;
const SECTION_START = /^(?:Global|Project)Section\(([^)]+)\)/;
const ASSIGNMENT = /^(.*?)\s*=\s*(.*)$/;

function splitConfigName(name: string): SolutionConfig {
  const bar = name.lastIndexOf('|');
  return bar < 0
    ? { name, configuration: name, platform: '' }
    : { name, configuration: name.slice(0, bar), platform: name.slice(bar + 1) };
}

/** Parses the text of a Visual Studio .sln file. GUIDs are normalised to upper case. */
export function parseSln(text: string, slnPath: string): ParsedSolution {
  const dir = path.win32.dirname(slnPath);
  const projects: SlnProject[] = [];
  const folders: SlnFolder[] = [];
  const configurations: SolutionConfig[] = [];
  const mapping = new Map<string, Map<string, ProjectConfigMapping>>();
  const parents = new Map<string, string>();
  const names = new Map<string, string>();
  const warnings: string[] = [];

  let order = 0;
  let currentProject: SlnProject | undefined;
  let section: string | undefined;

  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const project = PROJECT_LINE.exec(line);
    if (project) {
      const [, typeGuid, name, relPath, guid] = project;
      const typeUpper = typeGuid.toUpperCase();
      const guidUpper = guid.toUpperCase();
      currentProject = undefined;
      const first = names.get(guidUpper);
      if (first !== undefined) {
        // A merge or a copied project file can leave two entries with one GUID; tree ids must stay unique.
        warnings.push(`Project "${name}" has the same GUID ${guidUpper} as "${first}" and is not shown.`);
        continue;
      }
      names.set(guidUpper, name);
      if (typeUpper === SOLUTION_FOLDER_TYPE) {
        folders.push({ guid: guidUpper, name, order: order++ });
      } else {
        currentProject = {
          guid: guidUpper,
          typeGuid: typeUpper,
          name,
          relPath,
          absPath: path.win32.resolve(dir, relPath),
          kind: /\.vcxproj$/i.test(relPath) ? 'vcxproj' : 'other',
          dependencies: [],
          order: order++,
        };
        projects.push(currentProject);
      }
      continue;
    }
    if (line === 'EndProject') {
      currentProject = undefined;
      continue;
    }

    const start = SECTION_START.exec(line);
    if (start) {
      section = start[1];
      continue;
    }
    if (line === 'EndGlobalSection' || line === 'EndProjectSection') {
      section = undefined;
      continue;
    }
    if (!section) continue;

    const assignment = ASSIGNMENT.exec(line);
    if (!assignment) continue;
    const [, key, value] = assignment;

    switch (section) {
      case 'ProjectDependencies':
        currentProject?.dependencies.push(key.toUpperCase());
        break;
      case 'SolutionConfigurationPlatforms':
        configurations.push(splitConfigName(key));
        break;
      case 'ProjectConfigurationPlatforms': {
        const close = key.indexOf('}');
        if (close < 0) continue;
        const guid = key.slice(0, close + 1).toUpperCase();
        const rest = key.slice(close + 2);
        const suffix = /\.(ActiveCfg|Build\.0)$/.exec(rest);
        if (!suffix) continue;
        const solutionConfig = rest.slice(0, suffix.index);
        let byConfig = mapping.get(guid);
        if (!byConfig) mapping.set(guid, (byConfig = new Map()));
        const target = splitConfigName(value);
        const entry = byConfig.get(solutionConfig) ?? { configuration: target.configuration, platform: target.platform, build: false };
        if (suffix[1] === 'ActiveCfg') {
          entry.configuration = target.configuration;
          entry.platform = target.platform;
        } else {
          entry.build = true;
        }
        byConfig.set(solutionConfig, entry);
        break;
      }
      case 'NestedProjects':
        parents.set(key.toUpperCase(), value.toUpperCase());
        break;
    }
  }

  for (const p of projects) p.parentGuid = parents.get(p.guid);
  for (const f of folders) f.parentGuid = parents.get(f.guid);

  return { path: slnPath, dir, projects, folders, configurations, mapping, warnings };
}

export function projectConfigFor(sln: ParsedSolution, projectGuid: string, solutionConfig: string): ProjectConfigMapping | undefined {
  return sln.mapping.get(projectGuid.toUpperCase())?.get(solutionConfig);
}
