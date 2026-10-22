import * as path from 'path';
import { TreeNode } from '../solution/model';
import { ConfigurationType, typeFor } from '../solution/projectScan';
import { projectConfigFor, SlnProject } from '../solution/slnParser';
import { AppState, Problem } from '../state/store';

export interface StatusRow {
  id: 'solution' | 'configuration' | 'startup' | `problem:${number}`;
  label: string;
  description?: string;
  tooltip?: string;
  icon: string;
  command?: string;
  contextValue: string;
}

export interface ProjectRow {
  label: string;
  description?: string;
  tooltip?: string;
  icon: string;
  contextValue: string;
  resourceUri: string;
  inactive: boolean;
}

export interface Decoration {
  color?: 'disabledForeground';
  tooltip?: string;
}

export interface StatusBarEntry {
  id: 'configuration' | 'startup';
  text: string;
  tooltip: string;
  command: string;
}

const PROBLEM_COMMANDS: Record<NonNullable<Problem['action']>, string> = {
  configureToolchain: 'vssln.configureToolchain',
  openSettings: 'vssln.openSettings',
  selectSolution: 'vssln.selectSolution',
  showLog: 'vssln.showLog',
};

const TYPE_ICONS: Record<ConfigurationType, string> = {
  Application: 'window',
  DynamicLibrary: 'extensions',
  StaticLibrary: 'library',
  Utility: 'tools',
  Makefile: 'tools',
  unknown: 'file-code',
};

const TYPE_SHORT: Record<ConfigurationType, string> = {
  Application: 'exe',
  DynamicLibrary: 'dll',
  StaticLibrary: 'lib',
  Utility: 'utility',
  Makefile: 'makefile',
  unknown: '',
};

function problemRows(s: AppState): StatusRow[] {
  return s.problems.map((p, i) => ({
    id: `problem:${i}` as const,
    label: p.message,
    tooltip: p.message,
    icon: p.severity === 'error' ? 'error' : 'warning',
    ...(p.action ? { command: PROBLEM_COMMANDS[p.action] } : {}),
    contextValue: 'status.problem',
  }));
}

export function statusRows(s: AppState): StatusRow[] {
  if (s.phase === 'loading') return [];
  if (s.phase === 'failed') return problemRows(s);
  if (s.phase === 'noSolution' || !s.solution) {
    return [
      { id: 'solution', label: 'No solution', icon: 'file-code', command: 'vssln.selectSolution', contextValue: 'status.solution' },
      ...problemRows(s),
    ];
  }

  const slnDir = path.win32.dirname(s.solution.path);
  const relDir = s.folder ? path.win32.relative(s.folder, slnDir) || '.' : slnDir;
  const startup = s.solution.projects.find(p => p.guid === s.startupProjectGuid);
  const rows: StatusRow[] = [
    {
      id: 'solution',
      label: path.win32.basename(s.solution.path),
      description: relDir,
      tooltip: s.solution.path,
      icon: 'file-code',
      command: 'vssln.selectSolution',
      contextValue: 'status.solution',
    },
    {
      id: 'configuration',
      label: s.configuration ? `${s.configuration.configuration} | ${s.configuration.platform}` : 'None',
      tooltip: 'Solution configuration',
      icon: 'settings-gear',
      command: 'vssln.selectConfiguration',
      contextValue: 'status.configuration',
    },
    {
      id: 'startup',
      label: startup ? startup.name : 'None',
      description: startup ? 'startup' : 'no application project',
      tooltip: 'Startup project',
      icon: 'rocket',
      command: 'vssln.selectStartupProject',
      contextValue: 'status.startup',
    },
  ];
  return [...rows, ...problemRows(s)];
}

export function projectUri(guid: string): string {
  return 'vssln-project:/' + guid.replace(/[{}]/g, '').toLowerCase();
}

type ProjectStatus = { inactive: string } | { type: ConfigurationType; files: number };

/** Why a project is inactive in the current configuration, or its type and file count. */
export function projectStatus(project: SlnProject, s: AppState): ProjectStatus {
  if (project.kind !== 'vcxproj') return { inactive: 'not a C++ project' };
  const entry = s.projects.get(project.guid);
  if (!entry || !entry.exists) return { inactive: 'file not found' };
  const config = s.configuration?.name ?? '';
  const mapping = s.solution ? projectConfigFor(s.solution, project.guid, config) : undefined;
  if (!mapping) return { inactive: `not in ${config}` };
  return {
    type: typeFor(entry.scan, `${mapping.configuration}|${mapping.platform}`),
    files: (entry.scan?.sources ?? 0) + (entry.scan?.headers ?? 0),
  };
}

export function projectRow(node: TreeNode, s: AppState): ProjectRow {
  const resourceUri = projectUri(node.id);
  if (node.kind === 'folder' || !node.project) {
    return { label: node.label, icon: 'folder', contextValue: 'folder', resourceUri, inactive: false };
  }

  const project = node.project;
  const status = projectStatus(project, s);
  if ('inactive' in status) {
    return {
      label: node.label,
      description: status.inactive,
      tooltip: `${project.absPath}\n${status.inactive}`,
      icon: 'circle-slash',
      // A missing file cannot be opened or revealed, so its menu differs.
      contextValue: status.inactive === 'file not found' ? 'project.missing' : 'project.inactive',
      resourceUri,
      inactive: true,
    };
  }

  const parts = [TYPE_SHORT[status.type], `${status.files} ${status.files === 1 ? 'file' : 'files'}`];
  if (project.guid === s.startupProjectGuid) parts.push('startup');
  return {
    label: node.label,
    description: parts.filter(Boolean).join(' · '),
    tooltip: project.absPath,
    icon: TYPE_ICONS[status.type],
    contextValue: status.type === 'Application' ? 'project.app' : 'project.lib',
    resourceUri,
    inactive: false,
  };
}

export function projectDecoration(uri: string, s: AppState): Decoration | undefined {
  const project = s.solution?.projects.find(p => projectUri(p.guid) === uri);
  if (!project) return undefined;
  const status = projectStatus(project, s);
  return 'inactive' in status ? { color: 'disabledForeground', tooltip: status.inactive } : undefined;
}

export function statusBarItems(s: AppState): StatusBarEntry[] {
  if (s.phase !== 'ready') return [];
  const items: StatusBarEntry[] = [];
  if (s.configuration) {
    items.push({ id: 'configuration', text: `$(settings-gear) ${s.configuration.name}`, tooltip: 'Solution configuration', command: 'vssln.selectConfiguration' });
  }
  const startup = s.solution?.projects.find(p => p.guid === s.startupProjectGuid);
  if (startup) {
    items.push({ id: 'startup', text: `$(rocket) ${startup.name}`, tooltip: 'Startup project', command: 'vssln.selectStartupProject' });
  }
  return items;
}
