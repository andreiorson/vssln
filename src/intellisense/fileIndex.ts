import * as path from 'path';
import { projectConfigFor } from '../solution/slnParser';
import { AppState } from '../state/store';
import { pathKey } from '../util/paths';
import { CppConfiguration, toConfiguration } from './configuration';
import { CommandLineRecord, ProjectDump } from './dump';

type IndexState = Pick<AppState, 'solution' | 'projects' | 'startupProjectGuid' | 'configuration'>;

/**
 * From a file to the project and command line its IntelliSense comes from. Membership comes from the project items
 * already loaded for the tree, so it is known before MSBuild ran. A file listed by several projects belongs to the
 * startup project first, then to the others in solution order; a file in no project but inside a project's folder
 * belongs to the nearest such project.
 */
export class FileIndex {
  /** Projects that list a file, in the order they are asked. */
  private readonly listing = new Map<string, string[]>();
  /** Project folders, deepest first. */
  private readonly folders: { dir: string; guid: string }[] = [];
  private readonly records = new WeakMap<ProjectDump, Map<string, CommandLineRecord>>();
  /** Include directories of each project's default command line (without the system ones), with a trailing "\". */
  private readonly includeDirs = new WeakMap<ProjectDump, string[]>();
  /** C++ projects on disk: the startup project first, then solution order. */
  private readonly order: string[] = [];
  /** Project folders by guid: cl resolves relative paths of a command line against them. */
  private readonly projectDirs = new Map<string, string>();

  constructor(private readonly s: IndexState) {
    const cpp = (s.solution?.projects ?? []).filter(p => p.kind === 'vcxproj' && s.projects.get(p.guid)?.exists);
    const ordered = [...cpp.filter(p => p.guid === s.startupProjectGuid), ...cpp.filter(p => p.guid !== s.startupProjectGuid)];
    this.order = ordered.map(p => p.guid);
    for (const project of ordered) {
      for (const item of s.projects.get(project.guid)?.items?.items ?? []) {
        if (!item.path) continue;
        const k = pathKey(item.path);
        const list = this.listing.get(k);
        if (!list) this.listing.set(k, [project.guid]);
        else if (!list.includes(project.guid)) list.push(project.guid);
      }
      this.projectDirs.set(project.guid, path.win32.dirname(project.absPath));
      this.folders.push({ dir: `${pathKey(path.win32.dirname(project.absPath))}\\`, guid: project.guid });
    }
    this.folders.sort((a, b) => b.dir.length - a.dir.length);
  }

  /** The projects a file's configuration may come from, best first. */
  private candidates(file: string): string[] {
    const k = pathKey(file);
    const listed = this.listing.get(k);
    if (listed) return listed;
    const nearest = this.folders.find(f => k.startsWith(f.dir));
    return nearest ? [nearest.guid] : [];
  }

  projectFor(file: string): string | undefined {
    return this.candidates(file)[0];
  }

  /** The configuration of the first candidate project that has data; undefined leaves the file to cpptools' defaults. */
  configurationFor(file: string, dumps: ReadonlyMap<string, ProjectDump>): CppConfiguration | undefined {
    const listed = this.candidates(file);
    // A header in a shared include folder (Core\include\engine\x.h) belongs to no project: it is parsed with a
    // project that puts its folder on the include path, as a source of that project would see it.
    const candidates = listed.length > 0 ? listed : this.includingProjects(file, dumps);
    for (const guid of candidates) {
      const dump = dumps.get(guid);
      const record = dump && this.recordFor(dump, file);
      if (!dump || !record) continue;
      const platform = (this.s.solution && this.s.configuration && projectConfigFor(this.s.solution, guid, this.s.configuration.name)?.platform) ?? 'x64';
      return toConfiguration(record.commandLine, dump.systemIncludes, platform, file, this.projectDirs.get(guid));
    }
    return undefined;
  }

  private includingProjects(file: string, dumps: ReadonlyMap<string, ProjectDump>): string[] {
    const k = pathKey(file);
    return this.order.filter(guid => {
      const dump = dumps.get(guid);
      return dump !== undefined && this.projectIncludeDirs(dump, guid).some(dir => k.startsWith(dir));
    });
  }

  private projectIncludeDirs(dump: ProjectDump, guid: string): string[] {
    let dirs = this.includeDirs.get(dump);
    if (!dirs) {
      const record = dump.records.find(r => r.projectDefault) ?? dump.records[0];
      dirs = record ? toConfiguration(record.commandLine, [], 'x64', undefined, this.projectDirs.get(guid)).includePath.map(d => `${pathKey(d).replace(/\\+$/, '')}\\`) : [];
      this.includeDirs.set(dump, dirs);
    }
    return dirs;
  }

  /** The file's own record, else the project default (headers, excluded sources), else the first one. */
  private recordFor(dump: ProjectDump, file: string): CommandLineRecord | undefined {
    let byFile = this.records.get(dump);
    if (!byFile) {
      byFile = new Map();
      for (const record of dump.records) for (const f of record.files) if (!byFile.has(pathKey(f))) byFile.set(pathKey(f), record);
      this.records.set(dump, byFile);
    }
    return byFile.get(pathKey(file)) ?? dump.records.find(r => r.projectDefault) ?? dump.records[0];
  }
}
