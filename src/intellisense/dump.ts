import { DebugPropertiesInput, projectContextArgs } from '../debug/properties';

/** One option set of a project: the sources compiled with it and the compiler command line (without the sources). */
export interface CommandLineRecord {
  files: string[];
  commandLine: string;
  /** The project's default options (Visual Studio's ConfigurationOptions item): what headers are parsed with. */
  projectDefault: boolean;
}

export interface ProjectDump {
  records: CommandLineRecord[];
  /** $(IncludePath) and $(ExternalIncludePath): the compiler, CRT and SDK directories the command line leaves out. */
  systemIncludes: string[];
}

/** Properties that put MSBuild into Visual Studio's design-time mode: nothing is compiled. */
const DESIGN_TIME = {
  DesignTimeBuild: 'true',
  BuildingInsideVisualStudio: 'true',
  SkipCompilerExecution: 'true',
  ProvideCommandLineArgs: 'true',
};

/** MSBuild arguments that print a project's IntelliSense command lines (resources/vssln-intellisense.targets). */
export function intellisenseArgs(input: DebugPropertiesInput): string[] {
  return [input.projectPath, '-t:VsslnIntelliSense', '-nologo', '-v:minimal', ...projectContextArgs(input, DESIGN_TIME)];
}

const LINE = /^\s*VSSLN\|(CL|IncludePath|ExternalIncludePath)\|(.*?)\s*$/;

function list(value: string): string[] {
  return value.split(';').map(v => v.trim()).filter(Boolean);
}

/** Reads the output of -t:VsslnIntelliSense; undefined when MSBuild printed none of our lines (it failed). */
export function parseDump(output: string): ProjectDump | undefined {
  const records: CommandLineRecord[] = [];
  const includes: string[] = [];
  let found = false;
  for (const line of output.split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (!m) continue;
    found = true;
    const [, kind, rest] = m;
    if (kind !== 'CL') {
      includes.push(...list(rest));
      continue;
    }
    // <ConfigurationOptions>|<files>|<command line>; the command line itself may contain "|".
    const first = rest.indexOf('|');
    const second = rest.indexOf('|', first + 1);
    if (first < 0 || second < 0) continue;
    const commandLine = rest.slice(second + 1);
    // The standard library modules (std.ixx) are scanned for every project; they are not its files.
    if (/(^|\s)[/-]scanModules(\s|$)/.test(commandLine)) continue;
    records.push({ files: list(rest.slice(first + 1, second)), commandLine, projectDefault: rest.slice(0, first) === 'true' });
  }
  if (!found) return undefined;
  const seen = new Set<string>();
  const systemIncludes = includes.filter(d => !seen.has(d.toLowerCase()) && seen.add(d.toLowerCase()));
  return { records, systemIncludes };
}
