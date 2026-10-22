/** "default targets" is reported as Build. */
export type WorkTarget = 'Build' | 'Rebuild' | 'Clean';

export type BuildEvent =
  | { kind: 'projectStarted'; path: string; target: WorkTarget }
  | { kind: 'projectFinished'; path: string; target: WorkTarget; failed: boolean }
  | { kind: 'diagnostic'; severity: 'error' | 'warning'; projectPath?: string; text: string };

export interface ParsedLine {
  events: BuildEvent[];
  /** What the build terminal shows for this line, roughly Visual Studio's "minimal" output; undefined hides it. */
  display?: string;
}

// MSBuild prefixes every line with the id of the project instance that wrote it: "6>" or "5:2>".
const PREFIX = /^\s*\d+(?::\d+)?>/;
// The targets part itself contains parentheses: "(Rebuild target(s))".
const STARTED = /Project "[^"]+" \(\d+(?::\d+)?\) is building "([^"]+)" \(\d+(?::\d+)?\) on node \d+ \((.*?)\)\.$/;
const FINISHED = /^Done Building Project "([^"]+)" \((.*?)\)( -- FAILED)?\.$/;
// "<origin> : [subcategory] [fatal] error|warning [CODE] : <text> [<project>]", e.g. "LINK : fatal error LNK1104: …",
// "cl : command line error D8016: …", "EXEC : error : …".
const DIAGNOSTIC = /^(.*?)\s*:\s*(?:[A-Za-z][A-Za-z ]*?\s)?(?:fatal\s+)?(error|warning)(?:\s+([A-Za-z]+\d+))?\s*:\s*(.*?)(?:\s+\[([^\]]+)\])?$/;
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

  push(raw: string): ParsedLine {
    const line = raw.replace(PREFIX, '').trim();
    if (this.inSummary) return { events: [], display: line === '' ? undefined : line };

    if (line === 'Build succeeded.' || line === 'Build FAILED.') {
      this.inSummary = true;
      return { events: [], display: line };
    }

    const started = STARTED.exec(line);
    if (started) {
      const [, projectPath, targets] = started;
      const target = workTarget(targets);
      return { events: isProject(projectPath) && target ? [{ kind: 'projectStarted', path: projectPath, target }] : [] };
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
        display: line,
      };
    }

    return { events: [], display: line.includes(' -> ') ? line : undefined };
  }
}
