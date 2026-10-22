import { Env, envLookup, setVariable, withVariables } from '../util/env';

/**
 * Splits a command line the way a program built with the MSVC runtime (2008 and later) receives argv: whitespace
 * separates arguments, quotes group them, 2n backslashes before a quote give n backslashes, 2n+1 give n backslashes
 * and a literal quote, and "" inside quotes is a literal quote that stays in quotes. CommandLineToArgvW differs in
 * the last rule ("a""b c" is a"b c here, a"b and c there); this follows the runtime, which C++ programs use.
 */
export function splitCommandLine(line: string): string[] {
  const args: string[] = [];
  let current = '';
  let inArgument = false;
  let inQuotes = false;
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if ((c === ' ' || c === '\t') && !inQuotes) {
      if (inArgument) args.push(current);
      current = '';
      inArgument = false;
      i++;
      continue;
    }
    inArgument = true;
    if (c === '\\') {
      let n = 0;
      while (line[i + n] === '\\') n++;
      if (line[i + n] === '"') {
        current += '\\'.repeat(Math.floor(n / 2));
        if (n % 2 === 1) {
          current += '"';
          i += n + 1;
        } else {
          i += n;
        }
      } else {
        current += '\\'.repeat(n);
        i += n;
      }
      continue;
    }
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 2;
        continue;
      }
      inQuotes = !inQuotes;
      i++;
      continue;
    }
    current += c;
    i++;
  }
  if (inArgument) args.push(current);
  return args;
}

/**
 * Joins arguments into one command line that splitCommandLine (and the MSVC runtime) reads back unchanged: an argument
 * is quoted when it is empty or has whitespace or quotes; inside quotes, backslashes before a quote or the closing
 * quote are doubled and quotes are escaped.
 */
export function joinCommandLine(args: string[]): string {
  return args
    .map(arg => {
      if (arg !== '' && !/[\s"]/.test(arg)) return arg;
      let out = '"';
      let backslashes = 0;
      for (const c of arg) {
        if (c === '\\') {
          backslashes++;
          continue;
        }
        if (c === '"') {
          out += '\\'.repeat(backslashes * 2 + 1) + '"';
        } else {
          out += '\\'.repeat(backslashes) + c;
        }
        backslashes = 0;
      }
      return `${out}${'\\'.repeat(backslashes * 2)}"`;
    })
    .join(' ');
}

/**
 * Expands %NAME% like Windows' ExpandEnvironmentStrings, which Visual Studio uses for the debugger environment:
 * names may contain spaces, and when a name is unknown its closing % is kept to open the next reference.
 */
export function expandPercent(value: string, env: Env): string {
  let out = '';
  let i = 0;
  while (i < value.length) {
    if (value[i] !== '%') {
      out += value[i++];
      continue;
    }
    const close = value.indexOf('%', i + 1);
    if (close < 0) {
      out += value.slice(i);
      break;
    }
    const name = value.slice(i + 1, close);
    const known = name ? envLookup(env, name) : undefined;
    if (known !== undefined) {
      out += known;
      i = close + 1;
    } else {
      out += `%${name}`;
      i = close;
    }
  }
  return out;
}

/** Applies NAME=value lines in order: each value sees the inherited variables and the lines before it. */
export function applyEnvironmentLines(lines: string[], base: Env): Record<string, string> {
  const result: Env = {};
  for (const line of lines) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim();
    if (!name) continue;
    setVariable(result, name, expandPercent(line.slice(eq + 1), withVariables(base, result)));
  }
  return result as Record<string, string>;
}
