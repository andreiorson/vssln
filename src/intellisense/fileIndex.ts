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

  constructor(private readonly s: IndexState) {
    const cpp = (s.solution?.projects ?? []).filter(p => p.kind === 'vcxproj' && s.projects.get(p.guid)?.exists);
    const ordered = [...cpp.filter(p => p.guid === s.startupProjectGuid), ...cpp.filter(p => p.guid !== s.startupProjectGuid)];
    for (const project of ordered) {
      for (const item of s.projects.get(project.guid)?.items?.items ?? []) {
        if (!item.path) continue;
        const k = pathKey(item.path);
        const list = this.listing.get(k);
        if (!list) this.listing.set(k, [project.guid]);
        else if (!list.includes(project.guid)) list.push(project.guid);
      }
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
    for (const guid of this.candidates(file)) {
      const dump = dumps.get(guid);
      const record = dump && this.recordFor(dump, file);
      if (!dump || !record) continue;
      const platform = (this.s.solution && this.s.configuration && projectConfigFor(this.s.solution, guid, this.s.configuration.name)?.platform) ?? 'x64';
      return toConfiguration(record.commandLine, dump.systemIncludes, platform, file);
    }
    return undefined;
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
