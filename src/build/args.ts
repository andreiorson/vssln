import { ParsedSolution, SlnProject, SolutionConfig } from '../solution/slnParser';
import { VsInstance } from '../toolchain/vswhere';

export type BuildAction = 'Build' | 'Rebuild' | 'Clean';

/** Without a project the whole solution is built. */
export interface BuildRequest {
  action: BuildAction;
  project?: SlnProject;
}

export interface BuildCommandInput {
  sln: ParsedSolution;
  config: SolutionConfig;
  toolchain: VsInstance;
  request: BuildRequest;
  properties: Record<string, string>;
  logFile: string;
}

/** MSBuild replaces these characters with '_' in solution target names. */
function cleanse(name: string): string {
  return name.replace(/[%$@;.()']/g, '_');
}

/** The solution-level target of a project: its solution folder chain and name, as MSBuild names it ("Graphics\Render"). */
export function solutionTargetName(sln: ParsedSolution, project: SlnProject): string {
  const parts = [project.name];
  const seen = new Set<string>();
  let parent = project.parentGuid;
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    const folder = sln.folders.find(f => f.guid === parent);
    if (!folder) break;
    parts.unshift(folder.name);
    parent = folder.parentGuid;
  }
  return parts.map(cleanse).join('\\');
}

/** MSBuild splits -p: values on ';' and ','; its %XX escapes keep them whole. */
function escapeValue(value: string): string {
  return value.replace(/%/g, '%25').replace(/;/g, '%3B').replace(/,/g, '%2C');
}

function target(input: BuildCommandInput): string {
  const { request, sln } = input;
  if (!request.project) return request.action;
  const name = solutionTargetName(sln, request.project);
  return request.action === 'Build' ? name : `${name}:${request.action}`;
}

/** Arguments for MSBuild.exe; normal verbosity is what the output parser reads. */
export function buildArgs(input: BuildCommandInput): string[] {
  const { sln, config, toolchain, properties, logFile } = input;
  return [
    sln.path,
    `-t:${target(input)}`,
    '-m',
    '-nologo',
    '-nr:false',
    '-v:normal',
    `-p:Configuration=${config.configuration}`,
    `-p:Platform=${config.platform}`,
    ...(toolchain.devEnvDir ? [`-p:DevEnvDir=${toolchain.devEnvDir}`] : []),
    ...Object.keys(properties).sort().map(k => `-p:${k}=${escapeValue(properties[k])}`),
    '-fl',
    `-flp:LogFile=${logFile};Verbosity=normal;Encoding=UTF-8`,
  ];
}
