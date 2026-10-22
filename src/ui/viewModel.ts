import * as path from 'path';
import { TreeNode } from '../solution/model';
import { ConfigurationType, typeFor } from '../solution/projectScan';
import { projectConfigFor, SlnProject } from '../solution/slnParser';
import { BuildState, ProjectBuild } from '../state/build';
import { AppState, Problem } from '../state/store';

export interface StatusRow {
  id: 'solution' | 'configuration' | 'startup' | 'build' | `problem:${number}`;
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
  color?: 'disabledForeground' | 'list.errorForeground' | 'list.warningForeground';
  badge?: string;
  tooltip?: string;
}

export interface StatusBarEntry {
  id: 'configuration' | 'startup' | 'build';
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

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Elapsed time as m:ss. */
export function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Local wall-clock time as HH:MM. */
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function buildRow(b: BuildState, now: number): StatusRow | undefined {
  if (b.status === 'idle') return undefined;
  const label = b.projectName ? `${b.action} ${b.projectName}` : (b.action ?? 'Build');
  const common = { id: 'build' as const, label, tooltip: b.logFile ? `Build log: ${b.logFile}` : undefined, command: 'vssln.showBuildOutput' };
  const finishedAt = b.finishedAt ?? now;
  switch (b.status) {
    case 'running': {
      const errors = b.errors > 0 ? ` · ${plural(b.errors, 'error')}` : '';
      return { ...common, icon: 'loading~spin', description: `${b.done}/${b.total} · ${duration(now - (b.startedAt ?? now))}${errors}`, contextValue: 'status.build.running' };
    }
    case 'succeeded':
      return { ...common, icon: 'pass', description: `succeeded · ${clock(finishedAt)} · ${duration(finishedAt - (b.startedAt ?? finishedAt))}`, contextValue: 'status.build' };
    case 'failed':
      return { ...common, icon: 'error', description: `failed · ${plural(b.errors, 'error')} · ${clock(finishedAt)} · ${duration(finishedAt - (b.startedAt ?? finishedAt))}`, contextValue: 'status.build' };
    case 'cancelled':
      return { ...common, icon: 'circle-slash', description: `stopped · ${clock(finishedAt)}`, contextValue: 'status.build' };
  }
}

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

export function statusRows(s: AppState, now = Date.now()): StatusRow[] {
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
  const locked = s.build.status === 'running';
  const rows: StatusRow[] = [
    {
      id: 'solution',
      label: path.win32.basename(s.solution.path),
      description: locked ? 'locked during build' : relDir,
      tooltip: s.solution.path,
      icon: 'file-code',
      command: 'vssln.selectSolution',
      contextValue: 'status.solution',
    },
    {
      id: 'configuration',
      label: s.configuration ? `${s.configuration.configuration} | ${s.configuration.platform}` : 'None',
      ...(locked ? { description: 'locked during build' } : {}),
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
  const build = buildRow(s.build, now);
  return [...rows, ...(build ? [build] : []), ...problemRows(s)];
}

function projectBuildDescription(p: ProjectBuild, action: BuildState['action']): string {
  switch (p.status) {
    case 'waiting':
    case 'building':
    case 'skipped':
      return p.status;
    case 'succeeded':
      if (action === 'Clean') return 'cleaned';
      return `built · ${Math.round(((p.finishedAt ?? 0) - (p.startedAt ?? p.finishedAt ?? 0)) / 1000)}s`;
    case 'failed':
      return p.errors > 0 ? plural(p.errors, 'error') : 'failed';
  }
}

function descendantsBuilds(node: TreeNode, s: AppState): ProjectBuild[] {
  return node.children.flatMap(child => {
    const own = child.project ? s.build.projects.get(child.project.guid) : undefined;
    return [...(own ? [own] : []), ...descendantsBuilds(child, s)];
  });
}

function folderBuildDescription(node: TreeNode, s: AppState): string | undefined {
  if (s.build.status === 'idle') return undefined;
  const builds = descendantsBuilds(node, s);
  const building = builds.filter(b => b.status === 'building').length;
  if (building > 0) return `building ${building}`;
  const errors = builds.reduce((n, b) => n + b.errors, 0);
  return errors > 0 ? plural(errors, 'error') : undefined;
}

export function projectUri(guid: string): string {
  return 'vssln-project:/' + guid.replace(/[{}]/g, '').toLowerCase();
}

type ProjectStatus = { inactive: string } | { type: ConfigurationType; files: number; notBuilt?: string };

/**
 * Why a project is inactive in the current configuration, or its type and file count. A project that is mapped but not
 * built by the configuration (unchecked in Configuration Manager) has a type and `notBuilt`: references still build it.
 */
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
    ...(mapping.build ? {} : { notBuilt: `not built in ${config}` }),
  };
}

/** Inactive for display: no type, or not built and not part of the current build either. */
function inactiveReason(status: ProjectStatus, building: boolean): string | undefined {
  if ('inactive' in status) return status.inactive;
  return building ? undefined : status.notBuilt;
}

export function projectRow(node: TreeNode, s: AppState): ProjectRow {
  const resourceUri = projectUri(node.id);
  if (node.kind === 'folder' || !node.project) {
    const description = folderBuildDescription(node, s);
    return { label: node.label, ...(description ? { description } : {}), icon: 'folder', contextValue: 'folder', resourceUri, inactive: false };
  }

  const project = node.project;
  const status = projectStatus(project, s);
  const build = s.build.projects.get(project.guid);
  const inactive = inactiveReason(status, build !== undefined);
  if (inactive !== undefined || 'inactive' in status) {
    const reason = inactive ?? '';
    return {
      label: node.label,
      description: reason,
      tooltip: `${project.absPath}\n${reason}`,
      icon: 'circle-slash',
      // A missing file cannot be opened or revealed, so its menu differs.
      contextValue: reason === 'file not found' ? 'project.missing' : 'project.inactive',
      resourceUri,
      inactive: true,
    };
  }

  const parts = [TYPE_SHORT[status.type], plural(status.files, 'file')];
  if (project.guid === s.startupProjectGuid) parts.push('startup');
  return {
    label: node.label,
    description: build ? projectBuildDescription(build, s.build.action) : parts.filter(Boolean).join(' · '),
    tooltip: build?.messages.length ? `${project.absPath}\n${build.messages.join('\n')}` : project.absPath,
    icon: build?.status === 'building' ? 'loading~spin' : TYPE_ICONS[status.type],
    contextValue: status.type === 'Application' ? 'project.app' : 'project.lib',
    resourceUri,
    inactive: false,
  };
}

export function projectDecoration(uri: string, s: AppState): Decoration | undefined {
  const project = s.solution?.projects.find(p => projectUri(p.guid) === uri);
  if (!project) return undefined;
  const status = projectStatus(project, s);
  const build = s.build.projects.get(project.guid);
  const inactive = inactiveReason(status, build !== undefined);
  if (inactive !== undefined) return { color: 'disabledForeground', tooltip: inactive };
  if (build?.status === 'failed') {
    return {
      color: 'list.errorForeground',
      // Badges hold at most two characters.
      badge: build.errors === 0 ? '!' : String(Math.min(build.errors, 99)),
      tooltip: build.messages[0] ?? 'failed',
    };
  }
  if (build && build.warnings > 0) return { color: 'list.warningForeground' };
  return undefined;
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
  const b = s.build;
  if (b.status === 'running') {
    items.push({ id: 'build', text: `$(sync~spin) Building ${b.done}/${b.total}${b.errors > 0 ? ` · $(error) ${b.errors}` : ''}`, tooltip: 'Build in progress', command: 'vssln.showBuildOutput' });
  } else if (b.status === 'failed') {
    items.push({ id: 'build', text: `$(error) ${b.errors}`, tooltip: `Build failed: ${plural(b.errors, 'error')}`, command: 'workbench.actions.view.problems' });
  }
  return items;
}
