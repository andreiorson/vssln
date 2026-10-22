import { DIAGNOSTIC } from './diagnostics';

/** "default targets" is reported as Build. */
export type WorkTarget = 'Build' | 'Rebuild' | 'Clean';

export type BuildEvent =
  | { kind: 'projectStarted'; path: string; target: WorkTarget }
  | { kind: 'projectFinished'; path: string; target: WorkTarget; failed: boolean }
  | { kind: 'diagnostic'; severity: 'error' | 'warning'; projectPath?: string; text: string };

export interface ParsedLine {
  events: BuildEvent[];
  /** What the build output shows for this line, as Visual Studio's "minimal" output does; undefined hides it. */
  display?: string;
}

export interface OutputOptions {
  /** "Release x64" for a project's header line; undefined leaves the configuration out. */
  configurationOf?: (projectPath: string) => string | undefined;
  /** Whether a target is the work of this build (a Rebuild also calls Clean on references, which is not). */
  counts?: (target: WorkTarget) => boolean;
}

// MSBuild prefixes the first line of a block with the id of the project instance that wrote it: "6>" or "5:2>".
const PREFIX = /^\s*(\d+)(?::\d+)?>/;
// The targets part itself contains parentheses: "(Rebuild target(s))".
const STARTED = /Project "[^"]+" \(\d+(?::\d+)?\) is building "([^"]+)" \((\d+)(?::\d+)?\) on node \d+ \((.*?)\)\.$/;
const HEADERS: Record<WorkTarget, string> = { Build: 'Build started', Rebuild: 'Rebuild All started', Clean: 'Clean started' };
/** MSBuild's own bookkeeping, which Visual Studio's minimal output does not show either. */
const HIDDEN = [
  // Target names ("ClCompile:").
  /^[A-Za-z_][\w.]*:$/,
  // Tool command lines ("C:\Program Files\...\CL.exe /c ...") and the object files echoed after link and lib.
  /^(?:"[^"]*\.exe"|[A-Za-z]:\\.*?\.exe|[\w.-]+\.exe)(?:\s|$)/i,
  /^[^\s"<>|]+\.(?:obj|lib|res)$/i,
  // The solution's own start line, and the batch wrapper Visual Studio puts around build events.
  /^Project ".*" on node \d+ \(.*\)\.$/,
  /^(?:setlocal|endlocal\b.*|exit \/b %1|if %errorlevel% neq 0 goto :\w+|:(?:VCEnd|cmEnd|cmErrorLevel|cmDone))$/i,
  /^(?:Deleting file|Touching |Creating "|Creating directory |Copying file |Skipping target |All outputs are up-to-date\.|Structured output is enabled|Reading library manifest file |Adding module source |Building solution configuration |The project ".*" is not selected for building|Build started \d)/,
];
const FINISHED = /^Done Building Project "([^"]+)" \((.*?)\)( -- FAILED)?\.$/;
// Only these targets are real work; references also call GetTargetPath and the like.
const WORK_TARGETS = /^(default targets|(Build|Rebuild|Clean) target\(s\))$/;

function isProject(p: string): boolean {
  return /\.vcxproj$/i.test(p);
}

function workTarget(targets: string): WorkTarget | undefined {
  const m = WORK_TARGETS.exec(targets);
  if (!m) return undefined;
  return (m[2] as WorkTarget | undefined) ?? 'Build';
}

/** Reads MSBuild "normal" console output line by line (English messages: the build runs with VSLANG=1033). */
export class OutputParser {
  private inSummary = false;
  /** Visual Studio-style project numbers by MSBuild instance id, in the order projects start work. */
  private readonly numbers = new Map<string, number>();
  private readonly numbersByPath = new Map<string, number>();
  /** The instance whose block the current line belongs to: lines after the prefixed one carry no prefix. */
  private current?: string;

  constructor(private readonly options: OutputOptions = {}) {}

  /** The number a project's lines carry, once it started work. */
  numberOf(projectPath: string): number | undefined {
    return this.numbersByPath.get(projectPath.toLowerCase());
  }

  private shown(line: string): string | undefined {
    if (line === '' || HIDDEN.some(re => re.test(line))) return undefined;
    const n = this.current !== undefined ? this.numbers.get(this.current) : undefined;
    return n === undefined ? line : `${n}>${line}`;
  }

  push(raw: string): ParsedLine {
    const prefix = PREFIX.exec(raw);
    if (prefix) this.current = prefix[1];
    const line = raw.replace(PREFIX, '').trim();
    if (this.inSummary) return { events: [], display: line === '' ? undefined : line };

    if (line === 'Build succeeded.' || line === 'Build FAILED.') {
      this.inSummary = true;
      return { events: [], display: line };
    }

    const started = STARTED.exec(line);
    if (started) {
      const [, projectPath, id, targets] = started;
      const target = workTarget(targets);
      if (!isProject(projectPath) || !target) return { events: [] };
      const events: BuildEvent[] = [{ kind: 'projectStarted', path: projectPath, target }];
      if (this.numbers.has(id) || this.options.counts?.(target) === false) return { events };
      const n = this.numbers.size + 1;
      this.numbers.set(id, n);
      this.numbersByPath.set(projectPath.toLowerCase(), n);
      const name = projectPath.replace(/^.*[\\/]/, '').replace(/\.vcxproj$/i, '');
      const configuration = this.options.configurationOf?.(projectPath);
      return { events, display: `${n}>------ ${HEADERS[target]}: Project: ${name}${configuration ? `, Configuration: ${configuration}` : ''} ------` };
    }

    const finished = FINISHED.exec(line);
    if (finished) {
      const [, projectPath, targets, failed] = finished;
      const target = workTarget(targets);
      if (!isProject(projectPath) || !target) return { events: [] };
      // Shown by the session, which knows whether this target is the build's work or a side call.
      return { events: [{ kind: 'projectFinished', path: projectPath, target, failed: failed !== undefined }] };
    }

    const diagnostic = DIAGNOSTIC.exec(line);
    if (diagnostic) {
      const [, , severity, , , projectPath] = diagnostic;
      return {
        events: [{ kind: 'diagnostic', severity: severity as 'error' | 'warning', ...(projectPath ? { projectPath } : {}), text: line }],
        display: this.shown(line),
      };
    }

    return { events: [], display: this.shown(line) };
  }
}
