import * as path from 'path';

export type Exec = (file: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface VsInstance {
  installationPath: string;
  installationVersion: string;
  displayName: string;
  msbuildPath: string;
  /** Ends with a backslash, as MSBuild expects for $(DevEnvDir). Empty when it could not be derived. */
  devEnvDir: string;
}

export interface ToolchainResult {
  instance?: VsInstance;
  problem?: string;
}

export interface ToolchainDeps {
  exec: Exec;
  exists(p: string): Promise<boolean>;
  programFilesX86: string | undefined;
}

export interface ToolchainOptions {
  vsVersion?: string;
  msbuildPath?: string | null;
}

const MSBUILD_CANDIDATES = [
  ['MSBuild', 'Current', 'Bin', 'MSBuild.exe'],
  ['MSBuild', '15.0', 'Bin', 'MSBuild.exe'],
];

function devEnvDirOf(installationPath: string): string {
  return path.win32.join(installationPath, 'Common7', 'IDE') + '\\';
}

/** The Visual Studio root above an MSBuild.exe of the usual layout (<root>\MSBuild\<ver>\Bin\...\MSBuild.exe). */
function installRootOf(msbuildPath: string): string | undefined {
  const parts = path.win32.normalize(msbuildPath).split('\\');
  const i = parts.map(p => p.toLowerCase()).lastIndexOf('msbuild', parts.length - 2);
  return i > 0 ? parts.slice(0, i).join('\\') : undefined;
}

async function fromExplicitPath(msbuildPath: string, deps: ToolchainDeps): Promise<ToolchainResult> {
  if (!(await deps.exists(msbuildPath))) {
    return { problem: `MSBuild not found at "${msbuildPath}" (toolchain.msbuildPath in vssln.json).` };
  }
  const root = installRootOf(msbuildPath);
  const instance: VsInstance = {
    installationPath: root ?? '',
    installationVersion: '',
    displayName: 'MSBuild from vssln.json',
    msbuildPath,
    devEnvDir: root ? devEnvDirOf(root) : '',
  };
  return root
    ? { instance }
    : { instance, problem: `DevEnvDir could not be derived from "${msbuildPath}"; tools that need it may fail.` };
}

interface VswhereEntry {
  installationPath?: string;
  installationVersion?: string;
  displayName?: string;
}

/** Finds Visual Studio and its MSBuild through vswhere, or uses the explicit MSBuild path from the settings. */
export async function findToolchain(opts: ToolchainOptions, deps: ToolchainDeps): Promise<ToolchainResult> {
  if (opts.msbuildPath) return fromExplicitPath(opts.msbuildPath, deps);

  if (!deps.programFilesX86) return { problem: 'vswhere.exe not found: Program Files (x86) is unknown.' };
  const vswhere = path.win32.join(deps.programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!(await deps.exists(vswhere))) return { problem: `vswhere.exe not found at "${vswhere}". Is Visual Studio installed?` };

  const range = opts.vsVersion && opts.vsVersion !== 'latest' ? opts.vsVersion : undefined;
  const args = ['-latest', ...(range ? ['-version', range] : []), '-products', '*', '-requires', 'Microsoft.Component.MSBuild', '-format', 'json', '-utf8'];

  let entries: VswhereEntry[];
  try {
    const result = await deps.exec(vswhere, args);
    if (result.code !== 0) return { problem: `vswhere failed with exit code ${result.code}: ${result.stderr.trim()}` };
    const parsed: unknown = JSON.parse(result.stdout);
    entries = Array.isArray(parsed) ? (parsed as VswhereEntry[]) : [];
  } catch (e) {
    return { problem: `vswhere output could not be read: ${e instanceof Error ? e.message : String(e)}` };
  }

  const entry = entries.find(e => typeof e.installationPath === 'string');
  if (!entry) {
    return { problem: range ? `No Visual Studio with MSBuild in version range ${range}.` : 'No Visual Studio with MSBuild found.' };
  }

  const installationPath = entry.installationPath!;
  for (const candidate of MSBUILD_CANDIDATES) {
    const msbuildPath = path.win32.join(installationPath, ...candidate);
    if (await deps.exists(msbuildPath)) {
      return {
        instance: {
          installationPath,
          installationVersion: entry.installationVersion ?? '',
          displayName: entry.displayName ?? installationPath,
          msbuildPath,
          devEnvDir: devEnvDirOf(installationPath),
        },
      };
    }
  }
  return { problem: `MSBuild.exe not found under "${installationPath}".` };
}
