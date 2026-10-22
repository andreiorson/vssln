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
  /** Theme color id for the icon. */
  iconColor?: string;
  /** Lets the decoration provider color the label (scheme vssln-status). */
  resourceUri?: string;
  command?: string;
  contextValue: string;
}

export interface ProjectRow {
  label: string;
  description?: string;
  tooltip?: string;
  icon: string;
  /** Theme color id for the icon. */
  iconColor?: string;
  contextValue: string;
  resourceUri: string;
  inactive: boolean;
  /** The icon comes from the file icon theme (by resourceUri, or by openPath for files) instead of `icon`. */
  themeIcon?: 'file' | 'folder';
  /** A file the row opens on click. */
  openPath?: string;
}

export interface Decoration {
  color?: 'disabledForeground' | 'list.errorForeground' | 'list.warningForeground' | 'testing.iconPassed';
  badge?: string;
  tooltip?: string;
}

export interface StatusBarEntry {
  id: 'configuration' | 'startup' | 'build';
  text: string;
  tooltip: string;
  command: string;
  /** Theme color id for the text. */
  color?: string;
  /** The only backgrounds VS Code lets extensions use on status bar items. */
  background?: 'statusBarItem.errorBackground' | 'statusBarItem.warningBackground';
}

/** Theme colors of build results; theme-aware, so they work in light and dark themes. */
const PASSED = 'testing.iconPassed';
const FAILED = 'testing.iconFailed';
const RUNNING = 'charts.blue';
const WARNING = 'list.warningForeground';
export const STATUS_BUILD_URI = 'vssln-status:/build';

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
      return { ...common, icon: 'loading~spin', iconColor: RUNNING, description: `${b.done}/${b.total} · ${duration(now - (b.startedAt ?? now))}${errors}`, contextValue: 'status.build.running' };
    }
    case 'succeeded': {
      const warned = b.warnings > 0;
      const warnings = warned ? ` · ${plural(b.warnings, 'warning')}` : '';
      return {
        ...common, icon: warned ? 'warning' : 'pass', iconColor: warned ? WARNING : PASSED, resourceUri: STATUS_BUILD_URI,
        description: `succeeded${warnings} · ${clock(finishedAt)} · ${duration(finishedAt - (b.startedAt ?? finishedAt))}`, contextValue: 'status.build',
      };
    }
    case 'failed': {
      const errors = b.errors > 0 ? ` · ${plural(b.errors, 'error')}` : '';
      return {
        ...common, icon: 'error', iconColor: FAILED, resourceUri: STATUS_BUILD_URI,
        description: `failed${errors} · ${clock(finishedAt)} · ${duration(finishedAt - (b.startedAt ?? finishedAt))}`, contextValue: 'status.build',
      };
    }
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

/** Label color of the Build row: green after success, red after failure. */
export function statusDecoration(uri: string, s: AppState): Decoration | undefined {
  if (uri !== STATUS_BUILD_URI) return undefined;
  if (s.build.status === 'succeeded') return { color: s.build.warnings > 0 ? WARNING : PASSED };
  if (s.build.status === 'failed') return { color: 'list.errorForeground' };
  return undefined;
}

function projectIconColor(build: ProjectBuild | undefined): string | undefined {
  switch (build?.status) {
    case 'building':
      return RUNNING;
    case 'succeeded':
      return build.warnings > 0 ? WARNING : PASSED;
    case 'failed':
      return FAILED;
    default:
      return undefined;
  }
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

export const ITEM_SCHEME = 'vssln-item';

/** Why a file row is inactive; also the first segment of its URI, so the decoration needs no lookup. */
const ITEM_REASONS: Record<string, string> = { missing: 'file not found', unevaluated: 'not evaluated' };

/** Synthetic URI of a filter or file row: `vssln-item:/<state>/<encoded node id>`. */
export function itemUri(node: TreeNode): string {
  const state = node.kind === 'filter' ? 'filter' : !node.item?.path ? 'unevaluated' : node.item.missing ? 'missing' : 'file';
  return `${ITEM_SCHEME}:/${state}/${encodeURIComponent(node.id)}`;
}

function itemRow(node: TreeNode): ProjectRow {
  const resourceUri = itemUri(node);
  if (node.kind === 'filter') {
    return { label: node.label, icon: 'folder', themeIcon: 'folder', contextValue: 'filter', resourceUri, inactive: false };
  }
  const item = node.item!;
  const tooltip = item.path ?? item.include;
  if (item.path && !item.missing) {
    return { label: node.label, tooltip, icon: 'file', themeIcon: 'file', openPath: item.path, contextValue: 'file', resourceUri, inactive: false };
  }
  const state = item.path ? 'missing' : 'unevaluated';
  return {
    label: node.label,
    description: ITEM_REASONS[state],
    // The decoration adds the reason to the tooltip.
    tooltip,
    icon: 'circle-slash',
    contextValue: `file.${state}`,
    resourceUri,
    inactive: true,
  };
}

export function projectRow(node: TreeNode, s: AppState): ProjectRow {
  if (node.kind === 'filter' || node.kind === 'file') return itemRow(node);
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

  const iconColor = projectIconColor(build);
  const parts = [TYPE_SHORT[status.type], plural(status.files, 'file')];
  if (project.guid === s.startupProjectGuid) parts.push('startup');
  return {
    label: node.label,
    description: build ? projectBuildDescription(build, s.build.action) : parts.filter(Boolean).join(' · '),
    tooltip: build?.messages.length ? `${project.absPath}\n${build.messages.join('\n')}` : project.absPath,
    icon: build?.status === 'building' ? 'loading~spin' : TYPE_ICONS[status.type],
    ...(iconColor ? { iconColor } : {}),
    contextValue: status.type === 'Application' ? 'project.app' : 'project.lib',
    resourceUri,
    inactive: false,
  };
}

export function projectDecoration(uri: string, s: AppState): Decoration | undefined {
  if (uri.startsWith(`${ITEM_SCHEME}:/`)) {
    const reason = ITEM_REASONS[uri.slice(ITEM_SCHEME.length + 2).split('/')[0]];
    return reason ? { color: 'disabledForeground', tooltip: reason } : undefined;
  }
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
  if (build?.status === 'skipped') return { color: 'disabledForeground', tooltip: 'skipped' };
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
    // No recognised error (MSBuild crashed or was killed from outside): say so instead of "0 errors".
    const text = b.errors > 0 ? `$(error) ${plural(b.errors, 'error')}` : '$(error) Build failed';
    items.push({
      id: 'build', text, tooltip: b.errors > 0 ? `Build failed: ${plural(b.errors, 'error')}` : 'Build failed',
      command: 'workbench.actions.view.problems', background: 'statusBarItem.errorBackground',
    });
  } else if (b.status === 'succeeded') {
    const finishedAt = b.finishedAt ?? 0;
    const done = b.action === 'Rebuild' ? 'Rebuilt' : b.action === 'Clean' ? 'Cleaned' : 'Built';
    const warnings = b.warnings > 0 ? ` · ${plural(b.warnings, 'warning')}` : '';
    // No text color: green on the status bar's blue or orange (debugging) background is unreadable.
    items.push({
      id: 'build', text: `$(${b.warnings > 0 ? 'warning' : 'check'}) ${done} ${duration(finishedAt - (b.startedAt ?? finishedAt))}${warnings}`,
      tooltip: `Build succeeded at ${clock(finishedAt)}${warnings}`, command: 'vssln.showBuildOutput',
    });
  }
  return items;
}
