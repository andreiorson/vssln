import * as path from 'path';
import { buildTree, TreeNode } from '../solution/model';
import { SlnProject } from '../solution/slnParser';
import { AppState } from '../state/store';
import { folderOf, samePath } from '../util/paths';
import { projectStatus } from './viewModel';

export interface PickItem<T> {
  label: string;
  description?: string;
  detail?: string;
  picked?: boolean;
  value: T;
}

export function solutionItems(solutions: string[], folders: string[], current?: string): PickItem<string>[] {
  return solutions.map(p => {
    const folder = folderOf(folders, p);
    return {
      label: path.win32.basename(p),
      description: folder ? path.win32.relative(folder, p) : p,
      picked: current !== undefined && samePath(p, current),
      value: p,
    };
  });
}

export function configurationItems(s: AppState): PickItem<string>[] {
  return (s.solution?.configurations ?? []).map(c => ({ label: c.name, picked: c.name === s.configuration?.name, value: c.name }));
}

function projectsInTreeOrder(nodes: TreeNode[]): SlnProject[] {
  return nodes.flatMap(n => (n.project ? [n.project] : projectsInTreeOrder(n.children)));
}

export function startupItems(s: AppState, showAll: boolean): PickItem<string>[] {
  if (!s.solution) return [];
  const projects = projectsInTreeOrder(buildTree(s.solution)).filter(p => {
    if (p.kind !== 'vcxproj') return false;
    if (showAll) return true;
    const status = projectStatus(p, s);
    return 'type' in status && status.type === 'Application';
  });
  const items: PickItem<string>[] = projects.map(p => {
    const current = p.guid === s.startupProjectGuid;
    return { label: p.name, ...(current ? { description: 'current' } : {}), picked: current, value: p.guid };
  });
  if (!showAll) items.push({ label: 'Show all projects…', value: 'showAll' });
  return items;
}
