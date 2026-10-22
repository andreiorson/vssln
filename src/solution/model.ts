import { ParsedSolution, SlnFolder, SlnProject } from './slnParser';

/** Later kinds: 'references' | 'reference'. */
export type NodeKind = 'folder' | 'project' | 'filter' | 'file';

/** A file of a project; `path` is absent when the include needs MSBuild to be evaluated. */
export interface ItemInfo {
  include: string;
  path?: string;
  missing: boolean;
}

export interface TreeNode {
  id: string;
  kind: NodeKind;
  label: string;
  children: TreeNode[];
  project?: SlnProject;
  folder?: SlnFolder;
  item?: ItemInfo;
  /** The project a filter or file belongs to. */
  projectGuid?: string;
}

function byLabel(a: TreeNode, b: TreeNode): number {
  return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
}

function sortLevel(nodes: TreeNode[]): TreeNode[] {
  const folders = nodes.filter(n => n.kind === 'folder').sort(byLabel);
  const others = nodes.filter(n => n.kind !== 'folder').sort(byLabel);
  for (const n of folders) n.children = sortLevel(n.children);
  return [...folders, ...others];
}

/** Solution folders and projects as a tree; node ids are the .sln GUIDs. */
export function buildTree(sln: ParsedSolution): TreeNode[] {
  const folderNodes = new Map<string, TreeNode>();
  for (const folder of sln.folders) {
    folderNodes.set(folder.guid, { id: folder.guid, kind: 'folder', label: folder.name, children: [], folder });
  }

  const roots: TreeNode[] = [];
  const attach = (node: TreeNode, parentGuid: string | undefined) => {
    const parent = parentGuid ? folderNodes.get(parentGuid) : undefined;
    (parent ? parent.children : roots).push(node);
  };

  for (const folder of sln.folders) attach(folderNodes.get(folder.guid)!, folder.parentGuid);
  for (const project of sln.projects) {
    attach({ id: project.guid, kind: 'project', label: project.name, children: [], project }, project.parentGuid);
  }
  return sortLevel(roots);
}

export interface ChildrenProvider {
  appliesTo(node: TreeNode): boolean;
  children(node: TreeNode): TreeNode[];
  /** The parent of a node this provider gave out, for revealing it in the tree. */
  parentOf?(node: TreeNode): TreeNode | undefined;
}

/** Lets later features (filters, files, references) add children to nodes without changing the views. */
export class ChildrenRegistry {
  private readonly providers: ChildrenProvider[] = [];

  register(provider: ChildrenProvider): void {
    this.providers.push(provider);
  }

  childrenOf(node: TreeNode): TreeNode[] {
    const extra = this.providers.filter(p => p.appliesTo(node)).flatMap(p => p.children(node));
    return [...node.children, ...extra];
  }

  parentOf(node: TreeNode): TreeNode | undefined {
    for (const provider of this.providers) {
      const parent = provider.parentOf?.(node);
      if (parent) return parent;
    }
    return undefined;
  }

  hasChildren(node: TreeNode): boolean {
    return node.children.length > 0 || this.providers.some(p => p.appliesTo(node));
  }
}
