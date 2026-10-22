import * as path from 'path';

/**
 * An MSBuild diagnostic line: "<origin> : [subcategory] [fatal] error|warning [CODE] : <text> [<project>]", e.g.
 * "C:\a\x.cpp(4,1): error C1189: …", "LINK : fatal error LNK1104: …", "cl : command line error D8016: …", "EXEC : error : …".
 * Groups: 1 origin, 2 severity, 3 code, 4 message, 5 project.
 */
export const DIAGNOSTIC = /^(.*?)\s*:\s*(?:[A-Za-z][A-Za-z ]*?\s)?(?:fatal\s+)?(error|warning)(?:\s+([A-Za-z]+\d+))?\s*:\s*(.*?)(?:\s+\[([^\]]+)\])?$/;

// MSBuild positions: (line), (line-line2), (line,col), (line,col-col2), (line,col,line2,col2).
const POSITION = /^(.*)\((\d+)(?:-(\d+))?(?:,(\d+)(?:-(\d+))?)?(?:,(\d+),(\d+))?\)$/;

export interface DiagnosticDetails {
  /** Where Problems shows it: the source file, else the project, else the solution. */
  file?: string;
  /** 1-based, as MSBuild prints them. */
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  severity: 'error' | 'warning';
  code?: string;
  message: string;
}

function numbers(...values: (string | undefined)[]): (number | undefined)[] {
  return values.map(v => (v === undefined ? undefined : Number(v)));
}

/**
 * Splits a diagnostic line (without the "N>" prefix) into what the Problems panel needs. `solutionPath` is the home of
 * diagnostics that name no project, and the base of relative paths that have none.
 */
export function diagnosticDetails(text: string, solutionPath?: string): DiagnosticDetails | undefined {
  const m = DIAGNOSTIC.exec(text.trim());
  if (!m) return undefined;
  const [, origin, severity, code, message, project] = m;
  const base = { severity: severity as 'error' | 'warning', ...(code ? { code } : {}), message };
  const owner = project ?? solutionPath;

  const position = POSITION.exec(origin);
  if (position) {
    const [, source, l, l2, c, c2, rangeLine, rangeColumn] = position;
    const [line, lineTo, column, columnTo, endL, endC] = numbers(l, l2, c, c2, rangeLine, rangeColumn);
    const file = path.win32.isAbsolute(source) || !owner ? source : path.win32.resolve(path.win32.dirname(owner), source);
    const endLine = endL ?? lineTo ?? (columnTo !== undefined ? line : undefined);
    const endColumn = endC ?? columnTo;
    return {
      file,
      line,
      ...(column !== undefined ? { column } : {}),
      ...(endLine !== undefined ? { endLine } : {}),
      ...(endColumn !== undefined ? { endColumn } : {}),
      ...base,
    };
  }
  if (owner) return { file: owner, ...base };
  return path.win32.isAbsolute(origin) ? { file: origin, ...base } : base;
}

export interface Range0 {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

/**
 * The 0-based range for VS Code. A column alone gives an empty range, which VS Code widens to the word there;
 * a line alone marks the whole line; no position marks the start of the file.
 */
export function diagnosticRange(d: DiagnosticDetails): Range0 {
  if (d.line === undefined) return { startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 };
  const startLine = d.line - 1;
  const startColumn = d.column !== undefined ? d.column - 1 : 0;
  const endLine = (d.endLine ?? d.line) - 1;
  if (d.endColumn !== undefined) return { startLine, startColumn, endLine, endColumn: d.endColumn - 1 };
  if (d.column !== undefined && d.endLine === undefined) return { startLine, startColumn, endLine: startLine, endColumn: startColumn };
  return { startLine, startColumn, endLine, endColumn: Number.MAX_SAFE_INTEGER };
}

/**
 * Collects a build's diagnostics per file: repeats (a warning in a shared header, once per translation unit) are kept
 * once, and file names that differ only in case are one file, as they are on Windows.
 */
export class ProblemsBuffer {
  private readonly byFile = new Map<string, { file: string; list: DiagnosticDetails[] }>();
  private readonly seen = new Set<string>();

  /** True when the diagnostic is new and has a file. */
  add(d: DiagnosticDetails): boolean {
    if (!d.file) return false;
    const fileKey = path.win32.normalize(d.file).toLowerCase();
    const key = [fileKey, d.line, d.column, d.endLine, d.endColumn, d.severity, d.code, d.message].join('\u0000');
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    const entry = this.byFile.get(fileKey) ?? { file: d.file, list: [] };
    entry.list.push(d);
    this.byFile.set(fileKey, entry);
    return true;
  }

  /** Each file (first spelling seen) with its diagnostics. */
  *files(): IterableIterator<[string, DiagnosticDetails[]]> {
    for (const { file, list } of this.byFile.values()) yield [file, list];
  }

  clear(): void {
    this.byFile.clear();
    this.seen.clear();
  }
}
