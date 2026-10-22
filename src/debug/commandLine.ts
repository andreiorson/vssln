/**
 * Splits a command line the way Windows programs receive it (CommandLineToArgvW / the MSVC runtime):
 * whitespace separates arguments, quotes group them, 2n backslashes before a quote give n backslashes,
 * 2n+1 give n backslashes and a literal quote, and "" inside quotes is a literal quote.
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

function lookup(env: Record<string, string | undefined>, name: string): string | undefined {
  if (env[name] !== undefined) return env[name];
  const key = Object.keys(env).find(k => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

/** Expands %NAME% the way Visual Studio does for the debugger environment; unknown names stay as they are. */
export function expandPercent(value: string, env: Record<string, string | undefined>): string {
  return value.replace(/%([^%=\s]+)%/g, (whole, name: string) => lookup(env, name) ?? whole);
}

/** Applies NAME=value lines in order: each value sees the inherited variables and the lines before it. */
export function applyEnvironmentLines(lines: string[], base: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of lines) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim();
    if (!name) continue;
    result[name] = expandPercent(line.slice(eq + 1), { ...base, ...result });
  }
  return result;
}
