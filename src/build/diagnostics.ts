import * as path from 'path';

/**
 * An MSBuild diagnostic line: "<origin> : [subcategory] [fatal] error|warning [CODE] : <text> [<project>]", e.g.
 * "C:\a\x.cpp(4,1): error C1189: …", "LINK : fatal error LNK1104: …", "cl : command line error D8016: …", "EXEC : error : …".
 * Groups: 1 origin, 2 severity, 3 code, 4 message, 5 project.
 */
export const DIAGNOSTIC = /^(.*?)\s*:\s*(?:[A-Za-z][A-Za-z ]*?\s)?(?:fatal\s+)?(error|warning)(?:\s+([A-Za-z]+\d+))?\s*:\s*(.*?)(?:\s+\[([^\]]+)\])?$/;

const POSITION = /^(.*)\((\d+)(?:,(\d+))?(?:,\d+,\d+)?\)$/;

export interface DiagnosticDetails {
  /** Where Problems shows it: the source file, or the project when the tool gives no position. */
  file?: string;
  line?: number;
  column?: number;
  severity: 'error' | 'warning';
  code?: string;
  message: string;
}

/** Splits a diagnostic line (without the "N>" prefix) into what the Problems panel needs. */
export function diagnosticDetails(text: string): DiagnosticDetails | undefined {
  const m = DIAGNOSTIC.exec(text.trim());
  if (!m) return undefined;
  const [, origin, severity, code, message, project] = m;
  const base = { severity: severity as 'error' | 'warning', ...(code ? { code } : {}), message };

  const position = POSITION.exec(origin);
  if (position) {
    const [, source, line, column] = position;
    const file = path.win32.isAbsolute(source) || !project ? source : path.win32.resolve(path.win32.dirname(project), source);
    return { file, line: Number(line), ...(column ? { column: Number(column) } : {}), ...base };
  }
  if (project) return { file: project, ...base };
  return path.win32.isAbsolute(origin) ? { file: origin, ...base } : base;
}
