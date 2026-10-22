import * as path from 'path';

export type BuildEvent =
  | { kind: 'projectStarted'; path: string }
  | { kind: 'projectFinished'; path: string; failed: boolean }
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
const DIAGNOSTIC = /^(.*?)\s*:\s*(error|warning)\s+([A-Za-z]+\d+)\s*:\s*(.*?)(?:\s+\[([^\]]+)\])?$/;
// Only these targets are real work; references also call GetTargetPath and the like.
const WORK_TARGETS = /^(default targets|(Build|Rebuild|Clean) target\(s\))$/;

function isProject(p: string): boolean {
  return /\.vcxproj$/i.test(p);
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
      return { events: isProject(projectPath) && WORK_TARGETS.test(targets) ? [{ kind: 'projectStarted', path: projectPath }] : [] };
    }

    const finished = FINISHED.exec(line);
    if (finished) {
      const [, projectPath, targets, failed] = finished;
      if (!isProject(projectPath) || !WORK_TARGETS.test(targets)) return { events: [] };
      const name = path.win32.basename(projectPath).replace(/\.vcxproj$/i, '');
      return {
        events: [{ kind: 'projectFinished', path: projectPath, failed: failed !== undefined }],
        display: `${name}: ${failed ? 'FAILED' : 'succeeded'}`,
      };
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
